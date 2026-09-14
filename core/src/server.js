/**
 * Yerel HTTP sunucusu (127.0.0.1).
 *
 * Premiere paneli ve Chrome eklentisi bu sunucuyu kullanir. Sunucu sadece
 * localhost'a baglanir ve her istek bir token ister; boylece tarayicida acik
 * herhangi bir sayfa kurgu baslatamaz.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { loadConfig, saveConfig, sanitize, DEFAULTS } from "./config.js";
import * as agent from "./agent.js";
import { runPipeline, STEP_LABELS } from "./pipeline.js";
import { detectWhisper } from "./transcribe.js";
import { run } from "./ffmpeg.js";

const MAX_EVENTS = 500;

export function tokenPath() {
  return path.join(os.homedir(), ".gelistir", "token");
}

export function ensureToken() {
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // ilk calistirma
  }
  const token = randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

/** Sadece eklenti ve yerel gelistirme kaynaklarina CORS izni. */
export function allowedOrigin(origin) {
  if (!origin || origin === "null") return "*"; // CEP paneli file:// uzerinden gelir
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Istek govdesi cok buyuk"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Gecersiz JSON"));
      }
    });
    req.on("error", reject);
  });
}

class JobRegistry {
  constructor() {
    this.jobs = new Map();
    this.order = [];
  }

