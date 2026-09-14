import test from "node:test";
import assert from "node:assert/strict";
import { planEdit, writeMetadata, chunkSegments } from "../src/claude.js";

/**
 * Sahte Anthropic istemcisi. Ag cagrisi yapmadan istegin seklini ve
 * yanitin nasil budandigini dogrulamak icin.
 */
function stubClient(payloads, { betaStatus = null } = {}) {
  const calls = [];
  const queue = Array.isArray(payloads) ? [...payloads] : [payloads];

  const nextMessage = () => {
    const payload = queue.length > 1 ? queue.shift() : queue[0];
    if (payload && payload.__message) return payload.__message;
    return {
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  };

  const streamFor = (beta) => (params) => {
    calls.push({ beta, params });
    if (beta && betaStatus) {
      const err = new Error("beta desteklenmiyor");
      err.status = betaStatus;
      throw err;
    }
    return { finalMessage: async () => nextMessage() };
  };

  return {
    calls,
    beta: { messages: { stream: streamFor(true) } },
    messages: { stream: streamFor(false) },
  };
}

const TRANSCRIPT = {
  language: "tr",
  segments: [
    { start: 0, end: 4, text: "Merhaba arkadaslar bugun kurgu otomasyonu anlatiyorum" },
    { start: 4, end: 9, text: "Eee yani once kurulumu yapalim" },
    { start: 9, end: 20, text: "Simdi ayarlara geciyoruz" },
  ],
};

test("planEdit istegi sema ve model ayarlariyla gonderir", async () => {
  const client = stubClient({ removals: [], chapters: [], warnings: [] });
  await planEdit({
    client,
    transcript: TRANSCRIPT,
    silences: [{ start: 5, end: 6 }],
    duration: 20,
    options: { model: "claude-opus-5", effort: "high" },
  });

  assert.equal(client.calls.length, 1);
  const { params } = client.calls[0];
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.output_config.effort, "high");
  assert.equal(params.output_config.format.type, "json_schema");
  assert.equal(params.output_config.format.schema.type, "object");
  assert.ok(params.output_config.format.schema.properties.removals);
  // Sistem istemi onbellege alinir: cok pencereli islerde onemli
  assert.equal(params.system[0].cache_control.type, "ephemeral");
  // Dokum ve algilanan sessizlikler istemde; medya dosyasi yok
  assert.match(params.messages[0].content, /\[0\.00-4\.00\] Merhaba arkadaslar/);
  assert.match(params.messages[0].content, /5\.00-6\.00/);
});

test("planEdit gecersiz ve sinir disi zamanlari duser", async () => {
  const client = stubClient({
    removals: [
      { start: 4.2, end: 4.9, kind: "filler", reason: "eee", confidence: 0.9 },
      { start: 10, end: 9, kind: "filler", reason: "ters aralik", confidence: 0.9 },
      { start: -3, end: 2, kind: "silence", reason: "negatif", confidence: 0.9 },
      { start: 15, end: 900, kind: "silence", reason: "sureyi asiyor", confidence: 0.9 },
      { start: 1, end: 2, kind: "filler", reason: "gecerli", confidence: 5 },
    ],
    chapters: [
      { time: 0, title: "Giris" },
      { time: 999, title: "Sure disi" },
      { time: 9, title: "" },
    ],
    warnings: ["arka planda gurultu"],
  });

  const plan = await planEdit({
    client,
    transcript: TRANSCRIPT,
    duration: 20,
    options: {},
  });

  assert.deepEqual(
    plan.removals.map((r) => r.reason),
    ["eee", "gecerli"],
  );
  assert.equal(plan.removals[1].confidence, 1, "guven 0-1 arasina sikistirilir");
  assert.deepEqual(plan.chapters.map((c) => c.title), ["Giris"]);
  assert.deepEqual(plan.warnings, ["arka planda gurultu"]);
});

test("planEdit kapatilan kesim turlerini kabul etmez", async () => {
  const payload = {
    removals: [
      { start: 1, end: 2, kind: "filler", reason: "dolgu", confidence: 0.9 },
      { start: 3, end: 4, kind: "retake", reason: "tekrar", confidence: 0.9 },
      { start: 5, end: 6, kind: "offtopic", reason: "konu disi", confidence: 0.9 },
      { start: 7, end: 8, kind: "silence", reason: "sessizlik", confidence: 0.9 },
    ],
    chapters: [],
    warnings: [],
  };

  const strict = await planEdit({
    client: stubClient(payload),
    transcript: TRANSCRIPT,
    duration: 20,
    options: { removeFillers: false, removeRetakes: false },
  });
  assert.deepEqual(strict.removals.map((r) => r.kind), ["silence"], "offtopic varsayilan kapali");

  const loose = await planEdit({
    client: stubClient(payload),
    transcript: TRANSCRIPT,
    duration: 20,
    options: { removeOffTopic: true },
  });
  assert.deepEqual(loose.removals.map((r) => r.kind), ["filler", "retake", "offtopic", "silence"]);
});

