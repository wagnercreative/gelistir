/**
 * Claude cagrilari: kurgu karari ve YouTube metadata uretimi.
 *
 * Iki istem var:
 *   1) planEdit      -> atilacak araliklar, bolumler, en iyi acilis (hook)
 *   2) writeMetadata -> baslik adaylari, aciklama, etiketler, kapak anlari
 *
 * Modelin dondurdugu hicbir zaman degeri dogrudan kullanilmaz; cutplan.js
 * ve youtube.js icindeki kurallardan gecer.
 */
import Anthropic from "@anthropic-ai/sdk";
import { transcriptToPromptText } from "./transcribe.js";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    removals: {
      type: "array",
      description: "Zaman cizgisinden atilacak araliklar (kaynak saniyeleri).",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          kind: {
            type: "string",
            enum: ["silence", "filler", "retake", "offtopic", "error", "deadair"],
          },
          reason: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["start", "end", "kind", "reason", "confidence"],
        additionalProperties: false,
      },
    },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time: { type: "number", description: "Kaynak zaman cizgisindeki saniye." },
          title: { type: "string" },
        },
        required: ["time", "title"],
        additionalProperties: false,
      },
    },
    hook: {
      type: "object",
      description: "Videonun basina tasinabilecek en guclu 5-15 saniyelik an.",
      properties: {
        start: { type: "number" },
        end: { type: "number" },
        why: { type: "string" },
      },
      required: ["start", "end", "why"],
      additionalProperties: false,
    },
    warnings: {
      type: "array",
      description: "Yayina engel olabilecek seyler: gurultu, tekrar, eksik bilgi, telaffuz hatasi.",
      items: { type: "string" },
    },
  },
  required: ["removals", "chapters", "warnings"],
  additionalProperties: false,
};

