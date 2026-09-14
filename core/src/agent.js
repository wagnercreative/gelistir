/**
 * Ajan modu: Premiere icinde sohbet ederek is yaptirma.
 *
 * Claude'un Chrome eklentisinin tarayicida yaptigi seyi Premiere'de yapar:
 * sen ne istedigini yazarsin, model once bakar (proje, sequence, dokum),
 * sonra arac cagirarak is yapar, sonucu okur ve devam eder.
 *
 * Araclar iki yerde kosar:
 *   executor: "core" -> burada, Node tarafinda (ffmpeg, whisper, paketleme)
 *   executor: "host" -> Premiere'de, panel evalScript ile calistirir
 *
 * Cekirdek kendi araclarini hemen kosar; Premiere araclarini panele dondurur,
 * panel calistirip sonucu geri gonderir. Yikici araclar once kullanicidan
 * onay ister.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";

import * as ff from "./ffmpeg.js";
import { buildCutPlan } from "./cutplan.js";
import { detectWhisper, transcribe, flattenWords, parseSrt } from "./transcribe.js";
import { runPipeline } from "./pipeline.js";
import { createClient } from "./claude.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const COMPACT_BETA = "compact-2026-01-12";

/** Model yanitlarinin baglami sismesin diye ust sinirlar. */
const MAX_SILENCE_ROWS = 120;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_KEEP_ROWS = 40;

export const SYSTEM_PROMPT = `Sen Premiere Pro icinde calisan bir kurgu asistanisin.
Kullanici seninle sohbet ediyor; sen arac cagirarak gercek isi yapiyorsun.

Nasil calisirsin:
- Once BAK, sonra yap. Zaman cizgisini ve dokumu okumadan kesim yapmaya kalkma.
- Dokumun tamamini bir kerede isteme. media_transcribe'dan sonra transcript_read
  ile pencere pencere oku; hangi araligi neden okudugunu bil.
- Kesim yapacaksan once build_cut_plan cagir. O arac senin onerilerini guvenlik
  kurallarindan gecirir (kelime sinirina hizalama, nefes payi, en fazla %35
  atma) ve sana bir planId verir. Sonra premiere_apply_keeps ile o plani
  uygula; plan YENI bir sequence olarak kurulur, orijinale dokunulmaz.
- Bir seyi silmek yerine mumkunse premiere_set_clip_enabled ile devre disi
  birak: geri alinabilir.
- Yikici araclar (klip silme, kirpma, export, paketleme) kullanicidan onay
  ister. Onay istemeden once ne yapacagini tek cumleyle soyle.
- Bir arac hata dondurdugunde nedenini oku ve duzelt; ayni cagriyi aynen
  tekrarlama.

Kesim olcutu:
- sessizlik ve olu hava
- anlam katmayan dolgu sozcukleri ("eee", "yani", "hani", "sey")
- ayni cumlenin tekrar cekimleri (en iyi/son denemeyi tut)
- konusmacinin verip sonra duzelttigi yanlis bilgi
Konu disi bolumleri kullanici acikca istemedikce atma.

Yayina hazirlik:
- YouTube bolumleri aciklamadan okunur; ilk bolum 0:00, en az 3 bolum, her
  bolum en az 10 saniye. Bunlari deliver_youtube_package sana dogrulayarak
  yaziyor, sen sadece anlamli bolum onerisi ver.
- Baslik 100 karakteri gecmez. Aciklamanin ilk iki satiri en onemli bilgi olsun.
- Yayinlama dugmesine BASMA ve basabilecegini soyleme; paket "private" olarak
  isaretlenir, yayin karari kullanicinin.

Kullanicinin dilinde, kisa ve somut konus. Ne yaptigini ve ne bulduğunu soyle;
arac ciktilarini oldugu gibi dokme.`;

// ---------------------------------------------------------------- arac tablosu

/**
 * Her aracin: API semasi + nerede kosacagi + onay gerekip gerekmedigi.
 * host araclari icin hostFn/hostArgs, ExtendScript cagrisini kurar.
 */
