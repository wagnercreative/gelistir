import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Token ve ayar dosyalari ev dizinine yazilir; testlerde gecici bir ev kullan.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { createServer, allowedOrigin, ensureToken, tokenPath } = await import("../src/server.js");

test("allowedOrigin sadece eklenti ve localhost kaynaklarina izin verir", () => {
  assert.equal(allowedOrigin(undefined), "*", "CEP paneli Origin gondermez");
  assert.equal(allowedOrigin("null"), "*");
  const ext = `chrome-extension://${"a".repeat(32)}`;
  assert.equal(allowedOrigin(ext), ext);
  assert.equal(allowedOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(allowedOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(allowedOrigin("https://kotu-site.example"), null);
  assert.equal(allowedOrigin("https://studio.youtube.com"), null);
  assert.equal(allowedOrigin("chrome-extension://kisa"), null);
});

test("ensureToken kalici ve yeterince uzun token uretir", () => {
  const a = ensureToken();
  const b = ensureToken();
  assert.equal(a, b, "token her cagrida degismez");
  assert.ok(a.length >= 32);
  assert.ok(fs.existsSync(tokenPath()));
});

async function withServer(fn) {
  const { server, token } = await createServer({
    config: { ...(await import("../src/config.js")).DEFAULTS, port: 0, host: "127.0.0.1" },
    logger: { error: () => {}, info: () => {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, token });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("/ping token istemez", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "gelistir-core");
  });
});

test("token olmadan diger adresler 401 doner", async () => {
  await withServer(async ({ base }) => {
    for (const url of ["/health", "/jobs", "/config", "/latest/metadata"]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 401, url);
    }
  });
});

test("yanlis token 401, dogru token 200", async () => {
  await withServer(async ({ base, token }) => {
    const bad = await fetch(`${base}/jobs`, { headers: { authorization: "Bearer yanlis" } });
    assert.equal(bad.status, 401);

    const good = await fetch(`${base}/jobs`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(good.status, 200);
    assert.deepEqual((await good.json()).jobs, []);
  });
});

test("token sorgu parametresiyle de kabul edilir", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/jobs?token=${token}`);
    assert.equal(res.status, 200);
  });
});

test("dis kaynaga CORS basligi verilmez", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/jobs`, {
      headers: { authorization: `Bearer ${token}`, origin: "https://kotu-site.example" },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("eklenti kaynagina CORS basligi verilir", async () => {
  const ext = `chrome-extension://${"b".repeat(32)}`;
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/jobs`, {
      headers: { authorization: `Bearer ${token}`, origin: ext },
    });
    assert.equal(res.headers.get("access-control-allow-origin"), ext);
  });
});

test("localhost olmayan Host basligi reddedilir (DNS rebinding)", async () => {
  // fetch() Host basligini URL'den uretir; ham istek gerekiyor.
  await withServer(async ({ base, token }) => {
    const port = Number(new URL(base).port);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/jobs",
          method: "GET",
          headers: { authorization: `Bearer ${token}`, host: `saldirgan.example:${port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test("bilinmeyen adres 404 doner", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/olmayan/adres`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });
});

test("is olusturma girdi dogrulamasi yapar", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const noInput = await fetch(`${base}/jobs`, { method: "POST", headers, body: "{}" });
    assert.equal(noInput.status, 400);
    assert.match((await noInput.json()).error, /input zorunlu/);

    const missing = await fetch(`${base}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: "/olmayan/dosya.mp4" }),
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /bulunamadi/);

    const self = new URL(import.meta.url).pathname;
    const noState = await fetch(`${base}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: self, mode: "deliver" }),
    });
    assert.equal(noState.status, 400);
    assert.match((await noState.json()).error, /state/);
  });
});

test("tamamlanmis is yoksa /latest/metadata 404 doner", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/latest/metadata`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });
});

test("OPTIONS on istegi 204 doner", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/jobs`, {
      method: "OPTIONS",
      headers: { origin: `chrome-extension://${"c".repeat(32)}` },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  });
});

