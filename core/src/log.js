/** Basit, satir-bazli log. Panel ve eklenti ayni satirlari okur. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = "info", sink = null } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, extra) => {
    if (LEVELS[lvl] < min) return;
    const entry = { t: new Date().toISOString(), level: lvl, msg, ...(extra || {}) };
    if (sink) sink(entry);
    const line = `[${entry.t}] ${lvl.toUpperCase()} ${msg}`;
    if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, e) => emit("debug", m, e),
    info: (m, e) => emit("info", m, e),
    warn: (m, e) => emit("warn", m, e),
    error: (m, e) => emit("error", m, e),
  };
}
