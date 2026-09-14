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
