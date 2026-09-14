import test from "node:test";
import assert from "node:assert/strict";
import { createHostBridge } from "../src/hostbridge.js";

test("panel bagli degilken arac cagrisi hemen ve aciklamali basarisiz olur", async () => {
  const bridge = createHostBridge();
  assert.equal(bridge.isConnected(), false);
  await assert.rejects(bridge.run({ fn: "gelistirPing" }), (err) => {
    assert.match(err.message, /Premiere paneli bagli degil/);
    assert.match(err.message, /Uzantilar/);
    return true;
  });
});

test("yoklama paneli bagli isaretler", async () => {
  const bridge = createHostBridge();
  assert.deepEqual(await bridge.poll(0), []);
  assert.equal(bridge.isConnected(), true);
  const status = bridge.status();
  assert.equal(status.connected, true);
  assert.equal(status.queued, 0);
  assert.ok(status.lastSeenAt);
});

test("bekleyen yoklama yeni komutla uyanir", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0); // bagli

  const polling = bridge.poll(5000);
  const running = bridge.run({ fn: "gelistirGetProject", args: [], label: "test" });

  const commands = await polling;
  assert.equal(commands.length, 1);
  assert.equal(commands[0].fn, "gelistirGetProject");
  assert.equal(commands[0].label, "test");
  assert.ok(commands[0].id);

  assert.equal(bridge.complete(commands[0].id, { content: '{"ok":true}' }), true);
  assert.deepEqual(await running, { content: '{"ok":true}', isError: false });
  assert.equal(bridge.status().completed, 1);
});

test("kuyrukta bekleyen komut yoklamada hemen doner", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirPing" });

  const commands = await bridge.poll(0);
  assert.equal(commands.length, 1);
  bridge.complete(commands[0].id, { content: "{}" });
  await running;
});

test("argumanlar metne cevrilir (ExtendScript'e oyle gidiyor)", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirSetClipEnabled", args: ["video", 0, 2, false, null] });
  const [command] = await bridge.poll(0);
  assert.deepEqual(command.args, ["video", "0", "2", "false", ""]);
  bridge.complete(command.id, { content: "{}" });
  await running;
});

test("hata sonucu isError ile aktarilir", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirGetSequence" });
  const [command] = await bridge.poll(0);
  bridge.complete(command.id, { content: "Aktif sequence yok", isError: true });

  assert.deepEqual(await running, { content: "Aktif sequence yok", isError: true });
  assert.equal(bridge.status().failed, 1);
  assert.equal(bridge.status().completed, 0);
});

test("cevaplanmayan komut zaman asimina ugrar ve neden soylenir", async () => {
  const bridge = createHostBridge({ timeoutMs: 60 });
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirExportSequence", label: "premiere_export_sequence" });
  await bridge.poll(0); // panel aldi ama sonuc bildirmedi

  await assert.rejects(running, (err) => {
    assert.match(err.message, /premiere_export_sequence/);
    assert.match(err.message, /tamamlanmadi/);
    return true;
  });
  assert.equal(bridge.status().timedOut, 1);
});

test("zaman asimindan sonra gelen sonuc yok sayilir", async () => {
  const bridge = createHostBridge({ timeoutMs: 40 });
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirPing" });
  const [command] = await bridge.poll(0);
  await assert.rejects(running, /tamamlanmadi/);
  assert.equal(bridge.complete(command.id, { content: "{}" }), false);
});

test("bilinmeyen id yok sayilir", () => {
  const bridge = createHostBridge();
  assert.equal(bridge.complete("olmayan", { content: "{}" }), false);
});

test("panel bagliligi eskiyince arac cagrisi reddedilir", async () => {
  const bridge = createHostBridge({ staleMs: 30 });
  await bridge.poll(0);
  assert.equal(bridge.isConnected(), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(bridge.isConnected(), false);
  await assert.rejects(bridge.run({ fn: "gelistirPing" }), /bagli degil/);
});

test("disconnect panele verilmis komutlari da hatayla bitirir", async () => {
  // Panel kapaniyorsa bu komutlar hic tamamlanmayacak; zaman asimini
  // beklemek yerine hemen ve aciklamali basarisiz olmalari daha iyi.
  const bridge = createHostBridge();
  await bridge.poll(0);
  const a = bridge.run({ fn: "gelistirPing" });
  const b = bridge.run({ fn: "gelistirGetProject" });
  await bridge.poll(0); // panel ikisini de aldi

  bridge.disconnect("Panel kapandi");

  await assert.rejects(a, /Panel kapandi/);
  await assert.rejects(b, /Panel kapandi/);
  assert.equal(bridge.isConnected(), false);
  assert.equal(bridge.status().queued, 0);
});

test("disconnect bos bekleyen yoklamayi serbest birakir", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  const polling = bridge.poll(5000);
  bridge.disconnect("Panel kapandi");
  assert.deepEqual(await polling, []);
});

test("kuyruga giren komut bekleyen yoklamayi uyandirir (siralama)", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  const polling = bridge.poll(5000);
  const running = bridge.run({ fn: "gelistirPing" });

  // run() wakeWaiters cagirdigi icin yoklama beklemeden doner
  const commands = await polling;
  assert.equal(commands.length, 1);
  bridge.complete(commands[0].id, { content: "{}" });
  await running;
});

test("kuyruk dolunca yeni komut reddedilir", async () => {
  const bridge = createHostBridge({ maxQueue: 2, timeoutMs: 5000 });
  await bridge.poll(0);
  const pending = [
    bridge.run({ fn: "a" }),
    bridge.run({ fn: "b" }),
  ];
  await assert.rejects(bridge.run({ fn: "c" }), /kuyrugu dolu/);

  bridge.disconnect("temizlik");
  await Promise.allSettled(pending);
});

test("fn olmadan cagri reddedilir", async () => {
  const bridge = createHostBridge();
  await bridge.poll(0);
  await assert.rejects(bridge.run({ args: [] }), /fn zorunlu/);
});

test("status calisan komut sayisini ve son komutu bildirir", async () => {
  const bridge = createHostBridge({ timeoutMs: 5000 });
  await bridge.poll(0);
  const running = bridge.run({ fn: "gelistirApplyKeeps", label: "premiere_apply_keeps" });

  assert.equal(bridge.status().queued, 1);
  assert.equal(bridge.status().running, 0);
  assert.equal(bridge.status().lastCommand.label, "premiere_apply_keeps");

  const [command] = await bridge.poll(0);
  assert.equal(bridge.status().queued, 0);
  assert.equal(bridge.status().running, 1, "panele verildi, sonuc bekleniyor");

  bridge.complete(command.id, { content: "{}" });
  await running;
  assert.equal(bridge.status().running, 0);
});
