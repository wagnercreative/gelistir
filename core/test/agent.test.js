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
  createToolState,
  createSession,
  sendMessage,
  resolveApprovals,
  sessionView,
  runTool,
  isCoreTool,
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

/**
 * Sahte Premiere koprusu: paneli taklit eder, komutlari kaydedip aninda
 * cevaplar. Gercek kopru komutu panele uzun-yoklama ile gonderir.
 */
function fakeBridge(responder) {
  const calls = [];
  return {
    calls,
    isConnected: () => true,
    run({ fn, args, label }) {
      // Gercek kopru argumanlari metne cevirir (ExtendScript'e oyle gidiyor);
      // stub da ayni sekilde davransin ki testler tel bicimini dogrulasin.
      calls.push({ fn, args: (args || []).map((a) => String(a)), label });
      const reply = responder && responder({ fn, args, label });
      return Promise.resolve(
        reply || { content: JSON.stringify({ ok: true, fn }), isError: false },
      );
    },
  };
}

function session(responses, overrides = {}, bridge = fakeBridge()) {
  const config = { ...DEFAULTS, ...overrides };
  const s = createSession({
    config,
    client: stubClient(responses, {}),
    state: createToolState({ config, bridge }),
  });
  s.testBridge = bridge;
  return s;
}

function toolResults(s) {
  return s.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === "tool_result");
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
      assert.equal(isCoreTool(spec.name), false, spec.name);
    } else {
      assert.ok(coreNames.has(spec.name), `${spec.name} icin yurutucu yok`);
      assert.equal(isCoreTool(spec.name), true, spec.name);
    }
  }
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

test("salt-okunur araclar isaretli, yazanlar degil", () => {
  const readOnly = TOOL_SPECS.filter((s) => s.readOnly).map((s) => s.name);
  assert.ok(readOnly.includes("premiere_get_sequence"));
  assert.ok(readOnly.includes("transcript_read"));
  assert.ok(readOnly.includes("build_cut_plan"), "plan kurmak projeyi degistirmez");

  for (const spec of TOOL_SPECS) {
    if (spec.approval) {
      assert.ok(!spec.readOnly, `${spec.name} hem yikici hem salt-okunur olamaz`);
    }
  }
  assert.ok(!toolSpec("premiere_apply_keeps").readOnly, "yeni sequence kurar");
  assert.ok(!toolSpec("premiere_set_clip_enabled").readOnly);
});

test("sistem istemi kritik kurallari iceriyor", () => {
  assert.match(SYSTEM_PROMPT, /Once BAK/);
  assert.match(SYSTEM_PROMPT, /build_cut_plan/);
  assert.match(SYSTEM_PROMPT, /Yayinlama dugmesine BASMA/);
  assert.match(SYSTEM_PROMPT, /0:00/);
});

// ---------------------------------------------------------------- arac yurutme

test("runTool Premiere araclarini kopruye, cekirdek araclarini yurutucuye verir", async () => {
  const bridge = fakeBridge();
  const state = createToolState({ config: { ...DEFAULTS }, bridge });

  const out = await runTool("premiere_get_project", {}, state);
  assert.deepEqual(out, { ok: true, fn: "gelistirGetProject" });
  assert.deepEqual(bridge.calls, [
    { fn: "gelistirGetProject", args: [], label: "premiere_get_project" },
  ]);

  await assert.rejects(runTool("bilinmeyen", {}, state), /Bilinmeyen arac/);
});

test("kopru hata dondururse JSON icindeki mesaj ayiklanir", async () => {
  const bridge = fakeBridge(() => ({
    content: JSON.stringify({ ok: false, error: "Aktif sequence yok" }),
    isError: true,
  }));
  const state = createToolState({ config: { ...DEFAULTS }, bridge });
  await assert.rejects(runTool("premiere_get_sequence", { sequenceName: "" }, state), {
    message: "Aktif sequence yok",
  });
});

