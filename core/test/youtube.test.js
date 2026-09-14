import test from "node:test";
import assert from "node:assert/strict";
import {
  formatChapterTime,
  formatSrtTime,
  normalizeChapters,
  formatChapterBlock,
  clampTitle,
  normalizeTags,
  buildDescription,
  wrapCaption,
  buildSrtCues,
  formatSrt,
} from "../src/youtube.js";

test("formatChapterTime saat esigini dogru gecer", () => {
  assert.equal(formatChapterTime(0), "0:00");
  assert.equal(formatChapterTime(7.9), "0:07");
  assert.equal(formatChapterTime(75), "1:15");
  assert.equal(formatChapterTime(3723), "1:02:03");
});

test("formatSrtTime milisaniye yazar", () => {
  assert.equal(formatSrtTime(0), "00:00:00,000");
  assert.equal(formatSrtTime(7.12), "00:00:07,120");
  assert.equal(formatSrtTime(3661.5), "01:01:01,500");
});

test("normalizeChapters ilk bolumu 0:00 yapar", () => {
  const out = normalizeChapters(
    [
      { time: 12, title: "Kurulum" },
      { time: 60, title: "Ornek" },
      { time: 120, title: "Kapanis" },
    ],
    200,
  );
  assert.equal(out[0].time, 0);
  assert.equal(out.length, 4);
});

test("normalizeChapters 10 saniyeden yakin bolumleri atar", () => {
  const out = normalizeChapters(
    [
      { time: 0, title: "Giris" },
      { time: 4, title: "Cok yakin" },
      { time: 30, title: "Ikinci" },
      { time: 60, title: "Ucuncu" },
    ],
    200,
  );
  assert.deepEqual(out.map((c) => c.time), [0, 30, 60]);
});

test("normalizeChapters 3'ten az bolum kalirsa bos doner", () => {
  assert.deepEqual(normalizeChapters([{ time: 0, title: "Tek" }], 100), []);
  assert.deepEqual(normalizeChapters([], 100), []);
});

test("normalizeChapters videonun sonuna yakin bolumu atar", () => {
  const out = normalizeChapters(
    [
      { time: 0, title: "A" },
      { time: 20, title: "B" },
      { time: 40, title: "C" },
      { time: 95, title: "Sona cok yakin" },
    ],
    100,
  );
  assert.deepEqual(out.map((c) => c.title), ["A", "B", "C"]);
});

test("formatChapterBlock YouTube bicimini uretir", () => {
  assert.equal(
    formatChapterBlock([
      { time: 0, title: "Giris" },
      { time: 92, title: "Kurulum" },
    ]),
    "0:00 Giris\n1:32 Kurulum",
  );
});

test("clampTitle kelime sinirindan kirpar", () => {
  const long = "Premiere Pro icinde Claude ile tam otomatik kurgu nasil yapilir anlatiyorum";
  const out = clampTitle(long, 40);
  assert.ok(out.length <= 40);
  assert.ok(!out.endsWith(" "));
  assert.ok(long.startsWith(out));
});

test("clampTitle kisa basligi bozmaz", () => {
  assert.equal(clampTitle("  Kisa   baslik  ", 100), "Kisa baslik");
});

test("normalizeTags tekrarlari atar ve butceye sigdirir", () => {
  const out = normalizeTags(["Premiere", "premiere", "kurgu", "  ", "video"], {
    maxTags: 10,
    maxTotalLength: 500,
  });
  assert.deepEqual(out, ["Premiere", "kurgu", "video"]);
});

test("normalizeTags 500 karakter sinirini asmaz", () => {
  const many = Array.from({ length: 60 }, (_, i) => `etiket-numarasi-${i}`);
  const out = normalizeTags(many, { maxTags: 50, maxTotalLength: 100 });
  const total = out.join(",").length;
  assert.ok(total <= 100, `toplam ${total}`);
});

test("buildDescription bolumleri korur, ozeti kirpar", () => {
  const chapters = [
    { time: 0, title: "Giris" },
    { time: 30, title: "Kurulum" },
    { time: 90, title: "Sonuc" },
  ];
  const out = buildDescription({
    summary: "x".repeat(400),
    chapters,
    hashtags: ["premiere", "claude"],
    maxLength: 200,
  });
  assert.ok(out.length <= 200, `uzunluk ${out.length}`);
  assert.ok(out.includes("0:00 Giris"));
  assert.ok(out.includes("1:30 Sonuc"));
  assert.ok(out.includes("#premiere"));
});

test("buildDescription bolum yoksa sadece ozeti verir", () => {
  const out = buildDescription({ summary: "Ozet metni", chapters: [] });
  assert.equal(out, "Ozet metni");
});

test("wrapCaption satir uzunlugu ve sayisina uyar", () => {
  const lines = wrapCaption("bir iki uc dort bes alti yedi sekiz dokuz on", 12, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length <= 12, lines[0]);
});

test("buildSrtCues uzun segmenti kelime zamanlarindan boler", () => {
  const words = Array.from({ length: 20 }, (_, i) => ({
    start: i * 0.5,
    end: i * 0.5 + 0.4,
    word: `kelime${i}`,
  }));
  const cues = buildSrtCues(
    [{ start: 0, end: 10, text: words.map((w) => w.word).join(" "), words }],
    { srtMaxDuration: 3, srtMaxCharsPerLine: 42, srtMaxLines: 2, srtMinDuration: 1 },
  );
  assert.ok(cues.length >= 4, `kuyruk sayisi ${cues.length}`);
  for (const c of cues) {
    assert.ok(c.end - c.start <= 3.001, `sure ${c.end - c.start}`);
    assert.ok(c.lines.length <= 2);
  }
});

test("buildSrtCues cakismalari temizler ve sirali kalir", () => {
  const cues = buildSrtCues(
    [
      { start: 0, end: 2, text: "birinci" },
      { start: 1.5, end: 3.5, text: "ikinci" },
      { start: 3.4, end: 5, text: "ucuncu" },
    ],
    { srtMinDuration: 0.5, srtMaxDuration: 6 },
  );
  for (let i = 0; i < cues.length - 1; i++) {
    assert.ok(cues[i].end <= cues[i + 1].start + 1e-6, `${i}. kuyruk tasiyor`);
  }
});

test("buildSrtCues minimum sureyi uygular", () => {
  const cues = buildSrtCues([{ start: 0, end: 0.3, text: "kisa" }], {
    srtMinDuration: 1.2,
    srtMaxDuration: 6,
  });
  assert.equal(cues.length, 1);
  assert.equal((cues[0].end - cues[0].start).toFixed(2), "1.20");
});

test("buildSrtCues bos metni ve bozuk zamani atar", () => {
  const cues = buildSrtCues([
    { start: 0, end: 1, text: "   " },
    { start: 5, end: 4, text: "ters" },
    { start: 10, end: 12, text: "gecerli" },
  ]);
  assert.equal(cues.length, 1);
  assert.deepEqual(cues[0].lines, ["gecerli"]);
});

test("formatSrt gecerli SRT metni uretir", () => {
  const srt = formatSrt([
    { start: 0, end: 1.5, lines: ["birinci satir"] },
    { start: 1.5, end: 3, lines: ["ikinci", "satir"] },
  ]);
  assert.equal(
    srt,
    "1\n00:00:00,000 --> 00:00:01,500\nbirinci satir\n\n" +
      "2\n00:00:01,500 --> 00:00:03,000\nikinci\nsatir\n",
  );
});
