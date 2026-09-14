import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenAiWhisperJson,
  parseWhisperCppJson,
  parseSrt,
  parseSrtTime,
  flattenWords,
  transcriptToPromptText,
} from "../src/transcribe.js";

test("parseOpenAiWhisperJson segment ve kelime zamanlarini okur", () => {
  const t = parseOpenAiWhisperJson({
    language: "tr",
    segments: [
      {
        start: 0.0,
        end: 2.5,
        text: " Merhaba arkadaslar. ",
        words: [
          { word: " Merhaba", start: 0.0, end: 0.8 },
          { word: " arkadaslar", start: 0.9, end: 2.4 },
        ],
      },
      { start: 2.6, end: 2.6, text: "bos sure" },
    ],
  });
  assert.equal(t.language, "tr");
  assert.equal(t.segments.length, 1, "sifir uzunluklu segment atilir");
  assert.equal(t.segments[0].text, "Merhaba arkadaslar.");
  assert.equal(t.segments[0].words.length, 2);
  assert.equal(t.segments[0].words[0].word, "Merhaba");
});

test("parseWhisperCppJson milisaniyeyi saniyeye cevirir", () => {
  const t = parseWhisperCppJson({
    result: { language: "tr" },
    transcription: [
      { offsets: { from: 0, to: 2500 }, text: " Merhaba " },
      { offsets: { from: 2500, to: 5000 }, text: "ikinci" },
    ],
  });
  assert.equal(t.language, "tr");
  assert.deepEqual(t.segments.map((s) => [s.start, s.end]), [
    [0, 2.5],
    [2.5, 5],
  ]);
});

test("parseSrtTime iki bicimi de kabul eder", () => {
  assert.equal(parseSrtTime("00:00:07,120"), 7.12);
  assert.equal(parseSrtTime("01:02:03.500"), 3723.5);
  assert.equal(parseSrtTime("bozuk"), null);
});

test("parseSrt hazir dokumu segmentlere cevirir", () => {
  const srt = [
    "1",
    "00:00:00,000 --> 00:00:02,500",
    "Merhaba arkadaslar",
    "",
    "2",
    "00:00:02,500 --> 00:00:05,000",
    "Bugun iki satirlik",
    "bir altyazi var",
    "",
  ].join("\n");
  const t = parseSrt(srt);
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[0].start, 0);
  assert.equal(t.segments[1].text, "Bugun iki satirlik bir altyazi var");
});

test("parseSrt bozuk bloklari atlar", () => {
  const t = parseSrt("1\nzaman yok\nmetin\n\n2\n00:00:05,000 --> 00:00:04,000\nters\n\n3\n00:00:06,000 --> 00:00:07,000\nsaglam");
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].text, "saglam");
});

test("parseSrt CRLF satir sonlarini kaldirir", () => {
  const t = parseSrt("1\r\n00:00:01,000 --> 00:00:02,000\r\nmetin\r\n");
  assert.equal(t.segments[0].text, "metin");
});

test("flattenWords tum kelimeleri sirali tek listede verir", () => {
  const words = flattenWords({
    segments: [
      { start: 2, end: 3, text: "b", words: [{ start: 2, end: 2.5, word: "b" }] },
      { start: 0, end: 1, text: "a", words: [{ start: 0, end: 0.5, word: "a" }] },
      { start: 4, end: 5, text: "kelimesiz" },
    ],
  });
  assert.deepEqual(words.map((w) => w.word), ["a", "b"]);
});

test("flattenWords kelime yoksa bos dizi doner", () => {
  assert.deepEqual(flattenWords({ segments: [{ start: 0, end: 1, text: "x" }] }), []);
  assert.deepEqual(flattenWords(null), []);
});

test("transcriptToPromptText zaman damgali satirlar uretir", () => {
  const { text, truncated } = transcriptToPromptText({
    segments: [
      { start: 0, end: 1.5, text: "birinci" },
      { start: 1.5, end: 3, text: "ikinci" },
    ],
  });
  assert.equal(text, "[0.00-1.50] birinci\n[1.50-3.00] ikinci");
  assert.equal(truncated, false);
});

test("transcriptToPromptText uzun metni kirpmaz, isaretler", () => {
  const segments = Array.from({ length: 200 }, (_, i) => ({
    start: i,
    end: i + 1,
    text: "x".repeat(100),
  }));
  const out = transcriptToPromptText({ segments }, { maxChars: 1000 });
  assert.equal(out.truncated, true);
  assert.ok(out.text.length > 1000, "metin kirpilmadi");
});

test("detectWhisper kurulu olmayan programi bulundu saymaz", async () => {
  const { detectWhisper } = await import("../src/transcribe.js");
  // Ismi "whisper" gecen ama var olmayan bir program dondurulmemeli:
  // spawn hatasinin mesajinda ismin gecmesi kurulum kaniti degil.
  const found = await detectWhisper("whisper-kesinlikle-yok-xyz");
  assert.notEqual(found, "whisper-kesinlikle-yok-xyz");
});

test("detectWhisper sifir olmayan kodla usage yazan kurulumu kabul eder", async () => {
  const { detectWhisper } = await import("../src/transcribe.js");
  // whisper.cpp davranisini taklit eden bir sarmalayici.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-fake-"));
  const bin = path.join(dir, "whisper-cli");
  fs.writeFileSync(bin, "#!/bin/sh\necho 'usage: whisper-cli [options]' >&2\nexit 1\n");
  fs.chmodSync(bin, 0o755);
  assert.equal(await detectWhisper(bin), bin);
});