const METADATA_SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      description: "3-5 baslik adayi, en iyisi basta. Her biri en fazla 100 karakter.",
      items: { type: "string" },
    },
    description: {
      type: "string",
      description: "Aciklamanin ust kismi. Bolum listesi SONRADAN eklenecek, sen ekleme.",
    },
    tags: { type: "array", items: { type: "string" } },
    hashtags: { type: "array", items: { type: "string" } },
    pinned_comment: { type: "string" },
    thumbnail_moments: {
      type: "array",
      description: "Kapak fotografi icin uygun anlar (CIKTI zaman cizgisi saniyeleri).",
      items: {
        type: "object",
        properties: {
          time: { type: "number" },
          why: { type: "string" },
        },
        required: ["time", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["titles", "description", "tags", "hashtags", "thumbnail_moments"],
  additionalProperties: false,
};

const PLAN_SYSTEM = `Sen deneyimli bir YouTube kurgucususun. Elinde tek bir cekimin
zaman damgali dokumu var. Gorevin, videoyu yayina hazir hale getirecek kesim planini
cikarmak.

Kurallar:
- Zaman degerleri HER ZAMAN dokumdeki mutlak kaynak saniyeleri olacak. Uydurma.
- Sadece dokumde gerekcesi gorunen araliklari at. Emin olmadigin yeri atma.
- "retake": konusmaci ayni cumleye yeniden baslamis; ONCEKI denemeleri at, en iyi/son
  denemeyi tut.
- "filler": anlam katmayan dolgu ("eee", "iste", "yani", "hani", "şey") ve bogaz temizleme.
  Cumlenin akisini bozacaksa dokunma.
- "error": yanlis bilgi verip duzelttigi yerlerde yanlis olan kismi at.
- Cumle ortasindan kesme; kesim noktalari cumle veya nefes sinirinda olsun.
- Toplamda surenin buyuk kismini atmaya calismak yerine gercekten gereksiz olani at.
- Bolumler (chapters) izleyicinin arayacagi basliklar olsun, "Giris/Gelisme/Sonuc" degil.
  Her bolum en az 10 saniye surmeli ve ilki 0 olmali.
- Basliklar ve gerekceler dokumun dilinde olsun.

Yanit yalnizca istenen JSON semasinda olacak.`;

const METADATA_SYSTEM = `Sen YouTube'da is yapan bir icerik stratejistisin. Elinde yayina
hazir bir videonun dokumu ve bolum listesi var. Gorevin video sayfasinin metinlerini yazmak.

Kurallar:
- Baslik: 100 karakteri gecmeyecek, clickbait degil ama merak uyandiran; videoda gercekten
  olan seyi soyleyecek. Buyuk harfle bagirma.
- Aciklama: ilk iki satir arama ve onizlemede gorunur, en onemli bilgi orada olsun.
  Bolum listesini EKLEME, sistem sonradan ekliyor.
- Etiketler: 10-15 tane, arama niyetine uygun, tekrarsiz.
- Hashtag: en fazla 3.
- Sabitlenmis yorum: izleyiciyi yoruma davet eden tek bir soru.
- Kapak anlari: yuz/ifade/ekran gosteriminin guclu oldugu, CIKTI zaman cizgisindeki saniyeler.
- Metinler dokumun dilinde olsun.

Yanit yalnizca istenen JSON semasinda olacak.`;

export function createClient(apiKey = "") {
  return apiKey ? new Anthropic({ apiKey }) : new Anthropic();
}

/** Semali, akisli istek. Refusal fallback desteklenmiyorsa bir kez sade halde tekrarlar. */
async function requestJson(client, { model, effort, system, user, schema, maxTokens = 32000 }) {
  const base = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: {
      effort,
      format: { type: "json_schema", schema },
    },
  };

  let message;
  try {
    const stream = client.beta.messages.stream({
      ...base,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
    });
    message = await stream.finalMessage();
  } catch (err) {
    const status = err?.status ?? err?.statusCode;
    if (status !== 400 && status !== 404) throw err;
    // Sunucu tarafli refusal fallback bu hesapta/surumde yok: sade istekle devam.
    const stream = client.messages.stream(base);
    message = await stream.finalMessage();
  }

  if (message.stop_reason === "refusal") {
    const detail = message.stop_details?.explanation || message.stop_details?.category || "";
    throw new Error(`Model istegi reddetti (${detail}). Icerigi gozden gecir.`);
  }

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error("Model bos yanit dondu.");
  try {
    return { data: JSON.parse(text), usage: message.usage };
  } catch {
    throw new Error(`Model gecerli JSON dondurmedi. Ilk 500 karakter:\n${text.slice(0, 500)}`);
  }
}

/** Dokumu karakter butcesine gore pencerelere boler (kirpma yok, bolme var). */
export function chunkSegments(segments, maxChars = 120000) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const s of segments) {
    const line = `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}\n`;
    if (size + line.length > maxChars && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += line.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Kesim planini uretir. Uzun dokumler pencerelere bolunur ve sonuclar birlestirilir.
 */
export async function planEdit({
  client,
  transcript,
  silences = [],
  duration,
  options = {},
  onProgress = null,
}) {
  const { model = "claude-opus-5", effort = "high" } = options;
  const chunks = chunkSegments(transcript.segments, 120000);
  const removals = [];
  const chapters = [];
  const warnings = [];
  let hook = null;
  const usages = [];

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) {
      onProgress(`Kurgu plani (${i + 1}/${chunks.length}) hazirlaniyor`);
    }
    const window = { segments: chunks[i] };
    const windowStart = chunks[i][0].start;
    const windowEnd = chunks[i][chunks[i].length - 1].end;
    const { text } = transcriptToPromptText(window);

    const relevantSilences = silences
      .filter((s) => s.end > windowStart && s.start < windowEnd)
      .map((s) => `${s.start.toFixed(2)}-${s.end.toFixed(2)}`)
      .join(", ");

    const user = [
      `Kaynak suresi: ${duration.toFixed(2)} saniye.`,
      chunks.length > 1
        ? `Bu, dokumun ${i + 1}/${chunks.length} numarali penceresi ` +
          `(${windowStart.toFixed(2)}-${windowEnd.toFixed(2)} sn). Sadece bu araliktaki ` +
          `kesimleri ve bolumleri bildir.`
        : "",
      options.removeFillers === false ? "Dolgu sozcuklerini ATMA." : "",
      options.removeRetakes === false ? "Tekrar cekimleri ATMA." : "",
      options.removeOffTopic ? "Konu disi bolumleri de atabilirsin." : "Konu disi bolumleri ATMA.",
      relevantSilences
        ? `Otomatik algilanan sessizlikler (bunlari tekrar bildirmene gerek yok): ${relevantSilences}`
        : "",
      "",
      "Dokum:",
      text,
    ]
      .filter(Boolean)
      .join("\n");

    const { data, usage } = await requestJson(client, {
      model,
      effort,
      system: PLAN_SYSTEM,
      user,
      schema: PLAN_SCHEMA,
    });
    usages.push(usage);

    for (const r of data.removals || []) {
      const start = Number(r.start);
      const end = Number(r.end);
      // Pencere disi ve gecersiz zamanlar atilir: model uydurmus olabilir.
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      if (end < windowStart - 1 || start > windowEnd + 1) continue;
      if (start < 0 || end > duration) continue;
      if (r.kind === "filler" && options.removeFillers === false) continue;
      if (r.kind === "retake" && options.removeRetakes === false) continue;
      if (r.kind === "offtopic" && !options.removeOffTopic) continue;
      removals.push({
        start,
        end,
        kind: r.kind,
        reason: r.reason,
        confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0.5)),
      });
    }
    for (const c of data.chapters || []) {
      const time = Number(c.time);
      if (Number.isFinite(time) && time >= 0 && time <= duration && c.title) {
        chapters.push({ time, title: String(c.title).trim() });
      }
    }
    if (Array.isArray(data.warnings)) warnings.push(...data.warnings.map(String));
    if (!hook && data.hook && Number.isFinite(Number(data.hook.start))) {
      hook = {
        start: Number(data.hook.start),
        end: Number(data.hook.end),
        why: String(data.hook.why || ""),
      };
    }
  }

  return { removals, chapters, warnings, hook, usages };
}

