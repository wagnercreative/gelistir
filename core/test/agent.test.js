import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TOOL_SPECS,
  apiTools,
  toolSpec,
  needsApproval,
  coreToolNames,
  createSession,
  sendMessage,
  submitToolResults,
  resolveApprovals,
  sessionView,
  SYSTEM_PROMPT,
} from "../src/agent.js";
import { DEFAULTS } from "../src/config.js";
import {
  makeMediaStubs,
  stubClient,
  assistantText,
  assistantToolUse,
  assistantRefusal,
  assistantPause,
} from "./stubs.js";

function session(responses, overrides = {}) {
  return createSession({
    config: { ...DEFAULTS, ...overrides },
    client: stubClient(responses.client || responses, responses.options || {}),
  });
}

// ---------------------------------------------------------------- arac tablosu

test("arac tanimlari strict tool use icin gecerli", () => {
  const names = new Set();
  for (const spec of TOOL_SPECS) {
    assert.ok(!names.has(spec.name), `${spec.name} iki kez tanimli`);
    names.add(spec.name);
    assert.ok(spec.description.length > 30, `${spec.name} aciklamasi yetersiz`);
    assert.ok(["host", "core"].includes(spec.executor), spec.name);

    const schema = spec.input_schema;
    assert.equal(schema.type, "object", spec.name);
    assert.equal(schema.additionalProperties, false, `${spec.name}: additionalProperties`);
    // strict:true tum alanlarin required olmasini ister
    assert.deepEqual(
      [...(schema.required || [])].sort(),
      Object.keys(schema.properties || {}).sort(),
      `${spec.name}: required tum alanlari kapsamali`,
    );
  }
});

test("host araclari ExtendScript eslemesine, core araclari yurutucuye sahip", () => {
  const coreNames = new Set(coreToolNames());
  for (const spec of TOOL_SPECS) {
    if (spec.executor === "host") {
      assert.match(spec.hostFn, /^gelistir[A-Z]/, spec.name);
      assert.equal(typeof spec.hostArgs, "function", spec.name);
    } else {
      assert.ok(coreNames.has(spec.name), `${spec.name} icin yurutucu yok`);
    }
  }
  // Tersi de dogru olmali: yurutucusu olan her arac tanimli
  for (const name of coreNames) assert.ok(toolSpec(name), `${name} tanimli degil`);
});

test("apiTools ic alanlari sizdirmaz", () => {
  for (const tool of apiTools()) {
    assert.deepEqual(Object.keys(tool).sort(), ["description", "input_schema", "name", "strict"]);
    assert.equal(tool.strict, true);
  }
});

test("yikici araclar onay ister, okuma araclari istemez", () => {
  assert.equal(needsApproval("premiere_delete_clip"), true);
  assert.equal(needsApproval("premiere_trim_clip"), true);
  assert.equal(needsApproval("premiere_export_sequence"), true);
  assert.equal(needsApproval("deliver_youtube_package"), true);

  assert.equal(needsApproval("premiere_get_sequence"), false);
  assert.equal(needsApproval("premiere_set_clip_enabled"), false);
  assert.equal(needsApproval("premiere_apply_keeps"), false);
  assert.equal(needsApproval("build_cut_plan"), false);
  assert.equal(needsApproval("bilinmeyen_arac"), false);
});

test("sistem istemi kritik kurallari iceriyor", () => {
  assert.match(SYSTEM_PROMPT, /Once BAK/);
  assert.match(SYSTEM_PROMPT, /build_cut_plan/);
  assert.match(SYSTEM_PROMPT, /Yayinlama dugmesine BASMA/);
  assert.match(SYSTEM_PROMPT, /0:00/);
});

// ---------------------------------------------------------------- dongu