// ---------------------------------------------------------------- ajan modu

test("ajan oturumu ortam degiskeni olmadan da acilir (ant auth profili olabilir)", async () => {
  // Kimlik bilgisi `ant auth login` profilinden de gelebilir; oturum acilisinda
  // anahtar zorunlu tutulmaz. Eksiklik ilk model isteginde anlasilir mesajla cikar.
  const saved = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    await withServer(async ({ base, token }) => {
      const res = await fetch(`${base}/agent/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).session.status, "idle");
    });
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
  }
});

test("ajan oturumu acilir, listelenir ve okunur", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await fetch(`${base}/agent/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "sk-ant-test-anahtari" }),
    });
    assert.equal(created.status, 200);
    const { session, tools } = await created.json();
    assert.ok(session.id);
    assert.equal(session.status, "idle");
    assert.ok(tools.includes("premiere_get_sequence"));
    assert.ok(tools.includes("build_cut_plan"));
    // Sirlar gorunumde olmamali
    assert.equal(session.apiKey, undefined);
    assert.equal(session.client, undefined);

    const list = await (await fetch(`${base}/agent/sessions`, { headers })).json();
    assert.equal(list.sessions.length, 1);

    const read = await fetch(`${base}/agent/sessions/${session.id}`, { headers });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).session.id, session.id);
  });
});

test("olmayan ajan oturumu 404, bozuk govde 400 doner", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const missing = await fetch(`${base}/agent/sessions/yok/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "selam" }),
    });
    assert.equal(missing.status, 404);

    const created = await (
      await fetch(`${base}/agent/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ apiKey: "sk-ant-test-anahtari" }),
      })
    ).json();

    const empty = await fetch(`${base}/agent/sessions/${created.session.id}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "   " }),
    });
    assert.equal(empty.status, 400);

    const badApprove = await fetch(`${base}/agent/sessions/${created.session.id}/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(badApprove.status, 400);
  });
});

test("ajan uc noktalari token ister", async () => {
  await withServer(async ({ base }) => {
    for (const [method, url] of [
      ["POST", "/agent/sessions"],
      ["GET", "/agent/sessions"],
      ["GET", "/agent/sessions/x"],
      ["POST", "/agent/sessions/x/message"],
    ]) {
      const res = await fetch(base + url, { method });
      assert.equal(res.status, 401, `${method} ${url}`);
    }
  });
});

// ---------------------------------------------------------------- Premiere koprusu

test("kopru baslangicta kapali, yoklama sonrasi acik", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}` };

    const before = await (await fetch(`${base}/host/status`, { headers })).json();
    assert.equal(before.status.connected, false);
    assert.equal(before.status.queued, 0);

    // Panelin yoklamasi: kuyruk bos oldugu icin hemen bos donmeli (wait=0)
    const poll = await (await fetch(`${base}/host/poll?wait=0`, { headers })).json();
    assert.deepEqual(poll.commands, []);
    assert.equal(poll.status.connected, true, "yoklama panel bagli demektir");

    const after = await (await fetch(`${base}/host/status`, { headers })).json();
    assert.equal(after.status.connected, true);
  });
});

test("Premiere araci panel bagli degilse anlasilir hata verir", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/tools/premiere_get_project`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /Premiere paneli bagli degil/);
    assert.match(body.error, /Uzantilar/, "kurulum adimi da soylenmeli");
  });
});

