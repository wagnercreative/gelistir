import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_SPECS, toolSpec } from "../src/agent.js";

/**
 * Cekirdek ile Premiere paneli arasindaki sozlesme testi.
 *
 * Ajan, ExtendScript fonksiyonlarini adiyla cagiriyor. Premiere olmadan
 * calistirip dogrulayamadigimiz icin en azindan sunlari kontrol ediyoruz:
 * fonksiyon var mi, arguman sayisi uyuyor mu, panel de ayni adlari mi kullaniyor.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const panelDir = path.resolve(here, "..", "..", "premiere-panel");
const jsxPath = path.join(panelDir, "host", "gelistir.jsx");
const mainPath = path.join(panelDir, "client", "js", "main.js");

const hasPanel = fs.existsSync(jsxPath);
const jsx = hasPanel ? fs.readFileSync(jsxPath, "utf8") : "";

/** jsx icindeki fonksiyon adi -> parametre listesi */
function jsxFunctions(source) {
  const map = new Map();
  const re = /function\s+(gelistir\w+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(source))) {
    const params = match[2]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    map.set(match[1], params);
  }
  return map;
}

/** Her host araci icin ornek girdi (hostArgs'i kosturabilmek icin). */
const SAMPLE_INPUTS = {
  premiere_get_project: {},
  premiere_get_sequence: { sequenceName: "Ana" },
  premiere_get_primary_source: {},
  premiere_apply_keeps: { planId: "plan-1", sourcePath: "/v/a.mp4", newSequenceName: "Yeni" },
  premiere_set_clip_enabled: { trackType: "video", trackIndex: 0, clipIndex: 1, enabled: false },
  premiere_delete_clip: { trackType: "audio", trackIndex: 1, clipIndex: 2, ripple: true },
  premiere_trim_clip: {
    trackType: "video", trackIndex: 0, clipIndex: 0, inPoint: "1.5", outPoint: "",
  },
  premiere_set_clip_gain: { trackIndex: 0, clipIndex: 3, gainDb: -3 },
  premiere_add_markers: { markers: [{ time: 12.5, title: "Kurulum" }] },
  premiere_set_playhead: { seconds: 42 },
  premiere_export_sequence: { outputPath: "/v/master.mp4", presetPath: "/v/p.epr" },
};

const fakeSession = {
  cutPlans: { "plan-1": { keepsText: "0.000,10.000;20.000,30.000" } },
};

test("panel dosyalari repoda duruyor", () => {
  assert.ok(hasPanel, `panel bulunamadi: ${jsxPath}`);
  assert.ok(fs.existsSync(mainPath), `panel main.js bulunamadi: ${mainPath}`);
});

test("her host araci icin ExtendScript fonksiyonu tanimli", { skip: !hasPanel }, () => {
  const defined = jsxFunctions(jsx);
  for (const spec of TOOL_SPECS) {
    if (spec.executor !== "host") continue;
    assert.ok(
      defined.has(spec.hostFn),
      `${spec.name} -> ${spec.hostFn}() gelistir.jsx icinde yok`,
    );
  }
});

test("hostArgs arguman sayilari jsx imzalariyla uyusuyor", { skip: !hasPanel }, () => {
  const defined = jsxFunctions(jsx);
  for (const spec of TOOL_SPECS) {
    if (spec.executor !== "host") continue;
    const sample = SAMPLE_INPUTS[spec.name];
    assert.ok(sample, `${spec.name} icin ornek girdi eksik (testi guncelle)`);

    const args = spec.hostArgs(sample, fakeSession);
    assert.ok(Array.isArray(args), `${spec.name}: hostArgs dizi dondurmeli`);

    const params = defined.get(spec.hostFn);
    assert.ok(
      args.length <= params.length,
      `${spec.name}: ${args.length} arguman gonderiyor ama ` +
        `${spec.hostFn}(${params.join(", ")}) ${params.length} parametre aliyor`,
    );
    for (const arg of args) {
      assert.notEqual(arg, undefined, `${spec.name}: undefined arguman gonderiliyor`);
    }
  }
});