test("host araci panele donuyor, sonuc gelince tur tamamlaniyor", async () => {
  const s = session([
    assistantToolUse(
      [{ id: "t1", name: "premiere_get_sequence", input: { sequenceName: "" } }],
      "Zaman cizgisine bakiyorum",
    ),
    assistantText("3 klip var, en uzunu 40 saniye."),
  ]);

  await sendMessage(s, "sequence'te ne var?");
  assert.equal(s.status, "awaiting_tools");
  assert.deepEqual(s.pendingHost, [
    { id: "t1", name: "premiere_get_sequence", fn: "gelistirGetSequence", args: ["", ""] },
  ]);

  await submitToolResults(s, [
    { id: "t1", content: JSON.stringify({ ok: true, name: "Ana", duration: 40 }) },
  ]);
  assert.equal(s.status, "end_turn");

  // Arac sonucu tek bir user mesajinda gitti
  const toolMessages = s.messages.filter(
    (m) => m.role === "user" && Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result"),
  );
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content.length, 1);
  assert.equal(toolMessages[0].content[0].tool_use_id, "t1");

  const texts = s.log.filter((l) => l.role === "assistant").map((l) => l.text);
  assert.deepEqual(texts, ["Zaman cizgisine bakiyorum", "3 klip var, en uzunu 40 saniye."]);
});

test("ayni turdaki birden fazla arac sonucu tek mesajda birlesir", async () => {
  const s = session([
    assistantToolUse([
      { id: "a", name: "premiere_get_project", input: {} },
      { id: "b", name: "premiere_get_primary_source", input: {} },
    ]),
    assistantText("tamam"),
  ]);

  await sendMessage(s, "projeyi tani");
  assert.equal(s.pendingHost.length, 2);

  await submitToolResults(s, [
    { id: "a", content: '{"ok":true}' },
    { id: "b", content: '{"ok":true,"path":"/v/a.mp4"}' },
  ]);

  const toolMessage = s.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
  );
  assert.equal(toolMessage.content.length, 2);
  assert.deepEqual(toolMessage.content.map((b) => b.tool_use_id), ["a", "b"]);
});

test("Premiere hatasi is_error olarak modele doner", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_sequence", input: { sequenceName: "Yok" } }]),
    assistantText("Sequence bulunamadi, adini kontrol eder misin?"),
  ]);
  await sendMessage(s, "Yok sequence'ini incele");
  await submitToolResults(s, [
    { id: "t1", content: "Sequence bulunamadi: Yok", isError: true },
  ]);

  const toolMessage = s.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
  );
  assert.equal(toolMessage.content[0].is_error, true);
  assert.equal(s.status, "end_turn");
});

// ---------------------------------------------------------------- onay

test("yikici arac once onay bekler", async () => {
  const s = session([
    assistantToolUse(
      [{
        id: "d1",
        name: "premiere_delete_clip",
        input: { trackType: "video", trackIndex: 0, clipIndex: 2, ripple: true },
      }],
      "Ucuncu klibi silmem gerekiyor",
    ),
    assistantText("silindi"),
  ]);

  await sendMessage(s, "bos klibi sil");
  assert.equal(s.status, "awaiting_approval");
  assert.equal(s.pendingHost.length, 0, "onaydan once panele is gonderilmez");

  const view = sessionView(s);
  assert.equal(view.pendingApproval.length, 1);
  assert.equal(view.pendingApproval[0].name, "premiere_delete_clip");
  assert.equal(view.pendingApproval[0].approvalRequired, true);
  assert.ok(view.pendingApproval[0].summary.length > 10);

  await resolveApprovals(s, { d1: "allow" });
  assert.equal(s.status, "awaiting_tools");
  assert.deepEqual(s.pendingHost[0], {
    id: "d1",
    name: "premiere_delete_clip",
    fn: "gelistirDeleteClip",
    args: ["video", 0, 2, true],
  });
});

test("onay reddedilirse arac kosmaz, model bilgilendirilir", async () => {
  const s = session([
    assistantToolUse([{
      id: "d1",
      name: "premiere_delete_clip",
      input: { trackType: "video", trackIndex: 0, clipIndex: 2, ripple: false },
    }]),
    assistantText("Tamam, silmiyorum. Devre disi birakmayi ister misin?"),
  ]);

  await sendMessage(s, "sil");
  await resolveApprovals(s, { d1: "deny" });

  assert.equal(s.status, "end_turn");
  assert.equal(s.pendingHost.length, 0);
  const toolMessage = s.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
  );
  assert.equal(toolMessage.content[0].is_error, true);
  assert.match(toolMessage.content[0].content, /onaylamadi/);
});

