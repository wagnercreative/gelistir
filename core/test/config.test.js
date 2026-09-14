import test from "node:test";
import assert from "node:assert/strict";
import { sanitize, DEFAULTS, loadConfig } from "../src/config.js";

test("sanitize bilinmeyen anahtarlari atar", () => {
  const out = sanitize({ minSilence: 1, kotuAlan: "rm -rf" });
  assert.deepEqual(Object.keys(out), ["minSilence"]);
});

test("sanitize sayilari donusturur, bozuklari atar", () => {
  assert.deepEqual(sanitize({ port: "9000" }), { port: 9000 });
  assert.deepEqual(sanitize({ minSilence: "yazi" }), {});
  assert.deepEqual(sanitize({ targetLufs: "-16" }), { targetLufs: -16 });
});

test("sanitize boolean alanlari string'den cozer", () => {
  assert.deepEqual(sanitize({ burnSubtitles: "true" }), { burnSubtitles: true });
  assert.deepEqual(sanitize({ burnSubtitles: "hayir" }), { burnSubtitles: false });
  assert.deepEqual(sanitize({ subtitles: false }), { subtitles: false });
});

test("sanitize undefined degerleri string'e cevirmez", () => {
  const out = sanitize({ model: undefined, whisper: "whisper-cli" });
  assert.deepEqual(out, { whisper: "whisper-cli" });
});

test("loadConfig varsayilanlari korur ve override kabul eder", () => {
  const cfg = loadConfig({ minSilence: 0.9, bilinmeyen: 1 });
  assert.equal(cfg.minSilence, 0.9);
  assert.equal(cfg.model, DEFAULTS.model);
  assert.equal("bilinmeyen" in cfg, false);
});

test("varsayilanlar YouTube kurallariyla tutarli", () => {
  assert.equal(DEFAULTS.targetLufs, -14);
  assert.equal(DEFAULTS.truePeakDb, -1);
  assert.equal(DEFAULTS.minChapters, 3);
  assert.equal(DEFAULTS.minChapterLength, 10);
  assert.equal(DEFAULTS.maxTitleLength, 100);
  assert.equal(DEFAULTS.maxDescriptionLength, 5000);
  assert.equal(DEFAULTS.maxTagsTotalLength, 500);
  assert.ok(DEFAULTS.maxRemovedRatio < 1, "her seyi atma guvenligi");
});