test("kopru JSON olmayan hata metni dondururse oldugu gibi aktarilir", async () => {
  const bridge = fakeBridge(() => ({ content: "EvalScript error.", isError: true }));
  const state = createToolState({ config: { ...DEFAULTS }, bridge });
  await assert.rejects(runTool("premiere_get_project", {}, state), /EvalScript error/);
});

test("kopru yoksa anlasilir hata verir", async () => {
  const state = createToolState({ config: { ...DEFAULTS }, bridge: null });
  await assert.rejects(runTool("premiere_get_project", {}, state), /koprusu kurulmamis/);
});

// ---------------------------------------------------------------- dongu

test("Premiere araci tek cagrida kosar ve tur biter", async () => {
  const s = session([
    assistantToolUse(
      [{ id: "t1", name: "premiere_get_sequence", input: { sequenceName: "" } }],
      "Zaman cizgisine bakiyorum",
    ),
    assistantText("3 klip var, en uzunu 40 saniye."),
  ]);

  await sendMessage(s, "sequence'te ne var?");
  assert.equal(s.status, "end_turn");
  assert.deepEqual(s.testBridge.calls, [
    { fn: "gelistirGetSequence", args: ["", ""], label: "premiere_get_sequence" },
  ]);

  // Arac sonucu tek bir user mesajinda gitti
  const messages = s.messages.filter(
    (m) => m.role === "user" && Array.isArray(m.content) &&
      m.content.some((b) => b.type === "tool_result"),
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content[0].tool_use_id, "t1");

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
  const message = s.messages.find(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
  );
  assert.equal(message.content.length, 2);
  assert.deepEqual(message.content.map((b) => b.tool_use_id), ["a", "b"]);
  assert.equal(s.testBridge.calls.length, 2);
});

test("Premiere hatasi is_error olarak modele doner", async () => {
  const bridge = fakeBridge(() => ({
    content: JSON.stringify({ ok: false, error: "Sequence bulunamadi: Yok" }),
    isError: true,
  }));
  const s = session(
    [
      assistantToolUse([{ id: "t1", name: "premiere_get_sequence", input: { sequenceName: "Yok" } }]),
      assistantText("Sequence bulunamadi, adini kontrol eder misin?"),
    ],
    {},
    bridge,
  );

  await sendMessage(s, "Yok sequence'ini incele");
  const [block] = toolResults(s);
  assert.equal(block.is_error, true);
  assert.match(block.content, /Sequence bulunamadi/);
  assert.equal(s.status, "end_turn");
});

// ---------------------------------------------------------------- onay

test("yikici arac once onay bekler, onaydan once Premiere'e gitmez", async () => {
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
  assert.deepEqual(s.testBridge.calls, [], "onaydan once komut gonderilmez");

  const view = sessionView(s);
  assert.equal(view.pendingApproval.length, 1);
  assert.equal(view.pendingApproval[0].name, "premiere_delete_clip");
  assert.equal(view.pendingApproval[0].approvalRequired, true);
  assert.ok(view.pendingApproval[0].summary.length > 10);

  await resolveApprovals(s, { d1: "allow" });
  assert.equal(s.status, "end_turn");
  assert.deepEqual(s.testBridge.calls, [
    { fn: "gelistirDeleteClip", args: ["video", "0", "2", "true"], label: "premiere_delete_clip" },
  ]);
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
  assert.deepEqual(s.testBridge.calls, [], "reddedilen arac hic kosmaz");
  const [block] = toolResults(s);
  assert.equal(block.is_error, true);
  assert.match(block.content, /onaylamadi/);
});

