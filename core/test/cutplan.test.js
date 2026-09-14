import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRanges,
  invertRanges,
  padRemovals,
  enforceRemovalBudget,
  mergeCloseKeeps,
  dropTinyKeeps,
  snapRangeToWordGaps,
  buildCutPlan,
  remapTime,
  projectRange,
} from "../src/cutplan.js";

test("normalizeRanges ust uste binenleri birlestirir ve siralar", () => {
  const out = normalizeRanges([
    { start: 5, end: 8, confidence: 0.6 },
    { start: 1, end: 3 },
    { start: 2.5, end: 6, confidence: 0.9 },
  ]);
  assert.deepEqual(
    out.map((r) => [r.start, r.end]),
    [
      [1, 8],
    ],
  );
  assert.equal(out[0].confidence, 0.9, "birlesende en yuksek guven tutulur");
});

test("normalizeRanges sinirlari kirpar ve sifir uzunluklulari atar", () => {
  const out = normalizeRanges([
    { start: -5, end: 2 },
    { start: 9, end: 9 },
    { start: 8, end: 50 },
  ], 10);
  assert.deepEqual(
    out.map((r) => [r.start, r.end]),
    [
      [0, 2],
      [8, 10],
    ],
  );
});

test("invertRanges tutulacak parcalari verir", () => {
  const keeps = invertRanges([{ start: 2, end: 4 }, { start: 7, end: 8 }], 10);
  assert.deepEqual(keeps, [
    { start: 0, end: 2 },
    { start: 4, end: 7 },
    { start: 8, end: 10 },
  ]);
});

test("invertRanges bastan ve sondan kesimde bos parca uretmez", () => {
  assert.deepEqual(invertRanges([{ start: 0, end: 3 }, { start: 8, end: 10 }], 10), [
    { start: 3, end: 8 },
  ]);
});

test("padRemovals nefes payi birakir, anlamsiz kalanlari duser", () => {
  const out = padRemovals([{ start: 10, end: 12 }, { start: 20, end: 20.15 }], 0.1, 0.2, 0.1);
  assert.equal(out.length, 1);
  assert.equal(out[0].start.toFixed(2), "10.10");
  assert.equal(out[0].end.toFixed(2), "11.80");
});

test("enforceRemovalBudget butceyi asan onerileri reddeder", () => {
  const { accepted, rejected, removedSeconds } = enforceRemovalBudget(
    [
      { start: 0, end: 10, confidence: 0.5 },
      { start: 20, end: 30, confidence: 0.95 },
      { start: 40, end: 50, confidence: 0.9 },
    ],
    100,
    0.2,
  );
  assert.equal(removedSeconds, 20);
  assert.deepEqual(accepted.map((r) => r.start), [20, 40], "guveni yuksek olanlar alinir");
  assert.deepEqual(rejected.map((r) => r.start), [0]);
});

test("mergeCloseKeeps cok yakin parcalari birlestirir", () => {
  const out = mergeCloseKeeps(
    [
      { start: 0, end: 2 },
      { start: 2.05, end: 4 },
      { start: 6, end: 8 },
    ],
    0.12,
  );
  assert.deepEqual(out, [
    { start: 0, end: 4 },
    { start: 6, end: 8 },
  ]);
});

test("dropTinyKeeps kisa parcalari atar", () => {
  assert.deepEqual(dropTinyKeeps([{ start: 0, end: 0.2 }, { start: 1, end: 3 }], 0.35), [
    { start: 1, end: 3 },
  ]);
});

test("snapRangeToWordGaps kelime ortasindan kesmez", () => {
  const words = [
    { start: 0.0, end: 0.5, word: "merhaba" },
    { start: 0.6, end: 1.4, word: "arkadaslar" },
    { start: 2.0, end: 2.4, word: "bugun" },
  ];
  const snapped = snapRangeToWordGaps({ start: 1.0, end: 2.2 }, words);
  assert.equal(snapped.start, 1.4, "kelimenin bitisine cekilir");
  assert.equal(snapped.end, 2.0, "sonraki kelimenin basina cekilir");
});

test("snapRangeToWordGaps tamamen kelime icindeyse null doner", () => {
  const words = [{ start: 0, end: 5, word: "uzuuuun" }];
  assert.equal(snapRangeToWordGaps({ start: 1, end: 2 }, words), null);
});

test("buildCutPlan uctan uca tutarli plan uretir", () => {
  const plan = buildCutPlan({
    duration: 100,
    removals: [
      { start: 10, end: 15, confidence: 0.9, kind: "silence" },
      { start: 14, end: 16, confidence: 0.8, kind: "silence" },
      { start: 50, end: 52, confidence: 0.7, kind: "filler" },
    ],
    options: {
      padHead: 0.1,
      padTail: 0.1,
      minSilence: 0.4,
      minKeepSegment: 0.35,
      mergeGap: 0.12,
      maxRemovedRatio: 0.35,
    },
  });
  const total = plan.keeps.reduce((s, k) => s + (k.end - k.start), 0);
  assert.equal(total.toFixed(4), plan.outputDuration.toFixed(4));
  assert.equal((plan.outputDuration + plan.removedSeconds).toFixed(4), "100.0000");
  assert.ok(plan.removedRatio < 0.35);
  // 10-16 birlesti, paylarla 10.1-15.9 atildi
  assert.equal(plan.keeps[0].end.toFixed(2), "10.10");
  assert.equal(plan.keeps[1].start.toFixed(2), "15.90");
});

test("buildCutPlan her sey atilsa bile kaynagi korur", () => {
  const plan = buildCutPlan({
    duration: 10,
    removals: [{ start: 0, end: 10, confidence: 1 }],
    options: { maxRemovedRatio: 1, minKeepSegment: 0.35 },
  });
  assert.deepEqual(plan.keeps, [{ start: 0, end: 10 }]);
  assert.equal(plan.removedSeconds, 0);
});

test("buildCutPlan butceyi asan modeli budar", () => {
  const plan = buildCutPlan({
    duration: 100,
    removals: Array.from({ length: 10 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 9,
      confidence: 0.9,
    })),
    options: { maxRemovedRatio: 0.3, minKeepSegment: 0.1 },
  });
  assert.ok(plan.removedRatio <= 0.31, `atilan oran ${plan.removedRatio}`);
  assert.ok(plan.rejected.length > 0);
});

test("buildCutPlan gecersiz sure ile hata verir", () => {
  assert.throws(() => buildCutPlan({ duration: 0, removals: [] }), /Gecersiz kaynak suresi/);
});

test("remapTime kaynak zamanini cikti zamanina cevirir", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  assert.equal(remapTime(5, keeps), 5);
  assert.equal(remapTime(15, keeps), 10, "atilan bolge sonraki parcanin basina oturur");
  assert.equal(remapTime(25, keeps), 15);
  assert.equal(remapTime(999, keeps), 20);
});

test("projectRange kesim uzerinden gecen araligi birlestirir", () => {
  const keeps = [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ];
  assert.deepEqual(projectRange(8, 22, keeps), { start: 8, end: 12 });
  assert.equal(projectRange(12, 18, keeps), null, "tamamen atilmis aralik");
});