test("ornek girdiler araclarin semasina uyuyor", () => {
  for (const spec of TOOL_SPECS) {
    if (spec.executor !== "host") continue;
    const sample = SAMPLE_INPUTS[spec.name];
    assert.deepEqual(
      Object.keys(sample).sort(),
      [...spec.input_schema.required].sort(),
      `${spec.name}: ornek girdi semadaki alanlarla birebir olmali`,
    );
  }
});

test("markers listesi ayiricilari bozmayacak sekilde kodlaniyor", () => {
  const spec = toolSpec("premiere_add_markers");
  const [text] = spec.hostArgs(
    {
      markers: [
        { time: 0, title: "Giris; bolum | bir" },
        { time: 61.5, title: "Kurulum" },
      ],
    },
    fakeSession,
  );
  // Ayirici karakterler baslikta kalmamali, yoksa jsx yanlis ayristirir
  assert.equal(text, "0.000|Giris  bolum   bir;61.500|Kurulum");
  assert.equal(text.split(";").length, 2);
  assert.equal(text.split(";")[0].split("|").length, 2);
});

test("apply_keeps plani oturumdan aliyor, modelden degil", () => {
  const spec = toolSpec("premiere_apply_keeps");
  const args = spec.hostArgs(
    { planId: "plan-1", sourcePath: "/v/a.mp4", newSequenceName: "Yeni" },
    fakeSession,
  );
  assert.equal(args[0], fakeSession.cutPlans["plan-1"].keepsText);
  assert.equal(Object.keys(spec.input_schema.properties).includes("keeps"), false);

  assert.throws(
    () => spec.hostArgs({ planId: "yok", sourcePath: "x", newSequenceName: "y" }, fakeSession),
    /planId bulunamadi/,
  );
});

test("panelin kendi cagirdigi jsx fonksiyonlari da tanimli", { skip: !hasPanel }, () => {
  const defined = jsxFunctions(jsx);
  const main = fs.readFileSync(mainPath, "utf8");
  const called = new Set(
    [...main.matchAll(/host(?:Raw)?\(\s*"(gelistir\w+)"/g)].map((m) => m[1]),
  );
  assert.ok(called.size >= 4, `panelde beklenen cagrilar bulunamadi: ${[...called]}`);
  for (const name of called) {
    assert.ok(defined.has(name), `panel ${name}() cagiriyor ama jsx'te yok`);
  }
});

test("jsx ES3 uyumlu kaliyor (ExtendScript motoru icin)", { skip: !hasPanel }, () => {
  // ExtendScript ES3: let/const/arrow/sablon literal/son virgul yok, JSON yok.
  const forbidden = [
    [/\blet\s+\w/, "let"],
    [/\bconst\s+\w/, "const"],
    [/=>/, "arrow fonksiyon"],
    [/`/, "sablon literal"],
    [/,\s*\)/, "cagrida son virgul"],
    [/,\s*\}/, "nesnede son virgul"],
    [/\bJSON\s*\./, "JSON nesnesi"],
    [/\.forEach\s*\(/, "Array.forEach"],
    [/\beval\s*\(/, "eval"],
  ];
  for (const [pattern, label] of forbidden) {
    const match = jsx.match(pattern);
    assert.equal(match, null, `gelistir.jsx icinde ${label} kullanilmis: ${match?.[0]}`);
  }
});

test("her arac docs/ajan.md icinde belgelenmis", () => {
  const docPath = path.resolve(here, "..", "..", "docs", "ajan.md");
  if (!fs.existsSync(docPath)) {
    assert.fail(`docs/ajan.md bulunamadi: ${docPath}`);
  }
  const doc = fs.readFileSync(docPath, "utf8");
  for (const spec of TOOL_SPECS) {
    assert.ok(doc.includes(spec.name), `${spec.name} docs/ajan.md icinde yok`);
    if (spec.approval) {
      // Onay gerektiren araclar tabloda isaretli olmali
      const row = doc.split("\n").find((l) => l.includes(spec.name) && l.startsWith("|"));
      assert.ok(row, `${spec.name} icin tablo satiri yok`);
      assert.match(row, /\*\*evet\*\*/, `${spec.name} onay gerektirdigi belirtilmemis`);
    }
  }
});
