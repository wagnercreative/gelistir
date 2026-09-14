import test from "node:test";
import assert from "node:assert/strict";
import { projectTranscript, buildReport, STEP_LABELS } from "../src/pipeline.js";
import { chunkSegments } from "../src/claude.js";

const KEEPS = [
  { start: 0, end: 10 },
  { start: 20, end: 30 },
];

test("projectTranscript segmentleri cikti zaman cizgisine tasir", () => {
  const t = projectTranscript(
    {
      language: "tr",
      segments: [
        { start: 1, end: 3, text: "basta" },
        { start: 12, end: 18, text: "atilan bolgede" },
        { start: 21, end: 24, text: "kesimden sonra" },
      ],
    },
    KEEPS,
  );
  assert.equal(t.segments.length, 2, "tamamen atilan segment dusuruldu");
  assert.deepEqual(
    t.segments.map((s) => [s.start, s.end, s.text]),
    [
      [1, 3, "basta"],
      [11, 14, "kesimden sonra"],
    ],
  );
  assert.equal(t.language, "tr");
});

test("projectTranscript kesim uzerinden gecen segmenti kisaltir", () => {
  const t = projectTranscript({ segments: [{ start: 8, end: 22, text: "kesim ustu" }] }, KEEPS);
  assert.deepEqual(t.segments[0], { start: 8, end: 12, text: "kesim ustu", words: undefined });
});

test("projectTranscript kelime zamanlarini da tasir ve atilanlari duser", () => {
  const t = projectTranscript(
    {
      segments: [
        {
          start: 8,
          end: 22,
          text: "bir iki uc",
          words: [
            { start: 8, end: 9, word: "bir" },
            { start: 13, end: 14, word: "iki" },
            { start: 21, end: 22, word: "uc" },
          ],
        },
      ],
    },
    KEEPS,
  );
  assert.deepEqual(
    t.segments[0].words.map((w) => [w.word, w.start, w.end]),
    [
      ["bir", 8, 9],
      ["uc", 11, 12],
    ],
    "atilan bolgedeki kelime dusuruldu",
  );
});

test("chunkSegments karakter butcesine gore boler, segment bolmez", () => {
  const segments = Array.from({ length: 50 }, (_, i) => ({
    start: i,
    end: i + 1,
    text: "y".repeat(100),
  }));
  const chunks = chunkSegments(segments, 1000);
  assert.ok(chunks.length > 1);
  assert.equal(
    chunks.reduce((n, c) => n + c.length, 0),
    50,
    "hicbir segment kaybolmadi",
  );
  assert.ok(chunks.every((c) => c.length > 0));
});

test("chunkSegments tek pencereye sigan dokumu bolmez", () => {
  const chunks = chunkSegments([{ start: 0, end: 1, text: "kisa" }], 1000);
  assert.equal(chunks.length, 1);
});

test("buildReport sayilari ve kontrol listesini yazar", () => {
  const md = buildReport({
    input: "/videolar/cekim.mp4",
    probeInfo: { video: { width: 1920, height: 1080, fps: 29.97 } },
    cutPlan: {
      sourceDuration: 600,
      outputDuration: 480,
      removedSeconds: 120,
      removedRatio: 0.2,
      keeps: [{ start: 0, end: 240 }, { start: 300, end: 540 }],
      rejected: [{ start: 1, end: 2 }],
      budget: 210,
    },
    removalsByKind: {
      silence: [{ start: 0, end: 60 }],
      filler: [{ start: 100, end: 101 }],
    },
    chapters: [
      { time: 0, title: "Giris" },
      { time: 90, title: "Kurulum" },
      { time: 300, title: "Sonuc" },
    ],
    warnings: ["Arka planda klima sesi var"],
    loudness: { measured: { inputI: -21.3 }, target: -14, truePeak: -1 },
    metadata: { titles: ["Birinci baslik", "Ikinci baslik"] },
    files: { video: "/paket/cekim-youtube.mp4" },
  });

  assert.ok(md.includes("10:00"), "kaynak suresi");
  assert.ok(md.includes("08:00") || md.includes("8:00"), "cikti suresi");
  assert.ok(md.includes("%20.0"));
  assert.ok(md.includes("1920x1080"));
  assert.ok(md.includes("Sessizlik"));
  assert.ok(md.includes("Dolgu sozcugu"));
  assert.ok(md.includes("0:00 Giris"));
  assert.ok(md.includes("Arka planda klima sesi var"));
  assert.ok(md.includes("Birinci baslik"));
  assert.ok(md.includes("- [ ]"), "yuklemeden once kontrol listesi");
  assert.ok(md.includes("uygulanmadi"), "butce siniri notu");
});

test("buildReport bolum yoksa nedenini yazar", () => {
  const md = buildReport({
    input: "a.mp4",
    cutPlan: {
      sourceDuration: 60,
      outputDuration: 60,
      removedSeconds: 0,
      removedRatio: 0,
      keeps: [{ start: 0, end: 60 }],
      rejected: [],
      budget: 20,
    },
    removalsByKind: {},
    chapters: [],
    warnings: [],
    files: {},
  });
  assert.ok(md.includes("en az 3 bolum"));
  assert.ok(md.includes("Hicbir sey atilmadi"));
});

test("STEP_LABELS her adim icin Turkce etiket verir", () => {
  for (const [key, value] of Object.entries(STEP_LABELS)) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 3, key);
  }
  assert.ok("bundle" in STEP_LABELS);
});