test("onay bekleyen ve serbest araclar ayni turda karisirsa once onay sorulur", async () => {
  const s = session([
    assistantToolUse([
      { id: "r1", name: "premiere_get_project", input: {} },
      {
        id: "d1",
        name: "premiere_trim_clip",
        input: { trackType: "video", trackIndex: 0, clipIndex: 0, inPoint: "2", outPoint: "" },
      },
    ]),
    assistantText("bitti"),
  ]);

  await sendMessage(s, "basi kirp");
  assert.equal(s.status, "awaiting_approval");
  assert.deepEqual(s.pendingApproval.map((p) => p.id), ["d1"]);

  await resolveApprovals(s, { d1: "allow" });
  assert.equal(s.status, "awaiting_tools");
  assert.deepEqual(s.pendingHost.map((p) => p.id), ["r1", "d1"]);
});

// ---------------------------------------------------------------- cekirdek araclari

test("build_cut_plan plani saklar, apply_keeps onu oturumdan alir", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-agent-"));
  const { ffmpeg, ffprobe } = makeMediaStubs(work);
  const media = path.join(work, "cekim.mp4");
  fs.writeFileSync(media, "sahte");

  const s = session(
    [
      assistantToolUse([{
        id: "c1",
        name: "build_cut_plan",
        input: {
          path: media,
          includeSilence: true,
          removals: [
            { start: 30, end: 31.5, kind: "filler", reason: "eee", confidence: 0.9 },
            { start: 500, end: 600, kind: "filler", reason: "sure disi", confidence: 0.9 },
          ],
        },
      }]),
      assistantToolUse([{
        id: "p1",
        name: "premiere_apply_keeps",
        input: { planId: "plan-1", sourcePath: media, newSequenceName: "Gelistir kurgu" },
      }]),
      assistantText("Yeni sequence hazir."),
    ],
    { ffmpeg, ffprobe },
  );

  await sendMessage(s, "sessizlikleri ve dolgulari kes");

  // build_cut_plan core tarafinda kostu, model yeni turda apply_keeps istedi
  assert.equal(s.status, "awaiting_tools");
  assert.equal(s.pendingHost[0].fn, "gelistirApplyKeeps");

  const plan = s.cutPlans["plan-1"];
  assert.ok(plan, "plan saklanmali");
  assert.match(plan.keepsText, /^0\.000,10\.\d{3};/);
  assert.equal(s.pendingHost[0].args[0], plan.keepsText, "keeps metni oturumdan geliyor");
  assert.equal(s.pendingHost[0].args[1], media);

  // Arac ciktisi modele ozet olarak gitti; keeps metni baglama dokulmedi
  const resultBlock = s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result" && b.tool_use_id === "c1");
  const payload = JSON.parse(resultBlock.content);
  assert.equal(payload.planId, "plan-1");
  assert.equal(payload.proposalsDroppedAsInvalid, 1, "sure disi oneri dusuruldu");
  assert.equal(payload.silencesIncluded, 2);
  assert.ok(payload.removedSeconds > 6);
  assert.equal(payload.keepsText, undefined, "keeps metni model baglamina girmez");

  fs.rmSync(work, { recursive: true, force: true });
});

test("gecersiz planId modele anlasilir hata olarak doner", async () => {
  const s = session([
    assistantToolUse([{
      id: "p1",
      name: "premiere_apply_keeps",
      input: { planId: "plan-yok", sourcePath: "/v/a.mp4", newSequenceName: "X" },
    }]),
    assistantText("Once plani cikariyorum."),
  ]);

  await sendMessage(s, "uygula");
  assert.equal(s.status, "end_turn", "hata modele dondu, panele is gitmedi");
  const resultBlock = s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result");
  assert.equal(resultBlock.is_error, true);
  assert.match(resultBlock.content, /planId bulunamadi/);
});

