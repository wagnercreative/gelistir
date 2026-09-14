/**
 * ffmpeg / ffprobe sarmalayicisi.
 *
 * Argumanlari kuran fonksiyonlar saf tutuldu (test edilebilir olsun diye);
 * sadece run* fonksiyonlari surec baslatir.
 */
import { spawn } from "node:child_process";

export function run(bin, args, { onStderr = null, cwd = null, onChild = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, windowsHide: true });
    if (onChild) onChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      if (onStderr) onStderr(text);
    });
    child.on("error", (err) =>
      reject(new Error(`${bin} baslatilamadi: ${err.message}. Kurulu ve PATH'te mi?`)),
    );
    child.on("close", (code) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      // stderr hataya da baglanir: silencedetect/loudnorm gibi olcum cagrilarinda
      // ffmpeg sifir olmayan kod dondurse bile log'daki veri kullanilabilir.
      const err = new Error(`${bin} ${code} koduyla cikti:\n${stderr.slice(-4000)}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------- probe

export function probeArgs(input) {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];
}

function parseFps(value) {
  if (!value) return null;
  const [num, den] = String(value).split("/").map(Number);
  if (!den) return num || null;
  return num / den;
}

export function parseProbe(stdout) {
  const data = JSON.parse(stdout);
  const video = (data.streams || []).find((s) => s.codec_type === "video") || null;
  const audio = (data.streams || []).find((s) => s.codec_type === "audio") || null;
  const duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    video: video && {
      codec: video.codec_name,
      width: Number(video.width) || 0,
      height: Number(video.height) || 0,
      fps: parseFps(video.r_frame_rate) || parseFps(video.avg_frame_rate) || 0,
    },
    audio: audio && {
      codec: audio.codec_name,
      channels: Number(audio.channels) || 0,
      sampleRate: Number(audio.sample_rate) || 0,
    },
  };
}

export async function probe(ffprobeBin, input) {
  const { stdout } = await run(ffprobeBin, probeArgs(input));
  return parseProbe(stdout);
}

// ---------------------------------------------------------------- sessizlik

export function silenceDetectArgs(input, { silenceThresholdDb = -34, minSilence = 0.45 } = {}) {
  return [
    "-hide_banner",
    "-nostats",
    "-i", input,
    "-af", `silencedetect=noise=${silenceThresholdDb}dB:d=${minSilence}`,
    "-f", "null",
    "-",
  ];
}

/** silencedetect log satirlarini araliklara cevirir. */
export function parseSilenceDetect(stderr, duration = Infinity) {
  const ranges = [];
  let open = null;
  const lines = String(stderr).split(/\r?\n/);
  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (startMatch) {
      open = Math.max(0, parseFloat(startMatch[1]));
      continue;
    }
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (endMatch && open !== null) {
      const end = parseFloat(endMatch[1]);
      if (end > open) {
        ranges.push({ start: open, end, kind: "silence", reason: "sessizlik", confidence: 0.95 });
      }
      open = null;
    }
  }
  // Kayit sessizlikle bitmisse silence_end hic gelmez.
  if (open !== null && Number.isFinite(duration) && duration > open) {
    ranges.push({
      start: open,
      end: duration,
      kind: "silence",
      reason: "sondaki sessizlik",
      confidence: 0.95,
    });
  }
  return ranges;
}

// ---------------------------------------------------------------- kesme zinciri

/**
 * keeps listesinden trim/atrim + concat filtre zinciri kurar.
 * @returns {{filter: string, videoLabel: string|null, audioLabel: string|null}}
 */
export function buildConcatFilter(keeps, { video = true, audio = true } = {}) {
  if (!keeps || keeps.length === 0) throw new Error("buildConcatFilter: keeps bos");
  const chains = [];
  const labels = [];

  keeps.forEach((k, i) => {
    const start = k.start.toFixed(6);
    const end = k.end.toFixed(6);
    if (video) {
      chains.push(`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${i}]`);
    }
    if (audio) {
      chains.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`);
    }
    if (video) labels.push(`[v${i}]`);
    if (audio) labels.push(`[a${i}]`);
  });

  const n = keeps.length;
  const v = video ? 1 : 0;
  const a = audio ? 1 : 0;
  const outLabels = [];
  if (video) outLabels.push("[vcat]");
  if (audio) outLabels.push("[acat]");
  chains.push(`${labels.join("")}concat=n=${n}:v=${v}:a=${a}${outLabels.join("")}`);

  return {
    filter: chains.join(";"),
    videoLabel: video ? "[vcat]" : null,
    audioLabel: audio ? "[acat]" : null,
  };
}

export function loudnormFilter({ targetLufs = -14, truePeakDb = -1, loudnessRange = 11 } = {}) {
  return `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=${loudnessRange}`;
}

/**
 * Kesilmis sesin gurlugunu olcer (dosya yazmaz).
 * Olcum kesimden SONRA yapilmali; yoksa atilan sessizlikler ortalamayi bozar.
 */