export const TOOL_SPECS = [
  // ------------------------------------------------ Premiere: okuma
  {
    name: "premiere_get_project",
    readOnly: true,
    executor: "host",
    approval: false,
    description:
      "Acik Premiere projesini ve icindeki sequence listesini dondurur " +
      "(ad, sure, hangisi aktif). Ise baslarken nerede oldugunu anlamak icin.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    hostFn: "gelistirGetProject",
    hostArgs: () => [],
  },
  {
    name: "premiere_get_sequence",
    readOnly: true,
    executor: "host",
    approval: false,
    description:
      "Bir sequence'in zaman cizgisini dondurur: her kanaldaki klipler " +
      "(index, ad, start, end, inPoint, outPoint, kaynak dosya, devre disi mi) " +
      "ve markerlar. Klip index'leri duzenleme araclarinda kullanilir.",
    input_schema: {
      type: "object",
      properties: {
        sequenceName: {
          type: "string",
          description: "Bos birakilirsa aktif sequence okunur.",
        },
      },
      required: ["sequenceName"],
      additionalProperties: false,
    },
    hostFn: "gelistirGetSequence",
    hostArgs: (input) => [input.sequenceName || "", ""],
  },
  {
    name: "premiere_get_primary_source",
    readOnly: true,
    executor: "host",
    approval: false,
    description:
      "Aktif sequence'teki ilk video klibin kaynak medya dosyasinin yolunu " +
      "dondurur. Dokum ve sessizlik analizi bu dosya uzerinde yapilir.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    hostFn: "gelistirPrimarySource",
    hostArgs: () => [],
  },

  // ------------------------------------------------ Premiere: duzenleme
  {
    name: "premiere_apply_keeps",
    executor: "host",
    approval: false,
    description:
      "build_cut_plan'dan gelen plani uygular: tutulacak parcalari sirayla " +
      "YENI bir sequence'e dizer. Orijinal sequence'e dokunmaz, bu yuzden " +
      "geri alinabilir ve onay istemez.",
    input_schema: {
      type: "object",
      properties: {
        planId: { type: "string", description: "build_cut_plan'in dondurdugu planId." },
        sourcePath: { type: "string", description: "Kaynak medya dosyasinin yolu." },
        newSequenceName: { type: "string" },
      },
      required: ["planId", "sourcePath", "newSequenceName"],
      additionalProperties: false,
    },
    hostFn: "gelistirApplyKeeps",
    hostArgs: (input, session) => {
      const plan = session.cutPlans[input.planId];
      if (!plan) {
        throw new Error(
          `planId bulunamadi: ${input.planId}. Once build_cut_plan cagir.`,
        );
      }
      return [plan.keepsText, input.sourcePath, input.newSequenceName];
    },
  },
  {
    name: "premiere_set_clip_enabled",
    executor: "host",
    approval: false,
    description:
      "Klibi devre disi birakir veya geri acar. Silmenin geri alinabilir " +
      "alternatifi; bir parcayi cikarmak istiyorsan once bunu dene.",
    input_schema: {
      type: "object",
      properties: {
        trackType: { type: "string", enum: ["video", "audio"] },
        trackIndex: { type: "integer" },
        clipIndex: { type: "integer" },
        enabled: { type: "boolean" },
      },
      required: ["trackType", "trackIndex", "clipIndex", "enabled"],
      additionalProperties: false,
    },
    hostFn: "gelistirSetClipEnabled",
    hostArgs: (i) => [i.trackType, i.trackIndex, i.clipIndex, i.enabled],
  },
  {
    name: "premiere_delete_clip",
    executor: "host",
    approval: true,
    description:
      "Bir klibi zaman cizgisinden siler. ripple=true ise sonraki klipler " +
      "sola kayar. Geri alinamaz (Premiere'de Ctrl+Z gerekir). Once " +
      "premiere_set_clip_enabled'i degerlendir.",
    input_schema: {
      type: "object",
      properties: {
        trackType: { type: "string", enum: ["video", "audio"] },
        trackIndex: { type: "integer" },
        clipIndex: { type: "integer" },
        ripple: { type: "boolean" },
      },
      required: ["trackType", "trackIndex", "clipIndex", "ripple"],
      additionalProperties: false,
    },
    hostFn: "gelistirDeleteClip",
    hostArgs: (i) => [i.trackType, i.trackIndex, i.clipIndex, i.ripple],
  },
  {
    name: "premiere_trim_clip",
    executor: "host",
    approval: true,
    description:
      "Klibin kaynak in/out noktalarini degistirir (saniye). Sadece " +
      "degistirmek istedigin ucu ver; digerini bos birak.",
    input_schema: {
      type: "object",
      properties: {
        trackType: { type: "string", enum: ["video", "audio"] },
        trackIndex: { type: "integer" },
        clipIndex: { type: "integer" },
        inPoint: { type: "string", description: "Saniye, veya bos birak." },
        outPoint: { type: "string", description: "Saniye, veya bos birak." },
      },
      required: ["trackType", "trackIndex", "clipIndex", "inPoint", "outPoint"],
      additionalProperties: false,
    },
    hostFn: "gelistirTrimClip",
    hostArgs: (i) => [i.trackType, i.trackIndex, i.clipIndex, i.inPoint, i.outPoint],
  },
  {
    name: "premiere_set_clip_gain",
    executor: "host",
    approval: false,
    description:
      "Ses klibinin kazancini dB olarak ayarlar (en fazla +15). Premiere'in " +
      "Level parametresi normalize oldugu icin esleme yaklasiktir; yayin " +
      "gurlugu paketleme sirasindaki loudnorm ile belirlenir. Bunu sadece " +
      "klipler arasi bariz seviye farkini duzeltmek icin kullan.",
    input_schema: {
      type: "object",
      properties: {
        trackIndex: { type: "integer" },
        clipIndex: { type: "integer" },
        gainDb: { type: "number" },
      },
      required: ["trackIndex", "clipIndex", "gainDb"],
      additionalProperties: false,
    },
    hostFn: "gelistirSetClipGain",
    hostArgs: (i) => [i.trackIndex, i.clipIndex, i.gainDb],
  },
  {
    name: "premiere_add_markers",
    executor: "host",
    approval: false,
    description:
      "Zaman cizgisine isaret (marker) koyar - kurgucunun gezinmesi icin. " +
      "YouTube bolumleri bunlardan degil, aciklamadan okunur.",
    input_schema: {
      type: "object",
      properties: {
        markers: {
          type: "array",
          items: {
            type: "object",
            properties: { time: { type: "number" }, title: { type: "string" } },
            required: ["time", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["markers"],
      additionalProperties: false,
    },
    hostFn: "gelistirAddMarkers",
    hostArgs: (i) =>
      [
        (i.markers || [])
          .map((m) => `${Number(m.time).toFixed(3)}|${String(m.title).replace(/[;|]/g, " ")}`)
          .join(";"),
      ],
  },
  {
    name: "premiere_set_playhead",
    executor: "host",
    approval: false,
    description:
      "Oynatma kafasini verilen saniyeye tasir. Kullaniciya bir yeri " +
      "gostermek icin ('sorun burada') kullanisli.",
    input_schema: {
      type: "object",
      properties: { seconds: { type: "number" } },
      required: ["seconds"],
      additionalProperties: false,
    },
    hostFn: "gelistirSetPlayhead",
    hostArgs: (i) => [i.seconds],
  },
  {
    name: "premiere_export_sequence",
    executor: "host",
    approval: true,
    description:
      "Aktif sequence'i Adobe Media Encoder'a gonderir ve master dosya " +
      "uretir. Kodlama arka planda surer; dosya hazir olunca kullanici sana " +
      "soyler. Sonrasinda deliver_youtube_package ile yayina hazir paket kurulur.",
    input_schema: {
      type: "object",
      properties: {
        outputPath: { type: "string" },
        presetPath: { type: "string", description: "Premiere'den kaydedilmis .epr yolu." },
      },
      required: ["outputPath", "presetPath"],
      additionalProperties: false,
    },
    hostFn: "gelistirExportSequence",
    hostArgs: (i) => [i.outputPath, i.presetPath],
  },

  // ------------------------------------------------ Cekirdek araclari
  {
    name: "media_probe",
    readOnly: true,
    executor: "core",
    approval: false,
    description: "Medya dosyasinin suresini, cozunurlugunu, fps'ini ve ses akisini okur.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "media_transcribe",
    executor: "core",
    approval: false,
    description:
      "Dosyayi whisper ile yaziya cevirir ve dokumu oturumda saklar. " +
      "Dokumun kendisini DONDURMEZ (baglami sisirmemek icin); ozet bilgi ve " +
      "ilk satirlari dondurur. Icerigi transcript_read ile pencere pencere oku. " +
      "srtPath verilirse whisper yerine o dosya kullanilir.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        language: { type: "string", description: "Bos = otomatik algila." },
        srtPath: { type: "string", description: "Hazir dokum; bos birakilabilir." },
      },
      required: ["path", "language", "srtPath"],
      additionalProperties: false,
    },
  },
  {
    name: "media_detect_silence",
    readOnly: true,
    executor: "core",
    approval: false,
    description:
      "ffmpeg ile sessizlik araliklarini bulur. Esikler kullanicinin " +
      "ayarlarindan gelir; sen bunlari tekrar kesim onerisi olarak bildirme, " +
      "build_cut_plan zaten sessizlikleri de alir.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "transcript_read",
    readOnly: true,
    executor: "core",
    approval: false,
    description:
      "Saklanan dokumun bir zaman penceresini dondurur. Uzun videolarda " +
      "bastan sona parca parca oku.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "media_transcribe'da kullanilan dosya yolu." },
        startSeconds: { type: "number" },
        endSeconds: { type: "number" },
      },
      required: ["path", "startSeconds", "endSeconds"],
      additionalProperties: false,
    },
  },
  {
    name: "build_cut_plan",
    readOnly: true,
    executor: "core",
    approval: false,
    description:
      "Atilmasini onerdigin araliklari guvenlik kurallarindan gecirir ve " +
      "uygulanabilir bir plan uretir: kelime sinirina hizalama, nefes payi, " +
      "kisa parca temizligi ve en fazla %35 atma butcesi. Butceyi asan " +
      "oneriler reddedilir ve sana bildirilir. Donen planId'yi " +
      "premiere_apply_keeps ve deliver_youtube_package'e verirsin. " +
      "Sessizlikleri kendisi ekler, sen sadece icerik kesimlerini bildir.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        removals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              kind: {
                type: "string",
                enum: ["filler", "retake", "offtopic", "error", "deadair", "silence"],
              },
              reason: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["start", "end", "kind", "reason", "confidence"],
            additionalProperties: false,
          },
        },
        includeSilence: {
          type: "boolean",
          description: "Algilanan sessizlikler de atilsin mi (genelde true).",
        },
      },
      required: ["path", "removals", "includeSilence"],
      additionalProperties: false,
    },
  },
  {
    name: "deliver_youtube_package",
    executor: "core",
    approval: true,
    description:
      "Yayina hazir paketi yazar: kesim + altyazi + -14 LUFS gurluk + H.264 " +
      "kodlama + kapak adaylari + metadata.json + rapor. Metinleri sen " +
      "veriyorsun; YouTube sinirlari (baslik 100, aciklama 5000, etiket 500 " +
      "karakter, bolum kurallari) kod tarafinda dogrulanip duzeltilir. " +
      "masterPath verirsen Premiere'den cikmis master kullanilir, vermezsen " +
      "kaynak dosya dogrudan kesilir.",
    input_schema: {
      type: "object",
      properties: {
        sourcePath: { type: "string", description: "Analiz edilen kaynak dosya." },
        masterPath: {
          type: "string",
          description: "Premiere/AME master dosyasi; yoksa bos birak.",
        },
        planId: { type: "string", description: "build_cut_plan planId'si." },
        outDir: { type: "string", description: "Paket dizini; bos birakilirsa yanina yazilir." },
        title: { type: "string" },
        description: { type: "string", description: "Bolum listesini EKLEME, kod ekliyor." },
        tags: { type: "array", items: { type: "string" } },
        hashtags: { type: "array", items: { type: "string" } },
        chapters: {
          type: "array",
          items: {
            type: "object",
            properties: { time: { type: "number" }, title: { type: "string" } },
            required: ["time", "title"],
            additionalProperties: false,
          },
        },
        pinnedComment: { type: "string" },
      },
      required: [
        "sourcePath", "masterPath", "planId", "outDir",
        "title", "description", "tags", "hashtags", "chapters", "pinnedComment",
      ],
      additionalProperties: false,
    },
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.name, s]));