test("arac cagrisi kuyruga giriyor, panelin sonucu geri donuyor", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // Panel bagli olsun
    await fetch(`${base}/host/poll?wait=0`, { headers });

    // Aracı cagir (yanit panelin sonucunu bekleyecek)
    const callPromise = fetch(`${base}/tools/premiere_get_sequence`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: { sequenceName: "Ana" } }),
    });

    // Panel uzun-yoklamayla komutu alir
    const poll = await (await fetch(`${base}/host/poll?wait=5000`, { headers })).json();
    assert.equal(poll.commands.length, 1);
    const command = poll.commands[0];
    assert.equal(command.fn, "gelistirGetSequence");
    assert.deepEqual(command.args, ["Ana", ""]);
    assert.equal(command.label, "premiere_get_sequence");

    // Panel sonucu bildirir
    const done = await (
      await fetch(`${base}/host/results`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          results: [{ id: command.id, content: JSON.stringify({ ok: true, name: "Ana", duration: 40 }) }],
        }),
      })
    ).json();
    assert.equal(done.accepted, 1);

    const res = await callPromise;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tool, "premiere_get_sequence");
    assert.deepEqual(body.result, { ok: true, name: "Ana", duration: 40 });
  });
});

test("panelin bildirdigi hata arac cagrisina 422 olarak doner", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    await fetch(`${base}/host/poll?wait=0`, { headers });

    const callPromise = fetch(`${base}/tools/premiere_get_project`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: {} }),
    });

    const poll = await (await fetch(`${base}/host/poll?wait=5000`, { headers })).json();
    await fetch(`${base}/host/results`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        results: [{
          id: poll.commands[0].id,
          content: JSON.stringify({ ok: false, error: "Acik proje yok" }),
          isError: true,
        }],
      }),
    });

    const res = await callPromise;
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /Acik proje yok/);
  });
});

test("bilinmeyen sonuc id'leri yok sayilir", async () => {
  await withServer(async ({ base, token }) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const res = await fetch(`${base}/host/results`, {
      method: "POST",
      headers,
      body: JSON.stringify({ results: [{ id: "olmayan", content: "{}" }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.ignored, 1);
  });
});

test("/tools listesi araclari yurutucu ve bayraklariyla verir", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/tools`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const { tools, host } = await res.json();

    assert.ok(tools.length >= 17);
    const sequence = tools.find((t) => t.name === "premiere_get_sequence");
    assert.equal(sequence.executor, "host");
    assert.equal(sequence.readOnly, true);
    assert.equal(sequence.approval, false);
    assert.equal(sequence.inputSchema.type, "object");

    const del = tools.find((t) => t.name === "premiere_delete_clip");
    assert.equal(del.approval, true);
    assert.equal(del.readOnly, false);

    assert.equal(tools.find((t) => t.name === "build_cut_plan").executor, "core");
    assert.equal(host.connected, false);
  });
});

test("cekirdek araci Premiere gerektirmeden calisir", async () => {
  await withServer(async ({ base, token }) => {
    // transcript_read: dokum yok, ama panel de gerekmiyor -> arac hatasi
    const res = await fetch(`${base}/tools/transcript_read`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ input: { path: "/v/a.mp4", startSeconds: 0, endSeconds: 10 } }),
    });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /media_transcribe/);
  });
});

test("olmayan arac 404, kopru uc noktalari token ister", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/tools/uydurma_arac`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);

    for (const [method, url] of [
      ["GET", "/host/status"],
      ["GET", "/host/poll?wait=0"],
      ["POST", "/host/results"],
      ["GET", "/tools"],
      ["POST", "/tools/premiere_get_project"],
    ]) {
      const unauth = await fetch(base + url, { method });
      assert.equal(unauth.status, 401, `${method} ${url}`);
    }
  });
});

test("port kullanimdaysa serve anlasilir hata verir", async () => {
  const { serve } = await import("../src/server.js");
  const { DEFAULTS } = await import("../src/config.js");
  const net = await import("node:net");

  // Portu bir baskasi tutsun
  const blocker = net.createServer();
  const port = await new Promise((resolve) => {
    blocker.listen(0, "127.0.0.1", () => resolve(blocker.address().port));
  });

  try {
    await assert.rejects(
      serve({
        config: { ...DEFAULTS, host: "127.0.0.1", port },
        logger: { info: () => {}, error: () => {} },
      }),
      (err) => {
        assert.match(err.message, new RegExp(`Port ${port} kullanimda`));
        assert.match(err.message, /gelistir config port=/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