test("karisik turda okuma araci kosar, yikici olan onay bekler", async () => {
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
  assert.deepEqual(
    s.testBridge.calls.map((c) => c.fn),
    ["gelistirGetProject"],
    "onay gerektirmeyen kardes arac beklemez",
  );

  await resolveApprovals(s, { d1: "allow" });
  assert.deepEqual(s.testBridge.calls.map((c) => c.fn), ["gelistirGetProject", "gelistirTrimClip"]);
  assert.equal(s.status, "end_turn");
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
  assert.equal(s.status, "end_turn");

  const plan = s.cutPlans["plan-1"];
  assert.ok(plan, "plan saklanmali");
  assert.match(plan.keepsText, /^0\.000,10\.\d{3};/);

  const applyCall = s.testBridge.calls.find((c) => c.fn === "gelistirApplyKeeps");
  assert.ok(applyCall, "apply_keeps kopruye gitti");
  assert.equal(applyCall.args[0], plan.keepsText, "keeps metni oturumdan geliyor");
  assert.equal(applyCall.args[1], media);

  // Arac ciktisi modele ozet olarak gitti; keeps metni baglama dokulmedi
  const payload = JSON.parse(toolResults(s).find((b) => b.tool_use_id === "c1").content);
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
  assert.equal(s.status, "end_turn");
  assert.deepEqual(s.testBridge.calls, [], "gecersiz plan Premiere'e gonderilmez");
  const [block] = toolResults(s);
  assert.equal(block.is_error, true);
  assert.match(block.content, /planId bulunamadi/);
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
  const [block] = toolResults(s);
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

  const blocks = toolResults(s);
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

test("paylasilan durum oturumlar arasinda tasiniyor", async () => {
  // Claude Code'un cikardigi dokum panel sohbetinde de gecerli olmali.
  const config = { ...DEFAULTS };
  const shared = createToolState({ config, bridge: fakeBridge() });
  shared.transcripts["/v/a.mp4"] = {
    language: "tr",
    segments: [{ start: 0, end: 5, text: "onceden cikarilmis dokum" }],
  };

  const s = createSession({
    config,
    client: stubClient([
      assistantToolUse([{
        id: "r1",
        name: "transcript_read",
        input: { path: "/v/a.mp4", startSeconds: 0, endSeconds: 10 },
      }]),
      assistantText("okudum"),
    ]),
    state: shared,
  });

  await sendMessage(s, "dokumu oku");
  const payload = JSON.parse(toolResults(s)[0].content);
  assert.match(payload.text, /onceden cikarilmis dokum/);
});

// ---------------------------------------------------------------- dayaniklilik

test("beta ozellikleri yoksa sade istekle devam eder", async () => {
  const client = stubClient([assistantText("merhaba")], { betaStatus: 400 });
  const s = createSession({ config: { ...DEFAULTS }, client });
  await sendMessage(s, "selam");

  assert.equal(s.status, "end_turn");
  assert.equal(s.degraded, true);
  assert.equal(client.calls.length, 2);
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

test("onay beklerken yeni mesaj kabul edilmez", async () => {
  const s = session([
    assistantToolUse([{
      id: "d1",
      name: "premiere_delete_clip",
      input: { trackType: "video", trackIndex: 0, clipIndex: 0, ripple: false },
    }]),
  ]);
  await sendMessage(s, "sil");
  assert.equal(s.status, "awaiting_approval");
  await assert.rejects(sendMessage(s, "bir sey daha"), /Onceki tur bitmedi/);
});

test("bos mesaj reddedilir", async () => {
  const s = session([assistantText("x")]);
  await assert.rejects(sendMessage(s, "   "), /Bos mesaj/);
});

test("onay bekleyen islem yokken onay gonderilemez", async () => {
  const s = session([assistantText("x")]);
  await assert.rejects(resolveApprovals(s, {}), /Onay bekleyen islem yok/);
});

test("bilinmeyen arac adi dongunun akisini bozmaz", async () => {
  const s = session([
    assistantToolUse([{ id: "x1", name: "premiere_uydurma_arac", input: {} }]),
    assistantText("Boyle bir arac yok, baska yol deneyecegim."),
  ]);
  await sendMessage(s, "sihir yap");
  assert.equal(s.status, "end_turn");
  assert.match(toolResults(s)[0].content, /Bilinmeyen arac/);
});

test("sonsuz arac dongusu cagri butcesiyle kesilir", async () => {
  // Her turda ayni araci isteyen bir model.
  const responses = Array.from({ length: 200 }, (_, i) =>
    assistantToolUse([{ id: `t${i}`, name: "premiere_get_project", input: {} }]),
  );
  const s = session(responses);

  await sendMessage(s, "dongu");
  assert.equal(s.status, "error");
  assert.match(s.error, /model cagrisinda bitmedi/);
  assert.equal(s.modelCalls, s.maxModelCalls);
  assert.equal(s.testBridge.calls.length, s.maxModelCalls);
});

test("yeni kullanici mesaji cagri butcesini yeniler", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_project", input: {} }]),
    assistantText("birinci bitti"),
    assistantText("ikinci bitti"),
  ]);
  await sendMessage(s, "bak");
  assert.equal(s.modelCalls, 2);

  await sendMessage(s, "tekrar bak");
  assert.equal(s.modelCalls, 1, "butce sifirlandi");
  assert.equal(s.status, "end_turn");
});

test("sessionView istemciyi, mesaj gecmisini ve sirlari sizdirmaz", async () => {
  const s = session([assistantText("ok")]);
  await sendMessage(s, "selam");
  const view = sessionView(s);
  assert.equal(view.client, undefined);
  assert.equal(view.messages, undefined);
  assert.equal(view.apiKey, undefined);
  assert.equal(view.config, undefined);
  assert.equal(view.bridge, undefined);
  assert.equal(view.messageCount, 2);
  assert.ok(view.usage.output > 0);
});

test("kullanim sayaclari tur boyunca birikiyor", async () => {
  const s = session([
    assistantToolUse([{ id: "t1", name: "premiere_get_project", input: {} }]),
    assistantText("bitti"),
  ]);
  await sendMessage(s, "bak");
  assert.equal(s.usage.input, 8 + 5);
  assert.equal(s.usage.output, 9 + 7);
});

test("MCP yolu API anahtari olmadan calisir", async () => {
  // Kullanicinin istedigi sey: her sey Claude Code uzerinden, ayri bir
  // ANTHROPIC_API_KEY olmadan. Arac yurutme hicbir yerde Anthropic
  // istemcisi kurmamali.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-anahtarsiz-"));
  const { ffmpeg, ffprobe } = makeMediaStubs(work);
  const media = path.join(work, "cekim.mp4");
  fs.writeFileSync(media, "sahte");
  const srt = path.join(work, "cekim.srt");
  fs.writeFileSync(srt, "1\n00:00:00,000 --> 00:00:04,000\nilk cumle\n");

  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  try {
    const config = { ...DEFAULTS, ffmpeg, ffprobe, thumbnailCandidates: 1 };
    const bridge = fakeBridge();
    const state = createToolState({ config, bridge }); // apiKey verilmedi
    assert.equal(state.client, undefined, "arac durumunda model istemcisi olmamali");

    // Okuma, dokum, plan
    await runTool("premiere_get_sequence", { sequenceName: "" }, state);
    await runTool("media_probe", { path: media }, state);
    await runTool("media_transcribe", { path: media, language: "tr", srtPath: srt }, state);
    await runTool("media_detect_silence", { path: media }, state);
    const plan = await runTool(
      "build_cut_plan",
      { path: media, includeSilence: true, removals: [] },
      state,
    );
    assert.ok(plan.planId);

    // Kesimleri uygulama (Premiere tarafi)
    await runTool(
      "premiere_apply_keeps",
      { planId: plan.planId, sourcePath: media, newSequenceName: "Test" },
      state,
    );

    // Ve yayina hazir paket: metinleri cagiran (Claude Code) veriyor
    const bundle = await runTool(
      "deliver_youtube_package",
      {
        sourcePath: media,
        masterPath: "",
        planId: plan.planId,
        outDir: path.join(work, "cikti"),
        title: "Claude Code'un yazdigi baslik",
        description: "Aciklama",
        tags: ["kurgu"],
        hashtags: [],
        chapters: [],
        pinnedComment: "",
      },
      state,
    );
    assert.ok(fs.existsSync(bundle.files.video));
    const meta = JSON.parse(fs.readFileSync(bundle.files.metadata, "utf8"));
    assert.equal(meta.title, "Claude Code'un yazdigi baslik");
    assert.equal(meta.privacyStatus, "private");
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    fs.rmSync(work, { recursive: true, force: true });
  }
});
