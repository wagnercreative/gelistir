/**
 * Premiere koprusu: komut kuyrugu.
 *
 * Premiere disaridan baglanti kabul edemez, o yuzden yon tersine cevrilir:
 * Premiere icindeki panel cekirdege uzun-yoklama (long-poll) yapar ve
 * calistirilacak ExtendScript komutlarini alir.
 *
 *   Claude Code (MCP) ──┐
 *                       ├─► hostbridge.run() ──► kuyruk ──► panel poll()
 *   panel sohbeti ──────┘                                      │
 *                       ◄──────── complete() ◄─────────────────┘
 *
 * Kim isterse istesin (Claude Code, panel sohbeti, baska bir MCP istemcisi)
 * komutlar ayni kuyruktan geciyor; panelde tek bir calistirici dongusu var.
 */
import { randomUUID } from "node:crypto";

export function createHostBridge({
  timeoutMs = 120000, // bir komutun panelde tamamlanmasi icin ust sinir
  staleMs = 20000, // bu sureden beri yoklama yoksa panel bagli sayilmaz
  maxQueue = 64,
} = {}) {
  const commands = new Map(); // id -> kayit
  const queue = []; // henuz panele verilmemis id'ler
  const waiters = new Set(); // bekleyen uzun-yoklamalar
  const stats = { completed: 0, failed: 0, timedOut: 0 };
  let lastSeenAt = 0;
  let lastCommand = null;

  const now = () => Date.now();

  function isConnected() {
    return lastSeenAt > 0 && now() - lastSeenAt < staleMs;
  }

  function wakeWaiters() {
    if (!queue.length) return;
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(takeQueued());
    }
  }

  function takeQueued() {
    const taken = [];
    while (queue.length) {
      const id = queue.shift();
      const record = commands.get(id);
      if (!record || record.state !== "queued") continue;
      record.state = "running";
      record.dispatchedAt = now();
      taken.push({ id: record.id, fn: record.fn, args: record.args, label: record.label });
    }
    return taken;
  }

  /**
   * Bir ExtendScript komutunu kuyruga koyar ve panelin sonucunu bekler.
   * @returns {Promise<{content: string, isError: boolean}>}
   */
  function run({ fn, args = [], label = "" }) {
    if (!fn) return Promise.reject(new Error("fn zorunlu"));
    if (!isConnected()) {
      return Promise.reject(
        new Error(
          "Premiere paneli bagli degil. Premiere'i ac, Pencere > Uzantilar > " +
            "Gelistir panelini ac ve panelin 'Premiere bagli' yazdigini gor.",
        ),
      );
    }
    if (queue.length >= maxQueue) {
      return Promise.reject(new Error(`Komut kuyrugu dolu (${maxQueue}); panel yetisemiyor.`));
    }

    const id = randomUUID().slice(0, 12);
    return new Promise((resolve, reject) => {
      const record = {
        id,
        fn,
        args: args.map((a) => (a === null || a === undefined ? "" : String(a))),
        label: label || fn,
        state: "queued",
        createdAt: now(),
        resolve,
        reject,
      };
      record.timer = setTimeout(() => {
        commands.delete(id);
        stats.timedOut++;
        reject(
          new Error(
            `${record.label} ${Math.round(timeoutMs / 1000)} saniyede tamamlanmadi. ` +
              "Premiere bir islem yapiyor ya da panel kapandi olabilir.",
          ),
        );
      }, timeoutMs);

      commands.set(id, record);
      queue.push(id);
      lastCommand = { fn, label: record.label, at: record.createdAt };
      wakeWaiters();
    });
  }

  /**
   * Panel bunu cagirir: bekleyen komutlari alir.
   * Kuyruk bossa waitMs kadar bekler (uzun-yoklama), sonra bos dizi doner.
   */
  function poll(waitMs = 25000) {
    lastSeenAt = now();
    if (queue.length) return Promise.resolve(takeQueued());
    if (waitMs <= 0) return Promise.resolve([]);

    return new Promise((resolve) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve([]);
      }, waitMs);
      waiters.add(waiter);
    });
  }

  /** Panel bunu cagirir: bir komutun sonucunu bildirir. */
  function complete(id, { content = "", isError = false } = {}) {
    lastSeenAt = now();
    const record = commands.get(id);
    if (!record) return false; // zaman asimina ugramis ya da bilinmeyen id
    clearTimeout(record.timer);
    commands.delete(id);
    if (isError) stats.failed++;
    else stats.completed++;
    record.resolve({ content: String(content), isError: Boolean(isError) });
    return true;
  }

  function status() {
    return {
      connected: isConnected(),
      lastSeenAt: lastSeenAt || null,
      secondsSinceSeen: lastSeenAt ? Math.round((now() - lastSeenAt) / 1000) : null,
      queued: queue.length,
      running: [...commands.values()].filter((c) => c.state === "running").length,
      lastCommand,
      ...stats,
    };
  }

  /** Panel kapandiginda bekleyen her seyi anlasilir bir hatayla bitirir. */
  function disconnect(reason = "Panel baglantisi kesildi") {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    for (const record of [...commands.values()]) {
      clearTimeout(record.timer);
      commands.delete(record.id);
      stats.failed++;
      record.reject(new Error(reason));
    }
    queue.length = 0;
    lastSeenAt = 0;
  }

  return { run, poll, complete, status, disconnect, isConnected };
}
