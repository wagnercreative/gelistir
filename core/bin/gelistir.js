#!/usr/bin/env node
/**
 * gelistir - komut satiri arayuzu
 *
 *   gelistir serve                       yerel sunucuyu baslat (panel + eklenti buna baglanir)
 *   gelistir run <video> [-o <dizin>]    tek dosyayi yayina hazir pakete cevir
 *   gelistir plan <video> [-o <dizin>]   sadece dokum + kesim plani uret
 *   gelistir deliver <master> --state <job.json>
 *   gelistir doctor                      araclari ve ayarlari kontrol et
 *   gelistir config [anahtar=deger ...]  ayarlari goster / kaydet
 *   gelistir token                       yerel API token'ini yazdir
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import os from "node:os";

import { loadConfig, saveConfig, configPath, DEFAULTS } from "../src/config.js";
import { planSetup, formatPlan, applySetup } from "../src/setup.js";
import { serve, ensureToken, tokenPath } from "../src/server.js";
import { runPipeline } from "../src/pipeline.js";
import { detectWhisper } from "../src/transcribe.js";
import { run } from "../src/ffmpeg.js";
import { createLogger } from "../src/log.js";

const argv = process.argv.slice(2);
const command = argv[0] || "help";

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out") flags.out = args[++i];
    else if (a === "--state") flags.state = args[++i];
    else if (a === "--srt") flags.srt = args[++i];
    else if (a === "--model") flags.model = args[++i];
    else if (a === "--lang") flags.language = args[++i];
    else if (a === "--uygula") flags.apply = true;
    else if (a === "--kopyala") flags.copy = true;
    else if (a === "--no-subs") flags.subtitles = false;
    else if (a === "--burn-subs") flags.burnSubtitles = true;
    else if (a === "--keep-fillers") flags.removeFillers = false;
    else if (a === "--cut-offtopic") flags.removeOffTopic = true;
    else if (a.startsWith("-")) throw new Error(`Bilinmeyen secenek: ${a}`);
    else positional.push(a);
  }
  return { flags, positional };
}

const HELP = `gelistir - Claude destekli YouTube kurgu cekirdegi

Claude Code'dan Premiere'e baglanmak icin MCP sunucusunu ekle:
  claude mcp add premiere -- node <bu-dizin>/bin/gelistir-mcp.js

Komutlar:
  gelistir kurulum [--uygula]     paneli yerine koy, PlayerDebugMode'u ac
  gelistir serve
  gelistir run <video> [-o dizin] [--srt dokum.srt] [--lang tr] [--burn-subs]
  gelistir plan <video> [-o dizin]
  gelistir deliver <master> --state <job.json> [-o dizin]
  gelistir doctor
  gelistir config [anahtar=deger ...]
  gelistir token

Secenekler:
  --uygula             kurulum: plani gercekten uygula (varsayilan: sadece goster)
  --kopyala            kurulum: sembolik baglanti yerine kopyala
  -o, --out <dizin>    paket dizini (varsayilan: <video>-youtube)
  --srt <dosya>        hazir dokum kullan (whisper yoksa)
  --lang <kod>         konusma dili (bos = otomatik)
  --keep-fillers       dolgu sozcuklerini atma
  --cut-offtopic       konu disi bolumleri de at
  --burn-subs          altyaziyi goruntuye yak
  --no-subs            altyazi uretme

Ortam: ANTHROPIC_API_KEY gerekli (yoksa sadece sessizlik kesimi yapilir).
`;

async function main() {
  const log = createLogger({ level: "info" });

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }

  if (command === "token") {
    process.stdout.write(`${ensureToken()}\n${tokenPath()}\n`);
    return;
  }

  if (command === "serve") {
    const { flags } = parseFlags(argv.slice(1));
    await serve({ config: loadConfig(flags), logger: log });
    return; // sunucu acik kalir
  }

  if (command === "config") {
    const pairs = argv.slice(1);
    if (pairs.length === 0) {
      const cfg = loadConfig();
      process.stdout.write(`${configPath()}\n\n`);
      for (const key of Object.keys(DEFAULTS)) {
        const changed = cfg[key] !== DEFAULTS[key] ? "  *" : "";
        process.stdout.write(`${key} = ${JSON.stringify(cfg[key])}${changed}\n`);
      }
      return;
    }
    const patch = {};
    for (const pair of pairs) {
      const idx = pair.indexOf("=");
      if (idx === -1) throw new Error(`anahtar=deger bekleniyordu: ${pair}`);
      patch[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    const saved = saveConfig(patch);
    process.stdout.write(`${configPath()} guncellendi:\n${JSON.stringify(saved, null, 2)}\n`);
    return;
  }

  if (command === "kurulum" || command === "setup") {
    const { flags } = parseFlags(argv.slice(1));
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const plan = planSetup({
      platform: process.platform,
      home: os.homedir(),
      env: process.env,
      repoRoot,
      copy: Boolean(flags.copy),
    });

    if (!flags.apply) {
      process.stdout.write(`${formatPlan(plan)}\n\n`);
      process.stdout.write(
        "Bunlar henuz YAPILMADI. Uygulamak icin:\n  gelistir kurulum --uygula\n",
      );
      return;
    }

    process.stdout.write(`${formatPlan(plan)}\n\nUygulaniyor...\n\n`);
    const { done, failed } = await applySetup(plan, {
      run: (command_, args) => run(command_, args),
    });
    for (const item of done) process.stdout.write(`  OK    ${item}\n`);
    for (const item of failed) process.stdout.write(`  HATA  ${item.step} - ${item.error}\n`);

    process.stdout.write(
      [
        "",
        "Sirada:",
        `  1. ${plan.mcpCommand}`,
        "  2. Premiere Pro'yu TAMAMEN kapat ve tekrar ac",
        "  3. Pencere > Uzantilar > Gelistir - YouTube kurgu",
        "  4. Panelde 'Kopru acik - Claude Code kullanabilir' yazmali",
        "",
      ].join("\n"),
    );
    return;
  }

  if (command === "doctor") {
    const cfg = loadConfig();
    const check = async (label, fn) => {
      try {
        const detail = await fn();
        process.stdout.write(`  OK    ${label}${detail ? ` (${detail})` : ""}\n`);
        return true;
      } catch (err) {
        process.stdout.write(`  EKSIK ${label} - ${err.message.split("\n")[0]}\n`);
        return false;
      }
    };
    process.stdout.write("gelistir doctor\n\n");
    await check("ffmpeg", async () => {
      const { stdout } = await run(cfg.ffmpeg, ["-version"]);
      return stdout.split("\n")[0].slice(0, 60);
    });
    await check("ffprobe", async () => {
      const { stdout } = await run(cfg.ffprobe, ["-version"]);
      return stdout.split("\n")[0].slice(0, 60);
    });
    await check("whisper", async () => {
      const bin = await detectWhisper(cfg.whisper);
      if (!bin) throw new Error("bulunamadi (dokum olmadan sadece sessizlik kesimi yapilir)");
      if (/cpp|whisper-cli|^main$/.test(path.basename(bin)) && !cfg.whisperModel) {
        throw new Error(`${bin} bulundu ama whisperModel ayarli degil`);
      }
      return bin;
    });
    await check("ANTHROPIC_API_KEY", async () => {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        throw new Error("ayarli degil");
      }
      return "ayarli";
    });
    process.stdout.write(`\nModel: ${cfg.model}\nAyarlar: ${configPath()}\n`);
    return;
  }

  if (["run", "plan", "deliver"].includes(command)) {
    const { flags, positional } = parseFlags(argv.slice(1));
    const input = positional[0];
    if (!input) throw new Error(`Kullanim: gelistir ${command} <dosya>`);
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`Dosya bulunamadi: ${resolved}`);

    const outDir =
      flags.out ||
      path.join(path.dirname(resolved), `${path.basename(resolved, path.extname(resolved))}-youtube`);

    let state = null;
    if (command === "deliver") {
      if (!flags.state) throw new Error("deliver icin --state <job.json> gerekli");
      state = JSON.parse(fs.readFileSync(path.resolve(flags.state), "utf8"));
    }

    const config = loadConfig(flags);
    let lastStep = null;
    const result = await runPipeline({
      input: resolved,
      outDir: path.resolve(outDir),
      mode: command === "run" ? "full" : command,
      srtPath: flags.srt ? path.resolve(flags.srt) : null,
      state,
      config,
      onEvent: ({ step, label, detail }) => {
        // TTY'de tek satiri gunceller; boru/dosyaya yazarken her satiri ayri basar.
        if (process.stdout.isTTY) {
          if (step !== lastStep) {
            process.stdout.write(`\n> ${label}`);
            lastStep = step;
          }
          if (detail) process.stdout.write(`\r> ${label}: ${detail}`.padEnd(78).slice(0, 78));
          return;
        }
        if (step !== lastStep) {
          process.stdout.write(`> ${label}\n`);
          lastStep = step;
        }
        if (detail) process.stdout.write(`  ${detail}\n`);
      },
    });

    process.stdout.write(`\n\nPaket: ${result.bundleDir}\n`);
    for (const [key, value] of Object.entries(result.files || {})) {
      process.stdout.write(`  ${key}: ${value}\n`);
    }
    if (result.warnings?.length) {
      process.stdout.write(`\nDikkat:\n`);
      for (const w of result.warnings) process.stdout.write(`  - ${w}\n`);
    }
    process.stdout.write(`\nSure: ${(result.elapsedMs / 1000).toFixed(1)} sn\n`);
    return;
  }

  throw new Error(`Bilinmeyen komut: ${command}\n\n${HELP}`);
}

main().catch((err) => {
  process.stderr.write(`\nHata: ${err.message}\n`);
  process.exit(1);
});