  create(payload) {
    const id = String(this.order.length + 1).padStart(4, "0");
    const job = {
      id,
      status: "queued",
      step: null,
      label: null,
      detail: "",
      progress: 0,
      events: [],
      error: null,
      result: null,
      cancelled: false,
      children: new Set(),
      createdAt: new Date().toISOString(),
      ...payload,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return this.order
      .slice(-25)
      .reverse()
      .map((id) => this.public(this.jobs.get(id)));
  }

  public(job) {
    if (!job) return null;
    const { events, children, ...rest } = job;
    return { ...rest, eventCount: events.length };
  }

  push(job, event) {
    job.events.push({ n: job.events.length + 1, t: Date.now(), ...event });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  }
}

export async function createServer({ config = loadConfig(), logger = console } = {}) {
  const token = ensureToken();
  const registry = new JobRegistry();
  const sessions = new Map();
  let liveConfig = config;

  function getSession(id) {
    const session = sessions.get(id);
    if (!session) throw httpError(404, "Ajan oturumu bulunamadi");
    return session;
  }

  /**
   * Ajan turlarini arka planda kosar.
   *
   * Bir tur dakikalar surebilir (whisper, ffmpeg, model dusunme suresi), bu
   * yuzden HTTP istegini bekletmiyoruz: istek hemen doner, panel durumu
   * GET /agent/sessions/:id ile yoklar.
   */
  function runInBackground(session, fn) {
    if (session.running) throw httpError(409, "Oturum mesgul; tur bitene kadar bekle");
    session.running = true;
    session.status = "thinking";
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        session.status = "error";
        session.error = String(err?.message || err);
        logger.error?.(`[ajan ${session.id}] ${session.error}`);
      })
      .finally(() => {
        session.running = false;
      });
  }

  async function startJob(job) {
    job.status = "running";
    try {
      const jobConfig = { ...liveConfig, ...sanitize(job.overrides || {}) };
      job.result = await runPipeline({
        input: job.input,
        outDir: job.outDir,
        mode: job.mode,
        srtPath: job.srtPath,
        state: job.state,
        apiKey: job.apiKey || "",
        config: jobConfig,
        onChild: (child) => {
          job.children.add(child);
          child.on("close", () => job.children.delete(child));
        },
        onEvent: (e) => {
          if (job.cancelled) throw new Error("Kullanici iptal etti");
          job.step = e.step;
          job.label = e.label;
          job.detail = e.detail;
          if (e.progress !== null && e.progress !== undefined) job.progress = e.progress;
          registry.push(job, e);
        },
      });
      job.status = "done";
      job.progress = 1;
      registry.push(job, { step: "done", label: "Bitti", detail: job.result.files?.video || "" });
    } catch (err) {
      job.status = job.cancelled ? "cancelled" : "error";
      job.error = String(err.message || err);
      registry.push(job, { step: "error", label: "Hata", detail: job.error });
      logger.error?.(`[job ${job.id}] ${job.error}`);
    }
  }

  const routes = {
    "GET /ping": async () => ({ ok: true, name: "gelistir-core" }),

    "GET /health": async () => {
      const has = async (bin, args) => {
        try {
          await run(bin, args);
          return true;
        } catch {
          return false;
        }
      };
      const [ffmpeg, ffprobe] = await Promise.all([
        has(liveConfig.ffmpeg, ["-version"]),
        has(liveConfig.ffprobe, ["-version"]),
      ]);
      const whisper = await detectWhisper(liveConfig.whisper);
      return {
        ok: true,
        name: "gelistir-core",
        steps: STEP_LABELS,
        ffmpeg,
        ffprobe,
        whisper: whisper || null,
        hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
        model: liveConfig.model,
      };
    },

    "GET /config": async () => ({ config: liveConfig, defaults: DEFAULTS }),

    "POST /config": async (req) => {
      const body = await readBody(req);
      const merged = saveConfig(body.config || body);
      liveConfig = loadConfig();
      return { config: liveConfig, saved: merged };
    },

    "GET /jobs": async () => ({ jobs: registry.list() }),

    "POST /jobs": async (req) => {
      const body = await readBody(req);
      const input = String(body.input || "");
      if (!input) throw httpError(400, "input zorunlu");
      if (!fs.existsSync(input)) throw httpError(400, `Dosya bulunamadi: ${input}`);
      const mode = ["full", "plan", "deliver", "deliver-source"].includes(body.mode)
        ? body.mode
        : "full";

      let state = body.state || null;
      if (!state && body.stateFile && fs.existsSync(body.stateFile)) {
        state = JSON.parse(fs.readFileSync(body.stateFile, "utf8"));
      }
      if ((mode === "deliver" || mode === "deliver-source") && !state) {
        throw httpError(400, `${mode} modu icin plan asamasindan gelen state/stateFile gerekli`);
      }

      const outDir = String(
        body.outDir ||
          path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-youtube`),
      );

      const job = registry.create({
        input,
        outDir,
        mode,
        srtPath: body.srtPath ? String(body.srtPath) : null,
        state,
        apiKey: body.apiKey ? String(body.apiKey) : "",
        overrides: body.overrides || {},
      });
      // Bilerek beklenmiyor: is arka planda kosar, durum /jobs/:id ile okunur.
      startJob(job);
      return { job: registry.public(job) };
    },

    "GET /jobs/:id": async (req, params) => {
      const job = registry.get(params.id);
      if (!job) throw httpError(404, "is bulunamadi");
      return { job: registry.public(job) };
    },

    "GET /jobs/:id/events": async (req, params, query) => {
      const job = registry.get(params.id);
      if (!job) throw httpError(404, "is bulunamadi");
      const since = Number(query.get("since") || 0);
      return {
        status: job.status,
        events: job.events.filter((e) => e.n > since),
        last: job.events.length,
      };
    },

    "POST /jobs/:id/cancel": async (req, params) => {
      const job = registry.get(params.id);
      if (!job) throw httpError(404, "is bulunamadi");
      job.cancelled = true;
      for (const child of job.children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // zaten bitmis
        }
      }
      return { job: registry.public(job) };
    },

    /** Chrome eklentisi YouTube Studio alanlarini bununla doldurur. */
    "GET /latest/metadata": async () => {
      for (const id of [...registry.order].reverse()) {
        const job = registry.get(id);
        if (job?.status === "done" && job.result?.metadata) {
          return {
            jobId: id,
            bundleDir: job.result.bundleDir,
            metadata: job.result.metadata,
          };
        }
      }
      throw httpError(404, "Tamamlanmis is yok");
    },

    // ---------------------------------------------------------- ajan modu

    "POST /agent/sessions": async (req) => {
      const body = await readBody(req);
      let session;
      try {
        session = agent.createSession({
          config: { ...liveConfig, ...sanitize(body.overrides || {}) },
          apiKey: body.apiKey ? String(body.apiKey) : "",
        });
      } catch (err) {
        // Anahtar eksikligi sunucu hatasi degil, yapilandirma hatasi.
        throw httpError(400, err.message);
      }
      sessions.set(session.id, session);
      return { session: agent.sessionView(session), tools: agent.apiTools().map((t) => t.name) };
    },

    "GET /agent/sessions": async () => ({
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        status: s.status,
        createdAt: s.createdAt,
        messageCount: s.messages.length,
      })),
    }),

    "GET /agent/sessions/:id": async (req, params) => ({
      session: agent.sessionView(getSession(params.id)),
    }),

    "POST /agent/sessions/:id/message": async (req, params) => {
      const session = getSession(params.id);
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) throw httpError(400, "text zorunlu");
      runInBackground(session, () => agent.sendMessage(session, text));
      return { session: agent.sessionView(session) };
    },

    "POST /agent/sessions/:id/tool-results": async (req, params) => {
      const session = getSession(params.id);
      const body = await readBody(req, 4_000_000);
      if (!Array.isArray(body.results)) throw httpError(400, "results dizisi zorunlu");
      runInBackground(session, () => agent.submitToolResults(session, body.results));
      return { session: agent.sessionView(session) };
    },

    "POST /agent/sessions/:id/approve": async (req, params) => {
      const session = getSession(params.id);
      const body = await readBody(req);
      if (!body.decisions || typeof body.decisions !== "object") {
        throw httpError(400, "decisions nesnesi zorunlu");
      }
      runInBackground(session, () => agent.resolveApprovals(session, body.decisions));
      return { session: agent.sessionView(session) };
    },

    "GET /jobs/:id/metadata": async (req, params) => {
      const job = registry.get(params.id);
      if (!job) throw httpError(404, "is bulunamadi");
      if (!job.result?.metadata) throw httpError(409, "is henuz bitmedi");
      return { jobId: job.id, bundleDir: job.result.bundleDir, metadata: job.result.metadata };
    },
  };

  function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  function match(method, pathname) {
    for (const key of Object.keys(routes)) {
      const [routeMethod, routePath] = key.split(" ");
      if (routeMethod !== method) continue;
      const routeParts = routePath.split("/").filter(Boolean);
      const pathParts = pathname.split("/").filter(Boolean);
      if (routeParts.length !== pathParts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < routeParts.length; i++) {
        if (routeParts[i].startsWith(":")) params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        else if (routeParts[i] !== pathParts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: routes[key], params };
    }
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = allowedOrigin(origin);
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      };
      if (allowed) {
        headers["access-control-allow-origin"] = allowed;
        headers["access-control-allow-headers"] = "authorization, content-type";
        headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
      }
      res.writeHead(status, headers);
      res.end(body);
    };

    if (req.method === "OPTIONS") return send(204, {});

    // Host kontrolu: DNS rebinding ile dis sayfalarin sunucuya ulasmasini engeller.
    const host = String(req.headers.host || "").split(":")[0];
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
      return send(403, { error: "Sadece localhost" });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const auth = String(req.headers.authorization || "");
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : url.searchParams.get("token");
    if (url.pathname !== "/ping" && supplied !== token) {
      return send(401, { error: "Token gecersiz. ~/.gelistir/token dosyasindaki degeri kullan." });
    }

    const route = match(req.method, url.pathname);
    if (!route) return send(404, { error: "Bilinmeyen adres" });

    try {
      const payload = await route.handler(req, route.params, url.searchParams);
      send(200, payload);
    } catch (err) {
      send(err.status || 500, { error: String(err.message || err) });
    }
  });

  return { server, token, registry, sessions, config: () => liveConfig };
}

export async function serve({ config = loadConfig(), logger = console } = {}) {
  const { server, token } = await createServer({ config, logger });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  logger.info?.(`gelistir-core dinliyor: http://${config.host}:${config.port}`);
  logger.info?.(`Token: ${token}  (${tokenPath()})`);
  return { server, token };
}
