/**
 * Boru hatti: kaynak videodan YouTube'a yuklenmeye hazir pakete kadar.
 *
 * Modlar:
 *   full    - tek kaynak dosya uzerinde her sey (Premiere gerekmez)
 *   plan    - sadece dokum + kesim plani uretir (Premiere paneli zaman cizgisini kurar)
 *   deliver - Premiere'den cikmis master dosyayi yayina hazir pakete cevirir
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import * as ff from "./ffmpeg.js";
import * as yt from "./youtube.js";
import { buildCutPlan, projectRange, remapTime } from "./cutplan.js";
import { detectWhisper, transcribe, parseSrt, flattenWords } from "./transcribe.js";
import { createClient, planEdit, writeMetadata } from "./claude.js";

export const STEP_LABELS = {
  probe: "Kaynak inceleniyor",
  audio: "Ses ayristiriliyor",
  transcribe: "Konusma yaziya cevriliyor",
  silence: "Sessizlikler bulunuyor",
  plan: "Kurgu plani cikariliyor",
  cut: "Kesim plani uygulaniyor",
  subtitles: "Altyazi uretiliyor",
  master: "Video kodlaniyor",
  metadata: "YouTube metinleri yaziliyor",
  bundle: "Paket yaziliyor",
};

function slugify(name) {
  return (
    String(name)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "video"
  );
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Kaynak dokumunu kesilmis (cikti) zaman cizgisine tasir. */
export function projectTranscript(transcript, keeps) {
  const segments = [];
  for (const s of transcript.segments || []) {
    const projected = projectRange(s.start, s.end, keeps);
    if (!projected) continue; // tamamen atilmis
    const words = (s.words || [])
      .map((w) => {
        const p = projectRange(w.start, w.end, keeps);
        return p ? { start: p.start, end: p.end, word: w.word } : null;
      })
      .filter(Boolean);
    segments.push({
      start: projected.start,
      end: projected.end,
      text: s.text,
      words: words.length ? words : undefined,
    });
  }
  return { language: transcript.language, segments };
}

/** Kesim plani ozetini insan okuyacak sekilde yazar. */
export function buildReport({
  input,
  probeInfo,
  cutPlan,
  removalsByKind,
  chapters,
  warnings,
  loudness,
  metadata,
  files,
}) {
  const mmss = (s) => yt.formatChapterTime(s);
  const lines = [
    `# Kurgu raporu`,
    ``,
    `- Kaynak: \`${input}\``,
    `- Kaynak suresi: ${mmss(cutPlan.sourceDuration)}`,
    `- Yayina hazir sure: ${mmss(cutPlan.outputDuration)}`,
    `- Atilan: ${mmss(cutPlan.removedSeconds)} (%${(cutPlan.removedRatio * 100).toFixed(1)})`,
    `- Kesim sayisi: ${Math.max(0, cutPlan.keeps.length - 1)}`,
  ];
  if (probeInfo?.video) {
    lines.push(
      `- Goruntu: ${probeInfo.video.width}x${probeInfo.video.height} @ ` +
        `${(probeInfo.video.fps || 0).toFixed(2)} fps`,
    );
  }
  if (loudness?.measured) {
    lines.push(
      `- Gurluk: ${loudness.measured.inputI?.toFixed(1)} LUFS -> hedef ` +
        `${loudness.target} LUFS (tepe ${loudness.truePeak} dBTP)`,
    );
  }

  lines.push(``, `## Neler atildi`, ``);
  const kinds = Object.entries(removalsByKind || {});
  if (kinds.length === 0) {
    lines.push(`Hicbir sey atilmadi.`);
  } else {
    const labels = {
      silence: "Sessizlik / olu hava",
      deadair: "Olu hava",
      filler: "Dolgu sozcugu",
      retake: "Tekrar cekim",
      offtopic: "Konu disi",
      error: "Hatali bilgi",
      tiny: "Cok kisa parca",
    };
    for (const [kind, items] of kinds) {
      const total = items.reduce((s, r) => s + (r.end - r.start), 0);
      lines.push(`- **${labels[kind] || kind}**: ${items.length} yerde, ${total.toFixed(1)} sn`);
    }
  }

  if (cutPlan.rejected?.length) {
    lines.push(
      ``,
      `> Butce siniri (%${(cutPlan.budget / cutPlan.sourceDuration * 100).toFixed(0)}) doldugu ` +
        `icin ${cutPlan.rejected.length} oneri uygulanmadi.`,
    );
  }

  if (chapters?.length) {
    lines.push(``, `## Bolumler`, ``, yt.formatChapterBlock(chapters));
  } else {
    lines.push(``, `## Bolumler`, ``, `Yok (YouTube en az 3 bolum ve her bolum icin 10 sn ister).`);
  }

  if (warnings?.length) {
    lines.push(``, `## Dikkat`, ``, ...warnings.map((w) => `- ${w}`));
  }

  if (metadata?.titles?.length) {
    lines.push(``, `## Baslik adaylari`, ``, ...metadata.titles.map((t, i) => `${i + 1}. ${t}`));
  }

  lines.push(
    ``,
    `## Yuklemeden once`,
    ``,
    `- [ ] Videoyu bastan sona bir kez izle; kesim noktalarinda tik sesi var mi?`,
    `- [ ] Altyaziyi kontrol et (ozel isimler ve terimler).`,
    `- [ ] Kapak gorselini sec veya kendin tasarla.`,
    `- [ ] Baslik ve aciklamayi gozden gecir.`,
    `- [ ] Telif: muzik ve goruntu haklarini dogrula.`,
    ``,
    `## Paket`,
    ``,
    ...Object.entries(files || {}).map(([k, v]) => `- ${k}: \`${path.basename(v)}\``),
  );

  return lines.join("\n") + "\n";
}

