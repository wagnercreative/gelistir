import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ESM testinde require yok; autostart.js CEP icinde CommonJS gibi kosuyor
// ve child_process'i require ile aliyor, o yuzden birini uretiyoruz.
const nodeRequire = createRequire(import.meta.url);

/**
 * Panelin cekirdegi kendi baslatmasi.
 *
 * autostart.js Premiere'in icinde (CEP) kosuyor ve burada Premiere yok; o
 * yuzden panelin ortamini birebir taklit ediyoruz: window.GelistirNode,
 * require("child_process") ve paylasilan ev dizini. Sonra cekirdegin
 * gercekten ayaga kalktigini HTTP ile dogruluyoruz.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const autostartPath = path.join(repoRoot, "premiere-panel", "client", "js", "autostart.js");

function loadAutostart({ home, nodeApi }) {
  const fakeWindow = { GelistirNode: nodeApi };
  const context = vm.createContext({
    window: fakeWindow,
    require: nodeRequire,
    console,
    process,
  });
  new vm.Script(fs.readFileSync(autostartPath, "utf8")).runInContext(context);
  return fakeWindow.GelistirAutostart;
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-autostart-"));
  fs.mkdirSync(path.join(home, ".gelistir"), { recursive: true });
  return home;
}

const nodeApiFor = (home) => ({ fs, os: { homedir: () => home }, path });

test("ayar dosyasi yoksa neden soylenir", () => {
  const home = fakeHome();
  const api = loadAutostart({ home, nodeApi: nodeApiFor(home) });
  assert.equal(api.readConfig(), null);

  const result = api.start();
  assert.equal(result.ok, false);
  assert.match(result.reason, /gelistir kurulum --uygula/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("node erisimi olmayan panelde anlasilir hata verir", () => {
  const api = loadAutostart({ home: "/yok", nodeApi: { fs: null, os: null, path: null } });
  const result = api.start();
  assert.equal(result.ok, false);
  assert.match(result.reason, /enable-nodejs/);
});

test("depo koku yanlissa cekirdek dosyasi bulunamadi der", () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, ".gelistir", "config.json"),
    JSON.stringify({ repoRoot: "/olmayan/depo", nodePath: process.execPath }),
  );
  const api = loadAutostart({ home, nodeApi: nodeApiFor(home) });
  const result = api.start();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Cekirdek dosyasi bulunamadi/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("node yolu gecersizse soyler", () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, ".gelistir", "config.json"),
    JSON.stringify({ repoRoot, nodePath: "/olmayan/node" }),
  );
  const api = loadAutostart({ home, nodeApi: nodeApiFor(home) });
  const result = api.start();
  assert.equal(result.ok, false);
  assert.match(result.reason, /node bulunamadi/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("panel cekirdegi gercekten baslatiyor ve ayaga kalkiyor", async () => {
  const home = fakeHome();
  const port = 18700 + Math.floor(Math.random() * 900);
  fs.writeFileSync(
    path.join(home, ".gelistir", "config.json"),
    JSON.stringify({ repoRoot, nodePath: process.execPath, port }),
  );

  // Cocuk surec ortami miras alir: panel ile cekirdek ayni evi gormeli.
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  let pid = null;
  try {
    const api = loadAutostart({ home, nodeApi: nodeApiFor(home) });
    const result = api.start();
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.pid, "pid dondurulmeli");
    assert.match(result.command, /gelistir\.js serve$/);
    pid = result.pid;

    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/ping`, {
          signal: AbortSignal.timeout(400),
        });
        up = res.ok && (await res.json()).name === "gelistir-core";
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.equal(up, true, "cekirdek ayaga kalkmadi");

    // Panel token'i okuyabiliyor mu? (cekirdek onu ayni eve yaziyor)
    const token = fs.readFileSync(path.join(home, ".gelistir", "token"), "utf8").trim();
    assert.ok(token.length >= 32);

    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(health.status, 200);
  } finally {
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        // zaten olmus
      }
    }
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedProfile !== undefined) process.env.USERPROFILE = savedProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