/** Baslik / aciklama / etiket / kapak anlarini uretir. */
export async function writeMetadata({
  client,
  transcript,
  chapters = [],
  outputDuration,
  options = {},
  onProgress = null,
}) {
  const { model = "claude-opus-5", effort = "high" } = options;
  if (onProgress) onProgress("YouTube metinleri yaziliyor");

  // Metadata icin tum dokum gerekli degil; yeterince genis bir ozet penceresi kullaniyoruz.
  const chunks = chunkSegments(transcript.segments, 150000);
  const { text } = transcriptToPromptText({ segments: chunks[0] });
  const partial = chunks.length > 1;

  const user = [
    `Yayina hazir video suresi: ${outputDuration.toFixed(0)} saniye.`,
    chapters.length
      ? `Bolumler:\n${chapters.map((c) => `${c.time.toFixed(0)}s ${c.title}`).join("\n")}`
      : "Bolum listesi yok.",
    partial ? "(Dokumun ilk bolumu veriliyor; genel cerceve icin yeterli.)" : "",
    "",
    "Dokum:",
    text,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, usage } = await requestJson(client, {
    model,
    effort,
    system: METADATA_SYSTEM,
    user,
    schema: METADATA_SCHEMA,
    maxTokens: 16000,
  });

  return {
    titles: (data.titles || []).map(String).filter(Boolean),
    description: String(data.description || ""),
    tags: (data.tags || []).map(String),
    hashtags: (data.hashtags || []).map(String),
    pinnedComment: String(data.pinned_comment || ""),
    thumbnailMoments: (data.thumbnail_moments || [])
      .map((t) => ({ time: Number(t.time), why: String(t.why || "") }))
      .filter((t) => Number.isFinite(t.time) && t.time >= 0 && t.time < outputDuration),
    usage,
  };
}