test("transcript_read dokum yoksa yol gosteren hata verir", async () => {
  const s = session([
    assistantToolUse([{
      id: "r1",
      name: "transcript_read",
      input: { path: "/v/a.mp4", startSeconds: 0, endSeconds: 60 },
    }]),
    assistantText("Once dokum cikarmam gerekiyor."),
  ]);
  await sendMessage(s, "dokumu oku");
  const block = s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result");
  assert.equal(block.is_error, true);
  assert.match(block.content, /media_transcribe/);
});

test("media_transcribe hazir .srt ile calisir ve dokumu baglama dokmez", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-agent-srt-"));
  const { ffmpeg, ffprobe } = makeMediaStubs(work);
  const media = path.join(work, "ders.mp4");
  fs.writeFileSync(media, "sahte");
  const srt = path.join(work, "ders.srt");
  fs.writeFileSync(
    srt,
    "1\n00:00:00,000 --> 00:00:04,000\nbirinci cumle\n\n2\n00:00:30,000 --> 00:00:36,000\nikinci cumle\n",
  );

  const s = session(
    [
      assistantToolUse([{
        id: "t1",
        name: "media_transcribe",
        input: { path: media, language: "tr", srtPath: srt },
      }]),
      assistantToolUse([{
        id: "t2",
        name: "transcript_read",
        input: { path: media, startSeconds: 0, endSeconds: 20 },
      }]),
      assistantText("Girisi okudum."),
    ],
    { ffmpeg, ffprobe },
  );

  await sendMessage(s, "dokumu cikar ve girisi oku");
  assert.equal(s.status, "end_turn");

  const blocks = s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result");

  const summary = JSON.parse(blocks[0].content);
  assert.equal(summary.segments, 2);
  assert.equal(summary.coverage.end, 36);
  assert.ok(summary.preview.includes("birinci cumle"));
  assert.equal(summary.text, undefined, "tam dokum ozet ciktisinda yok");

  const window = JSON.parse(blocks[1].content);
  assert.match(window.text, /birinci cumle/);
  assert.ok(!window.text.includes("ikinci cumle"), "istenmeyen aralik dondurulmedi");

  fs.rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- dayaniklilik

test("beta ozellikleri yoksa sade istekle devam eder", async () => {
  const client = stubClient([assistantText("merhaba")], { betaStatus: 400 });
  const s = createSession({ config: { ...DEFAULTS }, client });
  await sendMessage(s, "selam");

  assert.equal(s.status, "end_turn");
  assert.equal(s.degraded, true);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].beta, true);
  assert.deepEqual(client.calls[0].params.betas, [
    "server-side-fallback-2026-07-01",
    "compact-2026-01-12",
  ]);
  assert.equal(client.calls[1].params.betas, undefined);
  assert.equal(client.calls[1].params.context_management, undefined);
});

test("beta disi hatalar yutulmaz", async () => {
  const client = stubClient([assistantText("x")], { betaStatus: 429 });
  const s = createSession({ config: { ...DEFAULTS }, client });
  await assert.rejects(sendMessage(s, "selam"), /beta desteklenmiyor/);
});

test("kimlik dogrulama hatasi ne yapilacagini soyleyen mesaja cevrilir", async () => {
  for (const status of [401, 403]) {
    const client = stubClient([assistantText("x")], { betaStatus: status });
    const s = createSession({ config: { ...DEFAULTS }, client });
    await assert.rejects(sendMessage(s, "selam"), (err) => {
      assert.match(err.message, /ANTHROPIC_API_KEY/);
      assert.match(err.message, /ant auth login/);
      assert.ok(err.cause, "ozgun hata korunmali");
      return true;
    });
  }
});

test("reddedilen istek oturumu hata durumuna alir", async () => {
  const s = session([assistantRefusal("cyber")]);
  await sendMessage(s, "bir sey yap");
  assert.equal(s.status, "error");
  assert.match(s.error, /reddetti/);
});

test("pause_turn otomatik devam eder", async () => {
  const s = session([assistantPause(), assistantText("bitti")]);
  await sendMessage(s, "uzun bir is yap");
  assert.equal(s.status, "end_turn");
});