/** API'ye gonderilecek arac tanimlari (ic alanlar cikarilir). */
export function apiTools() {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.input_schema,
    strict: true,
  }));
}

export function toolSpec(name) {
  return SPEC_BY_NAME.get(name) || null;
}

export function needsApproval(name) {
  const spec = SPEC_BY_NAME.get(name);
  return Boolean(spec && spec.approval);
}

// ---------------------------------------------------------------- cekirdek araclari

function cap(list, limit) {
  return list.length > limit
    ? { rows: list.slice(0, limit), truncated: list.length - limit }
    : { rows: list, truncated: 0 };
}

const CORE_EXECUTORS = {
  async media_probe(input, session) {
    const info = await ff.probe(session.config.ffprobe, input.path);
    session.probes[input.path] = info;
    return {
      path: input.path,
      duration: Number(info.duration.toFixed(3)),
      hasVideo: info.hasVideo,
      hasAudio: info.hasAudio,
      video: info.video,
      audio: info.audio,
    };
  },

  async media_transcribe(input, session) {
    const { config } = session;
    if (input.srtPath) {
      const fs = await import("node:fs");
      if (!fs.existsSync(input.srtPath)) throw new Error(`Dokum yok: ${input.srtPath}`);
      session.transcripts[input.path] = parseSrt(fs.readFileSync(input.srtPath, "utf8"));
    } else {
      const bin = await detectWhisper(config.whisper);
      if (!bin) {
        throw new Error(
          "whisper bulunamadi. Kullaniciya soyle: `gelistir doctor` ile kurulumu " +
            "kontrol etsin, ya da hazir bir .srt dosyasi versin (srtPath).",
        );
      }
      const os = await import("node:os");
      session.transcripts[input.path] = await transcribe({
        bin,
        audioPath: input.path,
        model: config.whisperModel,
        language: input.language || config.language,
        workDir: os.tmpdir(),
      });
    }

    const transcript = session.transcripts[input.path];
    if (!transcript.segments.length) throw new Error("Dokum bos cikti; ses akisini kontrol et.");
    const last = transcript.segments[transcript.segments.length - 1];
    const preview = transcript.segments
      .slice(0, 5)
      .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`)
      .join("\n");

    return {
      path: input.path,
      language: transcript.language || "bilinmiyor",
      segments: transcript.segments.length,
      hasWordTimings: flattenWords(transcript).length > 0,
      coverage: { start: transcript.segments[0].start, end: last.end },
      preview,
      note: "Icerigi transcript_read ile pencere pencere oku.",
    };
  },

  async media_detect_silence(input, session) {
    const { config } = session;
    const probeInfo = session.probes[input.path] || (await ff.probe(config.ffprobe, input.path));
    session.probes[input.path] = probeInfo;

    const res = await ff
      .run(config.ffmpeg, ff.silenceDetectArgs(input.path, config))
      .catch((err) => (err.stderr ? { stderr: err.stderr } : Promise.reject(err)));
    const ranges = ff.parseSilenceDetect(res.stderr, probeInfo.duration);
    session.silences[input.path] = ranges;

    const { rows, truncated } = cap(ranges, MAX_SILENCE_ROWS);
    const total = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
    return {
      path: input.path,
      count: ranges.length,
      totalSeconds: Number(total.toFixed(2)),
      thresholds: { minSilence: config.minSilence, noiseDb: config.silenceThresholdDb },
      ranges: rows.map((r) => [Number(r.start.toFixed(2)), Number(r.end.toFixed(2))]),
      truncated,
    };
  },

  async transcript_read(input, session) {
    const transcript = session.transcripts[input.path];
    if (!transcript) throw new Error(`Bu dosya icin dokum yok: ${input.path}. Once media_transcribe cagir.`);

    const start = Number(input.startSeconds) || 0;
    const end = Number(input.endSeconds);
    const window = transcript.segments.filter(
      (s) => s.end > start && (!Number.isFinite(end) || s.start < end),
    );

    let text = "";
    let lastIncluded = null;
    for (const s of window) {
      const line = `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}\n`;
      if (text.length + line.length > MAX_TRANSCRIPT_CHARS) break;
      text += line;
      lastIncluded = s;
    }

    const covered = lastIncluded ? lastIncluded.end : start;
    const more = window.length && lastIncluded !== window[window.length - 1];
    return {
      path: input.path,
      requested: { start, end: Number.isFinite(end) ? end : null },
      returnedUntil: Number(covered.toFixed(2)),
      text: text || "(bu aralikta konusma yok)",
      more,
      note: more ? `Devami icin startSeconds=${covered.toFixed(2)} ile tekrar cagir.` : "",
    };
  },

  async build_cut_plan(input, session) {
    const { config } = session;
    const probeInfo = session.probes[input.path] || (await ff.probe(config.ffprobe, input.path));
    session.probes[input.path] = probeInfo;

    let silences = [];
    if (input.includeSilence !== false) {
      if (!session.silences[input.path]) {
        await CORE_EXECUTORS.media_detect_silence({ path: input.path }, session);
      }
      silences = session.silences[input.path] || [];
    }

    const proposed = (input.removals || []).filter((r) => {
      const start = Number(r.start);
      const end = Number(r.end);
      return Number.isFinite(start) && Number.isFinite(end) && end > start &&
        start >= 0 && end <= probeInfo.duration;
    });
    const dropped = (input.removals || []).length - proposed.length;

    const transcript = session.transcripts[input.path];
    const plan = buildCutPlan({
      duration: probeInfo.duration,
      removals: [...silences, ...proposed],
      words: transcript ? flattenWords(transcript) : null,
      options: config,
    });

    const planId = `plan-${Object.keys(session.cutPlans).length + 1}`;
    const keepsText = plan.keeps
      .map((k) => `${k.start.toFixed(3)},${k.end.toFixed(3)}`)
      .join(";");
    session.cutPlans[planId] = { ...plan, keepsText, sourcePath: input.path };

    const { rows, truncated } = cap(plan.keeps, MAX_KEEP_ROWS);
    return {
      planId,
      sourceDuration: Number(plan.sourceDuration.toFixed(2)),
      outputDuration: Number(plan.outputDuration.toFixed(2)),
      removedSeconds: Number(plan.removedSeconds.toFixed(2)),
      removedPercent: Number((plan.removedRatio * 100).toFixed(1)),
      segments: plan.keeps.length,
      cuts: Math.max(0, plan.keeps.length - 1),
      keepsPreview: rows.map((k) => [Number(k.start.toFixed(2)), Number(k.end.toFixed(2))]),
      keepsTruncated: truncated,
      silencesIncluded: silences.length,
      proposalsDroppedAsInvalid: dropped,
      rejectedByBudget: plan.rejected.length,
      budgetNote:
        plan.rejected.length > 0
          ? `Butce (%${(config.maxRemovedRatio * 100).toFixed(0)}) doldu; ` +
            `${plan.rejected.length} oneri uygulanmadi. Kullanici isterse ` +
            "`gelistir config maxRemovedRatio=...` ile artirabilir."
          : "",
    };
  },

  async deliver_youtube_package(input, session) {
    const { config } = session;
    const plan = input.planId ? session.cutPlans[input.planId] : null;
    if (input.planId && !plan) throw new Error(`planId bulunamadi: ${input.planId}`);

    const source = input.sourcePath || plan?.sourcePath;
    if (!source) throw new Error("sourcePath veya gecerli bir planId gerekli");

    const usingMaster = Boolean(input.masterPath);
    const inputFile = usingMaster ? input.masterPath : source;
    const outDir =
      input.outDir ||
      path.join(
        path.dirname(source),
        `${path.basename(source, path.extname(source))}-youtube`,
      );

    const result = await runPipeline({
      input: inputFile,
      outDir,
      mode: usingMaster ? "deliver" : "deliver-source",
      state: {
        transcript: session.transcripts[source] || { language: "", segments: [] },
        cutPlan: plan || null,
      },
      config,
      apiKey: session.apiKey,
      metadataOverride: {
        titles: [input.title].filter(Boolean),
        description: input.description || "",
        tags: input.tags || [],
        hashtags: input.hashtags || [],
        pinnedComment: input.pinnedComment || "",
        chapters: input.chapters || [],
      },
      onEvent: (e) => session.log.push({ role: "progress", text: `${e.label}${e.detail ? ": " + e.detail : ""}`, at: Date.now() }),
    });

    return {
      bundleDir: result.bundleDir,
      files: result.files,
      title: result.metadata?.title,
      chaptersWritten: result.metadata?.chapters?.length || 0,
      tagsWritten: result.metadata?.tags?.length || 0,
      durationSeconds: result.metadata?.durationSeconds,
      warnings: result.warnings || [],
      privacyStatus: result.metadata?.privacyStatus,
      note:
        "Paket hazir ve 'private' olarak isaretli. Yayinlama karari kullanicinin; " +
        "Chrome eklentisi bu metinleri YouTube Studio'ya doldurabilir.",
    };
  },
};

export function coreToolNames() {
  return Object.keys(CORE_EXECUTORS);
}

// ---------------------------------------------------------------- arac yurutme

/**
 * Araclarin paylastigi durum: dokumler, planlar, olcumler ve Premiere koprusu.
 *
 * Hem ajan oturumu (panel sohbeti) hem MCP istemcileri (Claude Code) ayni
 * durumu kullanir; boylece Claude Code'da cikarilan dokum panelde de gecerli.
 */
export function createToolState({ config, apiKey = "", bridge = null } = {}) {
  return {
    config,
    apiKey,
    bridge,
    probes: {},
    transcripts: {},
    silences: {},
    cutPlans: {},
    log: [],
  };
}

export function isCoreTool(name) {
  return Object.prototype.hasOwnProperty.call(CORE_EXECUTORS, name);
}

export async function runCoreTool(name, input, state) {
  if (!isCoreTool(name)) throw new Error(`Cekirdek araci degil: ${name}`);
  return CORE_EXECUTORS[name](input || {}, state);
}

/** Premiere araci: komutu kopruye koyar, panelin sonucunu bekler. */
export async function runHostTool(name, input, state) {
  const spec = toolSpec(name);
  if (!spec || spec.executor !== "host") throw new Error(`Premiere araci degil: ${name}`);
  if (!state.bridge) {
    throw new Error("Premiere koprusu kurulmamis; `gelistir serve` uzerinden calis.");
  }

  const args = spec.hostArgs(input || {}, state);
  const { content, isError } = await state.bridge.run({ fn: spec.hostFn, args, label: name });

  if (isError) {
    let message = content;
    try {
      message = JSON.parse(content).error || content;
    } catch {
      // ham metin; oldugu gibi kullan
    }
    throw new Error(message);
  }
  try {
    return JSON.parse(content);
  } catch {
    return { ok: true, raw: content };
  }
}

export async function runTool(name, input, state) {
  const spec = toolSpec(name);
  if (!spec) throw new Error(`Bilinmeyen arac: ${name}`);
  return spec.executor === "core"
    ? runCoreTool(name, input, state)
    : runHostTool(name, input, state);
}

// ---------------------------------------------------------------- oturum

export function createSession({ config, apiKey = "", client = null, state = null } = {}) {
  // Durum paylasilabilir: panel sohbeti ve Claude Code ayni dokum/plani gorsun.
  const shared = state || createToolState({ config, apiKey });
  return {
    ...shared,
    id: randomUUID().slice(0, 8),
    createdAt: new Date().toISOString(),
    client: client || createClient(apiKey),
    messages: [],
    log: shared.log,
    status: "idle",
    error: null,
    turn: null,
    pendingApproval: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Model cagri butcesi kullanicinin mesaji basina. Panel turlari arasinda
    // sifirlanmaz; yoksa host araci -> sonuc -> host araci dongusu hic bitmez.
    modelCalls: 0,
    maxModelCalls: 64,
    degraded: false,
  };
}

const okResult = (id, data) => ({
  type: "tool_result",
  tool_use_id: id,
  content: JSON.stringify(data),
});

const errResult = (id, message) => ({
  type: "tool_result",
  tool_use_id: id,
  content: String(message),
  is_error: true,
});

function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function recordUsage(session, usage) {
  if (!usage) return;
  session.usage.input += usage.input_tokens || 0;
  session.usage.output += usage.output_tokens || 0;
  session.usage.cacheRead += usage.cache_read_input_tokens || 0;
  session.usage.cacheWrite += usage.cache_creation_input_tokens || 0;
}

/**
 * Kimlik dogrulama hatalarini anlasilir mesaja cevirir.
 *
 * Anahtar SDK kurulumunda dogrulanmiyor (ve dogrulanmamali: kimlik bilgisi
 * ortam degiskeni yerine `ant auth login` profilinden de gelebilir), bu yuzden
 * eksiklik ilk istekte ortaya cikiyor.
 */
function translateAuthError(err) {
  const status = err?.status ?? err?.statusCode;
  const message = String(err?.message || "");
  if (status === 401 || status === 403 || /api[_ -]?key|authentication|credential/i.test(message)) {
    const friendly = new Error(
      "Claude kimlik dogrulamasi basarisiz. ANTHROPIC_API_KEY'i ayarla ya da " +
        "`ant auth login` ile giris yap, sonra `gelistir serve`i yeniden baslat.",
    );
    friendly.cause = err;
    return friendly;
  }
  return err;
}

async function callModel(session) {
  const base = {
    model: session.config.model,
    max_tokens: 32000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: apiTools(),
    messages: session.messages,
    output_config: { effort: session.config.effort },
  };

  try {
    const stream = session.client.beta.messages.stream({
      ...base,
      betas: [FALLBACK_BETA, COMPACT_BETA],
      fallbacks: "default",
      // Uzun oturumlarda gecmisi sunucu tarafinda ozetler. Asagida asistan
      // yanitinin TAMAMI (content) geri eklendigi icin compaction bloklari korunur.
      context_management: { edits: [{ type: "compact_20260112" }] },
    });
    return await stream.finalMessage();
  } catch (err) {
    const status = err?.status ?? err?.statusCode;
    if (status !== 400 && status !== 404) throw translateAuthError(err);
    // Beta ozellikleri bu hesapta/surumde yok: sade istekle devam.
    session.degraded = true;
    try {
      const stream = session.client.messages.stream(base);
      return await stream.finalMessage();
    } catch (plainErr) {
      throw translateAuthError(plainErr);
    }
  }
}

/**
 * Cozulebilecek arac cagrilarini cozer.
 *
 * Premiere araclari da burada beklenir: kopru komutu panele gonderir ve
 * sonucu bekler. Onay gerektiren bir arac karsilasilinca o arac atlanir,
 * kardesleri kosar ve tur "onay bekliyor" durumunda durur.
 *
 * @returns {Promise<boolean>} true ise kullanicinin onayi bekleniyor
 */
async function resolveTurn(session) {
  const turn = session.turn;
  const pendingApproval = [];

  for (const use of turn.toolUses) {
    if (turn.results.has(use.id)) continue;

    const spec = toolSpec(use.name);
    if (!spec) {
      turn.results.set(use.id, errResult(use.id, `Bilinmeyen arac: ${use.name}`));
      continue;
    }

    if (spec.approval) {
      const decision = turn.decisions.get(use.id);
      if (!decision) {
        pendingApproval.push({ id: use.id, name: use.name, input: use.input });
        continue;
      }
      if (decision === "deny") {
        turn.results.set(
          use.id,
          errResult(use.id, "Kullanici bu islemi onaylamadi. Baska bir yol oner veya sor."),
        );
        continue;
      }
    }

    session.status = spec.executor === "host" ? "awaiting_tools" : "thinking";
    session.runningTool = use.name;
    try {
      turn.results.set(use.id, okResult(use.id, await runTool(use.name, use.input || {}, session)));
    } catch (err) {
      turn.results.set(use.id, errResult(use.id, err.message || String(err)));
    }
    session.runningTool = null;
  }

  if (pendingApproval.length) {
    session.pendingApproval = pendingApproval;
    session.status = "awaiting_approval";
    return true;
  }
  session.pendingApproval = [];
  return false;
}

/** Model <-> arac dongusunu, bir duraga gelene kadar surer. */
async function drive(session) {
  for (;;) {
    if (!session.turn) {
      if (session.modelCalls >= session.maxModelCalls) {
        session.status = "error";
        session.error =
          `Bu istek ${session.maxModelCalls} model cagrisinda bitmedi; isi ` +
          "kucuk parcalara bolmeyi dene.";
        return session;
      }
      session.modelCalls++;
      session.status = "thinking";
      const message = await callModel(session);
      recordUsage(session, message.usage);
      session.messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "refusal") {
        const detail = message.stop_details?.explanation || message.stop_details?.category || "";
        session.status = "error";
        session.error = `Model istegi reddetti${detail ? ` (${detail})` : ""}.`;
        return session;
      }

      const text = textOf(message);
      if (text) session.log.push({ role: "assistant", text, at: Date.now() });

      const toolUses = (message.content || []).filter((b) => b.type === "tool_use");
      if (message.stop_reason === "pause_turn") continue; // modele devam et
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) {
        session.status = "end_turn";
        return session;
      }

      session.turn = { toolUses, results: new Map(), decisions: new Map() };
      session.log.push({
        role: "tools",
        calls: toolUses.map((u) => ({ name: u.name, input: u.input })),
        at: Date.now(),
      });
    }

    if (await resolveTurn(session)) return session;

    // Bir asistan mesajinin TUM tool_result'lari tek user mesajinda gitmeli.
    session.messages.push({
      role: "user",
      content: session.turn.toolUses.map((u) => session.turn.results.get(u.id)),
    });
    session.turn = null;
  }
}

// ---------------------------------------------------------------- dis arayuz

export async function sendMessage(session, text) {
  if (session.turn) {
    throw new Error("Onceki tur bitmedi: bekleyen arac sonucu veya onay var.");
  }
  const clean = String(text || "").trim();
  if (!clean) throw new Error("Bos mesaj");
  session.messages.push({ role: "user", content: clean });
  session.log.push({ role: "user", text: clean, at: Date.now() });
  session.error = null;
  session.modelCalls = 0; // butce her kullanici mesajinda yenilenir
  return drive(session);
}

/** decisions: { [toolUseId]: "allow" | "deny" } */
export async function resolveApprovals(session, decisions) {
  if (!session.turn) throw new Error("Onay bekleyen islem yok");
  for (const [id, decision] of Object.entries(decisions || {})) {
    if (decision !== "allow" && decision !== "deny") continue;
    if (!session.turn.toolUses.some((u) => u.id === id)) continue;
    session.turn.decisions.set(id, decision);
  }
  return drive(session);
}

/** Panele ve eklentiye gonderilen gorunum (client ve mesaj gecmisi haric). */
export function sessionView(session) {
  return {
    id: session.id,
    status: session.status,
    error: session.error,
    runningTool: session.runningTool || null,
    pendingApproval: session.pendingApproval.map((p) => ({
      ...p,
      approvalRequired: true,
      summary: toolSpec(p.name)?.description.split(".")[0] || p.name,
    })),
    log: session.log.slice(-80),
    usage: session.usage,
    degraded: session.degraded,
    plans: Object.keys(session.cutPlans),
    transcripts: Object.keys(session.transcripts),
    messageCount: session.messages.length,
  };
}
