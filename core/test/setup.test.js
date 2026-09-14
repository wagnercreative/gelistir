import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cepExtensionsDir,
  debugModeCommands,
  planSetup,
  formatPlan,
  applySetup,
  CSXS_VERSIONS,
  EXTENSION_ID,
} from "../src/setup.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("CEP uzanti dizini platforma gore dogru", () => {
  assert.equal(
    cepExtensionsDir({ platform: "darwin", home: "/Users/ali" }),
    "/Users/ali/Library/Application Support/Adobe/CEP/extensions",
  );
  assert.equal(
    cepExtensionsDir({ platform: "win32", home: "C:\\Users\\ali", env: { APPDATA: "C:\\Users\\ali\\AppData\\Roaming" } }),
    path.join("C:\\Users\\ali\\AppData\\Roaming", "Adobe", "CEP", "extensions"),
  );
});

test("Windows'ta APPDATA yoksa makul bir yol uretilir", () => {
  const dir = cepExtensionsDir({ platform: "win32", home: "C:\\Users\\ali", env: {} });
  assert.match(dir, /AppData/);
  assert.match(dir, /Roaming/);
});

test("PlayerDebugMode komutlari platforma gore uretilir", () => {
  const mac = debugModeCommands("darwin");
  assert.equal(mac.length, CSXS_VERSIONS.length);
  assert.equal(mac[0].command, "defaults");
  assert.deepEqual(mac[0].args, ["write", "com.adobe.CSXS.9", "PlayerDebugMode", "1"]);

  const win = debugModeCommands("win32");
  assert.equal(win.length, CSXS_VERSIONS.length);
  assert.equal(win[0].command, "reg");
  assert.ok(win[0].args.includes("HKCU\\Software\\Adobe\\CSXS.9"));
  assert.ok(win[0].args.includes("/f"), "var olan anahtari sormadan yazmali");

  assert.deepEqual(debugModeCommands("linux"), []);
});

test("plan gercek depo yapisiyla tutarli, uyari uretmez", () => {
  const plan = planSetup({
    platform: "darwin",
    home: "/Users/ali",
    env: {},
    repoRoot,
  });
  assert.equal(plan.panelSource, path.join(repoRoot, "premiere-panel"));
  assert.ok(plan.panelTarget.endsWith(EXTENSION_ID), "klasor adi tam olmali");
  assert.match(plan.mcpEntry, /core\/bin\/gelistir-mcp\.js$/);
  assert.deepEqual(
    plan.warnings.filter((w) => !w.includes("Premiere Pro")),
    [],
    `beklenmeyen uyari: ${plan.warnings}`,
  );
});

test("mcp komutu kullanici kapsamini kullanir", () => {
  // -s user olmadan sunucu yalnizca komutun calistirildigi dizinde gorunur;
  // kullanici video kurgularken baska bir klasorde olacak.
  const plan = planSetup({ platform: "darwin", home: "/Users/ali", env: {}, repoRoot });
  assert.match(plan.mcpCommand, /claude mcp add premiere -s user -- node /);

  const text = formatPlan(plan);
  assert.match(text, /-s user/);
  assert.match(text, /her dizinden gorunur/);
});