test("istek araclari ve onbellek isaretiyle gonderilir", async () => {
  const client = stubClient([assistantText("ok")]);
  const s = createSession({ config: { ...DEFAULTS, model: "claude-opus-5", effort: "high" }, client });
  await sendMessage(s, "selam");

  const { params } = client.calls[0];
  assert.equal(params.model, "claude-opus-5");
  assert.equal(params.output_config.effort, "high");
  assert.equal(params.system[0].cache_control.type, "ephemeral");
  assert.equal(params.tools.length, TOOL_SPECS.length);
  assert.equal(params.fallbacks, "default");
});

test("tur bitmeden yeni mesaj kabul edilmez", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_project", input: {} }]),
  ]);
  await sendMessage(s, "bak");
  assert.equal(s.status, "awaiting_tools");
  await assert.rejects(sendMessage(s, "bir sey daha"), /Onceki tur bitmedi/);
});

test("bos mesaj reddedilir", async () => {
  const s = session([assistantText("x")]);
  await assert.rejects(sendMessage(s, "   "), /Bos mesaj/);
});

test("bekleyen is yokken sonuc veya onay gonderilemez", async () => {
  const s = session([assistantText("x")]);
  await assert.rejects(submitToolResults(s, []), /Bekleyen arac cagrisi yok/);
  await assert.rejects(resolveApprovals(s, {}), /Onay bekleyen islem yok/);
});

test("bilinmeyen arac adi dongunun akisini bozmaz", async () => {
  const s = session([
    assistantToolUse([{ id: "x1", name: "premiere_uydurma_arac", input: {} }]),
    assistantText("Boyle bir arac yok, baska yol deneyecegim."),
  ]);
  await sendMessage(s, "sihir yap");
  assert.equal(s.status, "end_turn");
  const block = s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === "tool_result");
  assert.match(block.content, /Bilinmeyen arac/);
});

test("sonsuz arac dongusu butceyle kesilir (panel turlari sayaci sifirlamaz)", async () => {
  // Her turda ayni araci isteyen bir model. Butce kullanicinin mesaji basina
  // oldugu icin panel sonuc donderdikce sifirlanmamali.
  const responses = Array.from({ length: 200 }, (_, i) =>
    assistantToolUse([{ id: `t${i}`, name: "premiere_get_project", input: {} }]),
  );
  const client = stubClient(responses);
  const s = createSession({ config: { ...DEFAULTS }, client });

  await sendMessage(s, "dongu");
  let rounds = 0;
  while (s.status === "awaiting_tools" && rounds++ < 300) {
    await submitToolResults(s, s.pendingHost.map((c) => ({ id: c.id, content: "{}" })));
  }
  assert.equal(s.status, "error");
  assert.match(s.error, /model cagrisinda bitmedi/);
  assert.equal(s.modelCalls, s.maxModelCalls);
  assert.ok(rounds <= 64, `${rounds} turda durdu`);
});

test("yeni kullanici mesaji cagri butcesini yeniler", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_project", input: {} }]),
    assistantText("birinci bitti"),
    assistantText("ikinci bitti"),
  ]);
  await sendMessage(s, "bak");
  await submitToolResults(s, [{ id: "t1", content: "{}" }]);
  assert.equal(s.modelCalls, 2);

  await sendMessage(s, "tekrar bak");
  assert.equal(s.modelCalls, 1, "butce sifirlandi");
  assert.equal(s.status, "end_turn");
});

test("sessionView istemciyi ve mesaj gecmisini sizdirmaz", async () => {
  const s = session([assistantText("ok")]);
  await sendMessage(s, "selam");
  const view = sessionView(s);
  assert.equal(view.client, undefined);
  assert.equal(view.messages, undefined);
  assert.equal(view.apiKey, undefined);
  assert.equal(view.config, undefined);
  assert.equal(view.messageCount, 2);
  assert.ok(view.usage.output > 0);
});

test("kullanim sayaclari tur boyunca birikiyor", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_project", input: {} }]),
    assistantText("bitti"),
  ]);
  await sendMessage(s, "bak");
  await submitToolResults(s, [{ id: "t1", content: "{}" }]);
  assert.equal(s.usage.input, 8 + 5);
  assert.equal(s.usage.output, 9 + 7);
});