test("planEdit uzun dokumu pencereler ve sonuclari birlestirir", async () => {
  const segments = Array.from({ length: 400 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: "cumle ".repeat(60),
  }));
  const duration = segments.length * 5;
  const chunks = chunkSegments(segments, 120000);
  assert.ok(chunks.length > 1, "test anlamli olmasi icin bolunmeli");

  const client = stubClient({
    removals: [{ start: 1, end: 2, kind: "silence", reason: "s", confidence: 0.9 }],
    chapters: [],
    warnings: [],
  });
  const plan = await planEdit({ client, transcript: { segments }, duration, options: {} });

  assert.equal(client.calls.length, chunks.length, "her pencere icin bir istek");
  // Ilk pencere disindaki kesim onerileri o pencereye ait olmadigi icin dusuruldu
  assert.equal(plan.removals.length, 1);
  const progress = [];
  await planEdit({
    client: stubClient({ removals: [], chapters: [], warnings: [] }),
    transcript: { segments },
    duration,
    options: {},
    onProgress: (d) => progress.push(d),
  });
  assert.match(progress[0], /1\/\d+/, "ilerleme pencere numarasini bildirir");
});

test("planEdit reddedilen istegi acikca bildirir", async () => {
  const client = stubClient({
    __message: {
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "policy" },
      usage: {},
      content: [],
    },
  });
  await assert.rejects(
    planEdit({ client, transcript: TRANSCRIPT, duration: 20, options: {} }),
    /reddetti/,
  );
});

test("planEdit beta desteklenmiyorsa sade istekle tekrar dener", async () => {
  const client = stubClient({ removals: [], chapters: [], warnings: [] }, { betaStatus: 400 });
  await planEdit({ client, transcript: TRANSCRIPT, duration: 20, options: {} });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].beta, true);
  assert.equal(client.calls[0].params.fallbacks, "default");
  assert.equal(client.calls[1].beta, false);
  assert.equal(client.calls[1].params.fallbacks, undefined, "sade istekte beta alanlari olmamali");
});

test("planEdit beta disi hatayi yutmaz", async () => {
  const client = stubClient({ removals: [] }, { betaStatus: 429 });
  await assert.rejects(
    planEdit({ client, transcript: TRANSCRIPT, duration: 20, options: {} }),
    /beta desteklenmiyor/,
  );
});

test("planEdit JSON olmayan yaniti anlasilir hataya cevirir", async () => {
  const client = stubClient({
    __message: {
      stop_reason: "end_turn",
      stop_details: null,
      usage: {},
      content: [{ type: "text", text: "Tabii, iste kurgu plani:" }],
    },
  });
  await assert.rejects(
    planEdit({ client, transcript: TRANSCRIPT, duration: 20, options: {} }),
    /gecerli JSON dondurmedi/,
  );
});

test("writeMetadata ciktiyi normalize eder ve sinir disi anlari duser", async () => {
  const client = stubClient({
    titles: ["Birinci", "", "Ikinci"],
    description: "Aciklama metni",
    tags: ["kurgu", "premiere"],
    hashtags: ["premiere"],
    pinned_comment: "Sen nasil kurguluyorsun?",
    thumbnail_moments: [
      { time: 12, why: "gulumseme" },
      { time: 9999, why: "sure disi" },
      { time: -5, why: "negatif" },
    ],
  });

  const meta = await writeMetadata({
    client,
    transcript: TRANSCRIPT,
    chapters: [{ time: 0, title: "Giris" }],
    outputDuration: 100,
    options: { model: "claude-opus-5", effort: "high" },
  });

  assert.deepEqual(meta.titles, ["Birinci", "Ikinci"]);
  assert.deepEqual(meta.tags, ["kurgu", "premiere"]);
  assert.deepEqual(meta.thumbnailMoments, [{ time: 12, why: "gulumseme" }]);
  assert.equal(meta.pinnedComment, "Sen nasil kurguluyorsun?");

  const { params } = client.calls[0];
  assert.match(params.messages[0].content, /0s Giris/);
  assert.match(params.system[0].text, /Bolum listesini EKLEME/);
});
