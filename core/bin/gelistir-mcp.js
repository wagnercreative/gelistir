#!/usr/bin/env node
/**
 * gelistir-mcp - Premiere Pro icin MCP sunucusu.
 *
 * Claude Code'a eklemek icin:
 *   claude mcp add premiere -- node /yol/gelistir/core/bin/gelistir-mcp.js
 *
 * Cekirdek zaten calisiyorsa ona baglanir; calismiyorsa bu surecin icinde
 * baslatir. Boylece ayri bir `gelistir serve` sart degil.
 *
 * ONEMLI: stdout MCP kanali. Her turlu gunluk stderr'e yazilir.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../src/config.js";
import { createServer, ensureToken } from "../src/server.js";
import { createCoreClient, createMcpServer } from "../src/mcp.js";

const log = (message) => process.stderr.write(`[gelistir-mcp] ${message}\n`);
const logger = { info: log, warn: log, error: log, debug: () => {} };

async function ping(base, token) {
  try {
    const res = await fetch(`${base}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    // Token da dogru mu? Yanlis token'la aracları calistiramayiz.
    const health = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    return health.ok;
  } catch {
    return false;
  }
}

/** Cekirdegi bul ya da bu surecin icinde baslat. */
async function ensureCore(config) {
  const base = `http://${config.host}:${config.port}`;
  const token = ensureToken();

  if (await ping(base, token)) {
    log(`calisan cekirdege baglandi: ${base}`);
    return { base, token, hosted: false };
  }

  const { server } = await createServer({ config, logger });
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });
    log(`cekirdek bu surecte baslatildi: ${base}`);
    return { base, token, hosted: true, server };
  } catch (err) {
    // Arada baska bir surec baglanmis olabilir.
    if (err.code === "EADDRINUSE" && (await ping(base, token))) {
      log(`port kullanimda, calisan cekirdege baglandi: ${base}`);
      return { base, token, hosted: false };
    }
    throw new Error(
      `Cekirdek baslatilamadi (${base}): ${err.message}. ` +
        "Portu degistirmek icin: gelistir config port=8799",
    );
  }
}

async function main() {
  const config = loadConfig();
  const { base, token, hosted, server } = await ensureCore(config);

  const core = createCoreClient({ base, token });
  const mcp = createMcpServer({ core });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP sunucusu hazir. Premiere panelini acmayi unutma.");

  const shutdown = async () => {
    try {
      await mcp.close();
    } catch {
      // kapanirken hata onemsiz
    }
    if (hosted && server) server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(`HATA: ${err.message}`);
  process.exit(1);
});