test("mcp komutu bosluklu yollarda da gecerli", () => {
  const plan = planSetup({
    platform: "darwin",
    home: "/Users/ali",
    env: {},
    repoRoot: "/Users/ali/Belgelerim/gelistir projesi",
  });
  assert.match(plan.mcpCommand, /^claude mcp add premiere -s user -- node "/);
  assert.ok(plan.mcpCommand.includes("gelistir projesi"));
  // Alintili oldugu icin kabuk yolu bolmez
  assert.equal((plan.mcpCommand.match(/"/g) || []).length, 2);
});

test("panel yoksa uyari verir", () => {
  const plan = planSetup({
    platform: "darwin",
    home: "/Users/ali",
    env: {},
    repoRoot: "/olmayan/depo",
  });
  assert.ok(plan.warnings.some((w) => w.includes("Panel klasoru bulunamadi")));
  assert.ok(plan.warnings.some((w) => w.includes("MCP sunucusu bulunamadi")));
});

test("Windows'ta kopyalama, macOS'ta baglanti varsayilan", () => {
  const win = planSetup({ platform: "win32", home: "C:\\U", env: {}, repoRoot });
  assert.equal(win.link, false, "Windows'ta symlink yonetici ister");

  const mac = planSetup({ platform: "darwin", home: "/Users/ali", env: {}, repoRoot });
  assert.equal(mac.link, true);

  const forced = planSetup({ platform: "darwin", home: "/U", env: {}, repoRoot, copy: true });
  assert.equal(forced.link, false);
});

test("formatPlan uc adimi ve mcp komutunu yazar", () => {
  const text = formatPlan(planSetup({ platform: "darwin", home: "/U", env: {}, repoRoot }));
  assert.match(text, /1\. Panel klasoru/);
  assert.match(text, /2\. PlayerDebugMode/);
  assert.match(text, /3\. Claude Code'a MCP sunucusunu ekle/);
  assert.match(text, /claude mcp add premiere/);
  assert.match(text, /com\.adobe\.CSXS\.11/);
});

// ---------------------------------------------------------------- uygulama

test("applySetup paneli baglar ve komutlari kosturur", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-kur-"));
  const plan = planSetup({ platform: "darwin", home, env: {}, repoRoot });

  const ran = [];
  const { done, failed } = await applySetup(plan, {
    run: async (command, args) => {
      ran.push([command, ...args].join(" "));
    },
  });

  assert.deepEqual(failed, []);
  assert.equal(ran.length, CSXS_VERSIONS.length);
  assert.ok(ran[0].startsWith("defaults write com.adobe.CSXS.9"));

  // Baglanti gercekten kuruldu ve panel manifestine ulasiliyor
  assert.ok(fs.lstatSync(plan.panelTarget).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(plan.panelTarget, "CSXS", "manifest.xml")));
  assert.ok(fs.existsSync(path.join(plan.panelTarget, "host", "gelistir.jsx")));
  assert.ok(done.some((d) => d.includes("panel baglandi")));

  fs.rmSync(home, { recursive: true, force: true });
});

test("applySetup kopyalama modunda dosyalari gercekten kopyalar", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-kur-kopya-"));
  const plan = planSetup({ platform: "darwin", home, env: {}, repoRoot, copy: true });

  await applySetup(plan, { run: async () => {} });

  assert.ok(!fs.lstatSync(plan.panelTarget).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(plan.panelTarget, "client", "js", "executor.js")));

  fs.rmSync(home, { recursive: true, force: true });
});

test("mevcut baglanti yenilenir", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-kur-yenile-"));
  const first = planSetup({ platform: "darwin", home, env: {}, repoRoot });
  await applySetup(first, { run: async () => {} });

  const second = planSetup({ platform: "darwin", home, env: {}, repoRoot });
  assert.equal(second.existing, "symlink");
  const { failed } = await applySetup(second, { run: async () => {} });
  assert.deepEqual(failed, []);
  assert.ok(fs.existsSync(path.join(second.panelTarget, "CSXS", "manifest.xml")));

  fs.rmSync(home, { recursive: true, force: true });
});

test("hedefte gercek klasor varsa uzerine YAZILMAZ", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-kur-klasor-"));
  const plan = planSetup({ platform: "darwin", home, env: {}, repoRoot });
  fs.mkdirSync(plan.panelTarget, { recursive: true });
  fs.writeFileSync(path.join(plan.panelTarget, "benim-dosyam.txt"), "elle yaptigim degisiklik");

  const reread = planSetup({ platform: "darwin", home, env: {}, repoRoot });
  assert.equal(reread.existing, "directory");
  const { failed } = await applySetup(reread, { run: async () => {} });

  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /zaten bir klasor/);
  assert.equal(
    fs.readFileSync(path.join(plan.panelTarget, "benim-dosyam.txt"), "utf8"),
    "elle yaptigim degisiklik",
    "kullanicinin dosyasi korunmali",
  );

  fs.rmSync(home, { recursive: true, force: true });
});

test("tek bir PlayerDebugMode hatasi kurulumu bozmaz", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-kur-kismi-"));
  const plan = planSetup({ platform: "darwin", home, env: {}, repoRoot });

  const { done, failed } = await applySetup(plan, {
    run: async (command, args) => {
      // Her Premiere surumu her CSXS anahtarini kullanmaz.
      if (args.includes("com.adobe.CSXS.12")) throw new Error("domain yok");
    },
  });

  assert.equal(failed.length, 1);
  assert.match(failed[0].step, /CSXS\.12/);
  assert.ok(done.some((d) => d.includes("panel baglandi")), "panel yine kuruldu");
  assert.ok(fs.existsSync(plan.panelTarget));

  fs.rmSync(home, { recursive: true, force: true });
});
