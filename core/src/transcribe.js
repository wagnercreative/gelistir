/**
 * Transkripsiyon: yerel whisper kurulumunu bulur, JSON/SRT ciktisini normalize eder.
 *
 * Normalize edilmis bicim:
 *   { language, segments: [{ start, end, text, words?: [{start,end,word}] }] }
 *
 * Transkript zorunlu degil. Yoksa boru hatti yalniz sessizlik kesimi yapar;
 * dolgu sozcugu temizligi, bolumler, altyazi ve metadata devre disi kalir.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { run } from "./ffmpeg.js";

const CANDIDATES = ["whisper-cli", "whisper-cpp", "whisper", "main"];

export async function detectWhisper(preferred = "") {
  const list = preferred ? [preferred, ...CANDIDATES] : CANDIDATES;
  for (const bin of list) {
    try {
      await run(bin, ["--help"]);
      return bin;
    } catch (err) {
      // Program hic yoksa bulundu sayilmaz. (spawn ENOENT -> err.code yok,
      // err.message "baslatilamadi" der; ismin icinde "whisper" gecmesi
      // bulundugu anlamina gelmez.)
      const spawnFailed = err.code === undefined || err.code === null;
      if (spawnFailed) continue;
      // whisper.cpp --help'i sifir olmayan kodla bitirir ama kullanim
      // bilgisini stderr'e yazar; bu gercek bir kurulumdur.
      const output = `${err.stderr || ""}${err.stdout || ""}`;
      if (/whisper|usage|transcribe/i.test(output)) return bin;
    }
  }
  return null;
}

function isWhisperCpp(bin) {
  const name = path.basename(String(bin)).toLowerCase();
  return name.includes("cpp") || name === "main" || name === "whisper-cli";
}

// ---------------------------------------------------------------- ayristirma

/** OpenAI whisper CLI (--output_format json) ciktisi. */
export function parseOpenAiWhisperJson(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const segments = (data.segments || [])
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text || "").trim(),
      words: Array.isArray(s.words)
        ? s.words
            .map((w) => ({
              start: Number(w.start),
              end: Number(w.end),
              word: String(w.word ?? w.text ?? "").trim(),
            }))
            .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.word)
        : undefined,
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
  return { language: data.language || "", segments };
}

/** whisper.cpp (-oj) ciktisi; offsets milisaniye. */
export function parseWhisperCppJson(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const rows = data.transcription || [];
  const segments = rows
    .map((r) => ({
      start: Number(r.offsets?.from) / 1000,
      end: Number(r.offsets?.to) / 1000,
      text: String(r.text || "").trim(),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.text);
  return { language: data.result?.language || data.params?.language || "", segments };
}

export function parseSrtTime(text) {
  const m = String(text)
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** Hazir bir .srt dosyasini segmentlere cevirir (kullanici kendi transkriptini verebilir). */
export function parseSrt(content) {
  const blocks = String(content).replace(/\r/g, "").split(/\n\s*\n/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [from, to] = timeLine.split("-->").map((s) => s.trim());
    const start = parseSrtTime(from);
    const end = parseSrtTime(to);
    if (start === null || end === null || end <= start) continue;
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l.trim()));
    const text = textLines.join(" ").replace(/\s+/g, " ").trim();
    if (text) segments.push({ start, end, text });
  }
  return { language: "", segments };
}

/** Segmentlerdeki kelimeleri tek duz listeye indirir (kesim noktasi hizalamasi icin). */
export function flattenWords(transcript) {
  const words = [];
  for (const s of transcript?.segments || []) {
    if (s.words && s.words.length) words.push(...s.words);
  }
  return words.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- calistirma

/**
 * Ses dosyasini yazi dokumune cevirir.
 * @returns normalize edilmis transkript veya hata
 */
export async function transcribe({
  bin,
  audioPath,
  model = "",
  language = "",
  workDir = os.tmpdir(),
  onProgress = null,
}) {
  const outBase = path.join(workDir, path.basename(audioPath, path.extname(audioPath)));

  if (isWhisperCpp(bin)) {
    if (!model) {
      throw new Error(
        "whisper.cpp icin model dosyasi gerekli. config'te whisperModel'i " +
          "ggml-*.bin yoluna ayarla.",
      );
    }
    const args = ["-m", model, "-f", audioPath, "-oj", "-of", outBase];
    if (language) args.push("-l", language);
    await run(bin, args, { onStderr: onProgress });
    const jsonPath = `${outBase}.json`;
    return parseWhisperCppJson(fs.readFileSync(jsonPath, "utf8"));
  }

  const args = [
    audioPath,
    "--output_format", "json",
    "--output_dir", workDir,
    "--word_timestamps", "True",
  ];
  if (model) args.push("--model", model);
  if (language) args.push("--language", language);
  await run(bin, args, { onStderr: onProgress });
  const jsonPath = `${outBase}.json`;
  return parseOpenAiWhisperJson(fs.readFileSync(jsonPath, "utf8"));
}

/** Transkripti model istemine koymak icin kompakt, zaman damgali metne cevirir. */
export function transcriptToPromptText(transcript, { maxChars = 240000 } = {}) {
  const lines = (transcript?.segments || []).map(
    (s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`,
  );
  const text = lines.join("\n");
  if (text.length <= maxChars) return { text, truncated: false };
  return { text, truncated: true, chars: text.length };
}