function groupByKind(removals) {
  const out = {};
  for (const r of removals) {
    const kind = r.kind || "silence";
    (out[kind] ||= []).push(r);
  }
  return out;
}

/**
 * Ana boru hatti.
 *
 * @param {object} params
 * @param {string} params.input        kaynak medya (full/plan) veya master (deliver)
 * @param {string} params.outDir       paketin yazilacagi dizin
 * @param {object} params.config       loadConfig() cikisi
 * @param {"full"|"plan"|"deliver"|"deliver-source"} params.mode
 *   full           kaynak dosyadan bastan sona
 *   plan           sadece dokum + kesim plani (panel zaman cizgisini kurar)
 *   deliver        Premiere/AME master'i (zaten kesilmis) paketle
 *   deliver-source kaynak dosyayi verilen plana gore kes ve paketle
 * @param {string} [params.srtPath]    hazir dokum (whisper yoksa)
 * @param {object} [params.state]      deliver modunda plan asamasindan gelen job.json
 * @param {function} [params.onEvent]  ({step, label, detail, progress}) => void
 */
export async function runPipeline({
  input,
  outDir,
  config,
  mode = "full",
  srtPath = null,
  state = null,
  apiKey = "",
  onEvent = () => {},
  onChild = null,
  metadataOverride = null,
}) {
  const started = Date.now();
  const id = randomUUID().slice(0, 8);
  const base = slugify(path.basename(input, path.extname(input)));
  const bundleDir = ensureDir(path.resolve(outDir));
  const workDir = ensureDir(path.join(bundleDir, ".work"));
  const emit = (step, detail = "", progress = null) =>
    onEvent({ step, label: STEP_LABELS[step] || step, detail, progress });
  // Her ffmpeg/whisper cagrisi ayni onChild'i alir; sunucu iptalde bunlari oldurur.
  const runOpts = (extra = {}) => (onChild ? { ...extra, onChild } : extra);

  // deliver ve deliver-source agir adimlari atlar; ikisi arasindaki fark,
  // girdinin zaten kesilmis olup olmadigi.
  const deliverOnly = mode === "deliver" || mode === "deliver-source";
  const inputAlreadyCut = mode === "deliver";

  const steps =
    mode === "plan"
      ? ["probe", "audio", "transcribe", "silence", "plan", "cut"]
      : deliverOnly
        ? ["probe", "subtitles", "master", "metadata", "bundle"]
        : Object.keys(STEP_LABELS);
  const stepIndex = (s) => steps.indexOf(s) / steps.length;

  // ------------------------------------------------------------ 1. probe
  emit("probe", input, stepIndex("probe"));
  if (!fs.existsSync(input)) throw new Error(`Dosya bulunamadi: ${input}`);
  const probeInfo = await ff.probe(config.ffprobe, input);
  if (!probeInfo.duration) throw new Error(`Sure okunamadi: ${input}`);
  if (!probeInfo.hasAudio) throw new Error("Kaynakta ses yok; kurgu karari ses uzerinden verilir.");

  let transcript = state?.transcript || { language: config.language, segments: [] };
  let cutPlan = state?.cutPlan || null;
  let chapters = state?.chapters || [];
  let warnings = [...(state?.warnings || [])];
  let planResult = state?.planResult || null;

  const client = () => createClient(apiKey);
  const hasApiKey = Boolean(apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

  if (!deliverOnly) {
    // ---------------------------------------------------------- 2. ses
    emit("audio", "", stepIndex("audio"));
    const wavPath = path.join(workDir, `${base}-16k.wav`);
    await ff.run(config.ffmpeg, ff.extractAudioArgs(input, wavPath), runOpts());

    // ---------------------------------------------------------- 3. dokum
    emit("transcribe", "", stepIndex("transcribe"));
    if (srtPath && fs.existsSync(srtPath)) {
      transcript = parseSrt(fs.readFileSync(srtPath, "utf8"));
      emit("transcribe", `Hazir dokum kullanildi: ${path.basename(srtPath)}`);
    } else {
      const whisperBin = await detectWhisper(config.whisper);
      if (whisperBin) {
        transcript = await transcribe({
          bin: whisperBin,
          audioPath: wavPath,
          model: config.whisperModel,
          language: config.language,
          workDir,
          onProgress: (t) => {
            const m = String(t).match(/\[(\d+:\d+:\d+\.\d+)/);
            if (m) emit("transcribe", m[1]);
          },
        });
        fs.writeFileSync(
          path.join(workDir, "dokum.json"),
          JSON.stringify(transcript, null, 2),
        );
      } else {
        warnings.push(
          "whisper bulunamadi: dokum yok. Sadece sessizlik kesimi yapildi; altyazi, " +
            "bolumler ve YouTube metinleri uretilemedi.",
        );
        emit("transcribe", "whisper yok - atlandi");
      }
    }

    // ---------------------------------------------------------- 4. sessizlik
    emit("silence", "", stepIndex("silence"));
    const { stderr } = await ff
      .run(config.ffmpeg, ff.silenceDetectArgs(input, config), runOpts())
      .catch((err) => {
        // Bazi surumler -f null cikisinda sifir olmayan kod dondurur; log yeterli.
        if (err.stderr) return { stderr: err.stderr };
        throw err;
      });
    const silences = ff.parseSilenceDetect(stderr, probeInfo.duration);
    emit("silence", `${silences.length} sessizlik`);

    // ---------------------------------------------------------- 5. plan
    emit("plan", "", stepIndex("plan"));
    let removals = silences;
    if (transcript.segments.length && hasApiKey) {
      planResult = await planEdit({
        client: client(),
        transcript,
        silences,
        duration: probeInfo.duration,
        options: config,
        onProgress: (d) => emit("plan", d),
      });
      removals = [...silences, ...planResult.removals];
      chapters = planResult.chapters;
      warnings.push(...planResult.warnings);
    } else if (!hasApiKey) {
      warnings.push(
        "ANTHROPIC_API_KEY yok: dolgu sozcugu temizligi, bolumler ve YouTube metinleri " +
          "uretilmedi. Sadece sessizlik kesimi uygulandi.",
      );
      emit("plan", "API anahtari yok - sadece sessizlik kesimi");
    }

    // ---------------------------------------------------------- 6. kesim plani
    emit("cut", "", stepIndex("cut"));
    cutPlan = buildCutPlan({
      duration: probeInfo.duration,
      removals,
      words: flattenWords(transcript),
      options: config,
    });
    emit(
      "cut",
      `${cutPlan.keeps.length} parca, ${cutPlan.removedSeconds.toFixed(1)} sn atildi ` +
        `(%${(cutPlan.removedRatio * 100).toFixed(1)})`,
    );
  }

  const jobFile = path.join(bundleDir, "job.json");
  const jobState = {
    id,
    mode,
    input,
    bundleDir,
    probeInfo,
    transcript,
    cutPlan,
    chapters,
    warnings,
    planResult,
    createdAt: new Date().toISOString(),
  };

  if (mode === "plan") {
    fs.writeFileSync(jobFile, JSON.stringify(jobState, null, 2));
    return {
      ...jobState,
      files: { plan: jobFile },
      elapsedMs: Date.now() - started,
    };
  }

  // deliver modunda master zaten kesilmis: tek parca. deliver-source'ta ise
  // kaynak dosya plana gore burada kesilir.
  const deliveryKeeps = inputAlreadyCut
    ? [{ start: 0, end: probeInfo.duration }]
    : cutPlan?.keeps || [{ start: 0, end: probeInfo.duration }];
  if (inputAlreadyCut && cutPlan) {
    // Master'in suresi plandaki cikti suresiyle uyusmuyorsa altyazi kayar.
    const drift = Math.abs(probeInfo.duration - cutPlan.outputDuration);
    if (drift > 1.0) {
      warnings.push(
        `Master suresi (${probeInfo.duration.toFixed(1)} sn) plandaki cikti suresinden ` +
          `${drift.toFixed(1)} sn farkli. Altyazi kaymis olabilir.`,
      );
    }
  }
  const effectiveCutPlan =
    cutPlan || {
      keeps: deliveryKeeps,
      removed: [],
      rejected: [],
      budget: probeInfo.duration,
      sourceDuration: probeInfo.duration,
      outputDuration: probeInfo.duration,
      removedSeconds: 0,
      removedRatio: 0,
    };
  const outputDuration = inputAlreadyCut
    ? probeInfo.duration
    : effectiveCutPlan.outputDuration;

  // ------------------------------------------------------------ 7. altyazi
  const files = {};
  let srtOut = null;
  emit("subtitles", "", stepIndex("subtitles"));
  if (!config.subtitles) {
    emit("subtitles", "kapali - atlandi");
  } else if (!transcript.segments.length) {
    emit("subtitles", "dokum yok - atlandi");
  } else {
    // Dokum her iki modda da kaynak cizgisinde tutulur; keeps ile cikti cizgisine tasinir.
    const projected = projectTranscript(transcript, effectiveCutPlan.keeps);
    const cues = yt.buildSrtCues(projected.segments, config);
    const lang = (transcript.language || "tr").slice(0, 5);
    srtOut = path.join(bundleDir, `${base}.${lang}.srt`);
    fs.writeFileSync(srtOut, yt.formatSrt(cues));
    files.altyazi = srtOut;
    emit("subtitles", `${cues.length} altyazi satiri`);
  }

  // ------------------------------------------------------------ 8. kodlama
  emit("master", "gurluk olculuyor", stepIndex("master"));
  let measured = null;
  try {
    const res = await ff
      .run(config.ffmpeg, ff.loudnessMeasureArgs(input, deliveryKeeps, config), runOpts())
      .catch((err) => (err.stderr ? { stderr: err.stderr } : Promise.reject(err)));
    measured = ff.parseLoudnorm(res.stderr);
  } catch (err) {
    warnings.push(`Gurluk olcumu basarisiz, tek gecisli normalizasyon kullanildi: ${err.message}`);
  }

  const videoOut = path.join(bundleDir, `${base}-youtube.${config.container}`);
  emit("master", "kodlaniyor", stepIndex("master"));
  await ff.run(
    config.ffmpeg,
    ff.deliveryArgs({
      input,
      output: videoOut,
      keeps: deliveryKeeps,
      measured,
      subtitlePath: config.burnSubtitles ? srtOut : null,
      probeInfo,
      options: config,
    }),
    runOpts({
      onStderr: (t) => {
        const m = String(t).match(/time=(\d+:\d+:\d+\.\d+)/);
        if (m) emit("master", m[1]);
      },
    }),
  );
  files.video = videoOut;

  // ------------------------------------------------------------ 9. metadata
  const overrideChapters = metadataOverride?.chapters?.length
    ? metadataOverride.chapters
    : null;
  const normalizedChapters = config.chapters
    ? yt.normalizeChapters(
        (overrideChapters || chapters || []).map((c) => ({
          // Bolum zamanlari kaynak cizgisinde geldi; cikti cizgisine tasi.
          time: remapTime(c.time, effectiveCutPlan.keeps),
          title: c.title,
        })),
        outputDuration,
        config,
      )
    : [];

  let metadata = metadataOverride;
  emit("metadata", "", stepIndex("metadata"));
  if (metadataOverride) {
    // Metinler cagiran tarafca (ajan) verildi; yeniden uretmiyoruz.
    emit("metadata", "cagirandan geldi");
  } else if (!transcript.segments.length) {
    emit("metadata", "dokum yok - atlandi");
  } else if (!hasApiKey) {
    emit("metadata", "API anahtari yok - atlandi");
  } else {
    metadata = await writeMetadata({
      client: client(),
      transcript,
      chapters: normalizedChapters,
      outputDuration,
      options: config,
      onProgress: (d) => emit("metadata", d),
    });
  }

  // Kapak adaylari
  const moments =
    metadata?.thumbnailMoments?.length
      ? metadata.thumbnailMoments.map((m) => m.time)
      : Array.from({ length: config.thumbnailCandidates }, (_, i) =>
          (outputDuration * (i + 1)) / (config.thumbnailCandidates + 1),
        );
  const thumbs = [];
  for (let i = 0; i < Math.min(moments.length, config.thumbnailCandidates); i++) {
    const out = path.join(bundleDir, `kapak-${i + 1}.jpg`);
    try {
      await ff.run(config.ffmpeg, ff.thumbnailArgs(videoOut, moments[i], out), runOpts());
      thumbs.push(out);
    } catch {
      // tek bir karenin alinamamasi paketi bozmasin
    }
  }
  if (thumbs.length) files.kapaklar = thumbs.join(", ");

  // ------------------------------------------------------------ 10. paket
  emit("bundle", "", stepIndex("bundle"));
  const title = yt.clampTitle(metadata?.titles?.[0] || base, config.maxTitleLength);
  const tags = yt.normalizeTags(metadata?.tags || [], {
    maxTags: config.maxTags,
    maxTotalLength: config.maxTagsTotalLength,
  });
  const description = yt.buildDescription({
    summary: metadata?.description || "",
    chapters: normalizedChapters,
    hashtags: metadata?.hashtags || [],
    maxLength: config.maxDescriptionLength,
  });

  const metaJson = {
    title,
    titleAlternatives: (metadata?.titles || []).slice(1).map((t) => yt.clampTitle(t, config.maxTitleLength)),
    description,
    tags,
    chapters: normalizedChapters,
    pinnedComment: metadata?.pinnedComment || "",
    language: transcript.language || config.language || "",
    durationSeconds: Math.round(outputDuration),
    subtitleFile: srtOut ? path.basename(srtOut) : null,
    videoFile: path.basename(videoOut),
    thumbnails: thumbs.map((t) => path.basename(t)),
    warnings,
    // Yukleme durumu bilinerek bos birakiliyor: yayinlama karari insanin.
    privacyStatus: "private",
  };
  const metaPath = path.join(bundleDir, "metadata.json");
  fs.writeFileSync(metaPath, JSON.stringify(metaJson, null, 2) + "\n");
  files.metadata = metaPath;

  const descPath = path.join(bundleDir, "aciklama.txt");
  fs.writeFileSync(descPath, `${title}\n\n${description}\n`);
  files.aciklama = descPath;

  if (normalizedChapters.length) {
    const chapPath = path.join(bundleDir, "bolumler.txt");
    fs.writeFileSync(chapPath, yt.formatChapterBlock(normalizedChapters) + "\n");
    files.bolumler = chapPath;
  }

  const removalsByKind = groupByKind(
    inputAlreadyCut
      ? []
      : [...(planResult?.removals || []), ...(effectiveCutPlan.removed || [])],
  );
  const reportPath = path.join(bundleDir, "rapor.md");
  fs.writeFileSync(
    reportPath,
    buildReport({
      input,
      probeInfo,
      cutPlan: { ...effectiveCutPlan, outputDuration },
      removalsByKind,
      chapters: normalizedChapters,
      warnings,
      loudness: measured
        ? { measured, target: config.targetLufs, truePeak: config.truePeakDb }
        : null,
      metadata,
      files,
    }),
  );
  files.rapor = reportPath;

  jobState.chapters = normalizedChapters;
  jobState.warnings = warnings;
  jobState.metadata = metaJson;
  jobState.files = files;
  fs.writeFileSync(jobFile, JSON.stringify(jobState, null, 2));

  return { ...jobState, files, elapsedMs: Date.now() - started };
}