export function loudnessMeasureArgs(input, keeps, options = {}) {
  const { filter } = buildConcatFilter(keeps, { video: false, audio: true });
  const chain = `${filter};[acat]${loudnormFilter(options)}:print_format=json[aout]`;
  return [
    "-hide_banner",
    "-nostats",
    "-i", input,
    "-filter_complex", chain,
    "-map", "[aout]",
    "-f", "null",
    "-",
  ];
}

/** loudnorm'un stderr'e bastigi son JSON blogunu ayiklar. */
export function parseLoudnorm(stderr) {
  const text = String(stderr);
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const measured = {
    inputI: num(parsed.input_i),
    inputTp: num(parsed.input_tp),
    inputLra: num(parsed.input_lra),
    inputThresh: num(parsed.input_thresh),
    targetOffset: num(parsed.target_offset),
    outputI: num(parsed.output_i),
  };
  if (measured.inputI === null || measured.inputTp === null) return null;
  return measured;
}

/** Olculen degerlerle tek gecislik, dogru tepe noktali loudnorm zinciri. */
export function loudnormApplyFilter(measured, options = {}) {
  const { targetLufs = -14, truePeakDb = -1, loudnessRange = 11 } = options;
  if (!measured) return loudnormFilter(options);
  return [
    `loudnorm=I=${targetLufs}`,
    `TP=${truePeakDb}`,
    `LRA=${loudnessRange}`,
    `measured_I=${measured.inputI}`,
    `measured_TP=${measured.inputTp}`,
    `measured_LRA=${measured.inputLra ?? loudnessRange}`,
    `measured_thresh=${measured.inputThresh ?? measured.inputI - 10}`,
    `offset=${measured.targetOffset ?? 0}`,
    "linear=true",
    "print_format=summary",
  ].join(":");
}

// ---------------------------------------------------------------- teslim

/** YouTube'un onerdigi H.264 hedef bit hizlari (SDR). */
export function recommendedBitrateKbps(height, fps = 30) {
  const table = [
    [2160, 35000],
    [1440, 16000],
    [1080, 8000],
    [720, 5000],
    [480, 2500],
    [360, 1000],
  ];
  const row = table.find(([h]) => height >= h) || table[table.length - 1];
  const base = row[1];
  return Math.round(fps > 40 ? base * 1.5 : base);
}

/**
 * Tek gecislik teslim komutu: kes + (opsiyonel altyazi yak) + gurluk + kodla.
 */
export function deliveryArgs({
  input,
  output,
  keeps,
  measured = null,
  subtitlePath = null,
  probeInfo = null,
  options = {},
}) {
  const {
    videoCodec = "libx264",
    x264Preset = "slow",
    audioBitrate = "384k",
    faststart = true,
  } = options;

  const hasVideo = probeInfo ? probeInfo.hasVideo : true;
  const { filter, videoLabel, audioLabel } = buildConcatFilter(keeps, {
    video: hasVideo,
    audio: true,
  });

  const chains = [filter];
  let vOut = videoLabel;
  if (hasVideo && subtitlePath) {
    // Windows yollarindaki ters bolu ve iki nokta filtre sozdizimini bozar.
    const escaped = String(subtitlePath).replace(/\\/g, "/").replace(/:/g, "\\:");
    chains.push(`${videoLabel}subtitles='${escaped}'[vsub]`);
    vOut = "[vsub]";
  }
  chains.push(`${audioLabel}${loudnormApplyFilter(measured, options)}[aout]`);

  const args = ["-hide_banner", "-y", "-i", input, "-filter_complex", chains.join(";")];

  if (hasVideo) {
    const height = probeInfo?.video?.height || 1080;
    const fps = probeInfo?.video?.fps || 30;
    const kbps = recommendedBitrateKbps(height, fps);
    args.push(
      "-map", vOut,
      "-c:v", videoCodec,
      "-preset", x264Preset,
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-b:v", `${kbps}k`,
      "-maxrate", `${Math.round(kbps * 1.5)}k`,
      "-bufsize", `${kbps * 2}k`,
      "-g", String(Math.max(2, Math.round((fps || 30) * 2))),
      "-color_primaries", "bt709",
      "-color_trc", "bt709",
      "-colorspace", "bt709",
    );
  }

  args.push(
    "-map", "[aout]",
    "-c:a", "aac",
    "-b:a", audioBitrate,
    "-ar", "48000",
    "-ac", "2",
  );

  if (faststart) args.push("-movflags", "+faststart");
  args.push(output);
  return args;
}

export function thumbnailArgs(input, timeSeconds, output) {
  return [
    "-hide_banner",
    "-y",
    "-ss", timeSeconds.toFixed(3),
    "-i", input,
    "-frames:v", "1",
    "-vf", "scale=1280:-2:flags=lanczos",
    "-q:v", "2",
    output,
  ];
}

export function extractAudioArgs(input, output) {
  return [
    "-hide_banner",
    "-y",
    "-i", input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    output,
  ];
}
