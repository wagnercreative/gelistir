/**
 * Yapilandirma: varsayilanlar + ~/.gelistir/config.json + ortam degiskenleri.
 *
 * Kurgu kararlarinin tamami buradaki esiklere baglidir. Claude'un onerdigi
 * kesimler bu esiklere gore budanir; yani model "her seyi kes" dese bile
 * cikti guvenli kalir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  // --- Model ---
  model: "claude-opus-5",
  effort: "high",

  // --- Sunucu ---
  host: "127.0.0.1",
  port: 8787,

  // --- Harici araclar ---
  ffmpeg: "ffmpeg",
  ffprobe: "ffprobe",
  // Bos ise sirayla denenir: whisper-cli, whisper-cpp, main, whisper, faster-whisper
  whisper: "",
  whisperModel: "", // whisper.cpp icin .bin yolu; OpenAI whisper CLI icin "medium" gibi
  language: "", // bos = otomatik algila

  // --- Kesim esikleri (saniye) ---
  minSilence: 0.45, // bundan kisa sessizlik kesilmez
  silenceThresholdDb: -34, // ffmpeg silencedetect noise esigi
  padHead: 0.08, // kesilen sessizligin basinda birakilan nefes payi
  padTail: 0.12, // sonunda birakilan pay
  minKeepSegment: 0.35, // bundan kisa parcalar tutulmaz (tik sesi olur)
  mergeGap: 0.12, // bu araliktan yakin iki parca birlestirilir
  maxRemovedRatio: 0.35, // toplam surenin en fazla %35'i atilabilir

  // --- Icerik kesimleri ---
  removeFillers: true, // "eee", "yani", "hani" gibi dolgu sozcukleri
  removeRetakes: true, // ayni cumlenin tekrar cekimleri
  removeOffTopic: false, // konu disi bolumler (varsayilan kapali, risklidir)

  // --- Ses ---
  targetLufs: -14, // YouTube normalizasyon hedefi
  truePeakDb: -1.0,
  loudnessRange: 11,

  // --- Goruntu / teslim ---
  container: "mp4",
  videoCodec: "libx264",
  x264Preset: "slow",
  audioBitrate: "384k",
  faststart: true,

  // --- Altyazi ---
  subtitles: true,
  burnSubtitles: false, // YouTube'a sidecar .srt yuklemek daha iyidir
  srtMaxCharsPerLine: 42,
  srtMaxLines: 2,
  srtMinDuration: 1.0,
  srtMaxDuration: 6.0,

  // --- YouTube metadata ---
  chapters: true,
  minChapters: 3, // YouTube kurali: 3'ten az bolum = bolum yok
  minChapterLength: 10, // YouTube kurali: her bolum >= 10 sn
  maxTitleLength: 100,
  maxDescriptionLength: 5000,
  maxTags: 15,
  maxTagsTotalLength: 500,
  thumbnailCandidates: 3,

  // --- Premiere ---
  exportPreset: "", // .epr yolu; bos ise ffmpeg ile master alinir
  masterEngine: "ffmpeg", // "ffmpeg" | "premiere"

  // --- Kurulum izleri ---
  // `gelistir kurulum --uygula` bunlari yazar. Premiere paneli cekirdek
  // kapali oldugunda kendisi baslatabilsin diye: panelin icindeki node
  // Premiere'in kendi surecidir, gercek node yolunu ve depo kokunu
  // baskasinin soylemesi gerekiyor.
  repoRoot: "",
  nodePath: "",
};

export function configPath() {
  return path.join(os.homedir(), ".gelistir", "config.json");
}

function readFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

/** Bilinmeyen anahtarlari atar, sayisal alanlari dogrular. */
export function sanitize(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    // Ayarlanmamis ortam degiskenleri buraya undefined olarak gelir; "undefined"
    // string'ine cevirmek modeli ve arac yollarini bozar.
    if (value === undefined || value === null || value === "") continue;
    const want = typeof DEFAULTS[key];
    if (want === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    } else if (want === "boolean") {
      out[key] = value === true || value === "true";
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function loadConfig(overrides = {}) {
  const env = sanitize({
    model: process.env.GELISTIR_MODEL,
    port: process.env.GELISTIR_PORT,
    ffmpeg: process.env.GELISTIR_FFMPEG,
    ffprobe: process.env.GELISTIR_FFPROBE,
    whisper: process.env.GELISTIR_WHISPER,
    whisperModel: process.env.GELISTIR_WHISPER_MODEL,
  });
  return { ...DEFAULTS, ...sanitize(readFileConfig()), ...env, ...sanitize(overrides) };
}

export function saveConfig(patch) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const merged = { ...sanitize(readFileConfig()), ...sanitize(patch) };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}
