/**
 * Kurulum planlayicisi.
 *
 * Kurulumun makineye dokunan iki adimi var ve ikisi de elle yapilinca
 * hataya acik:
 *   1. panel klasorunu Adobe'un CEP uzanti dizinine koymak
 *   2. imzasiz panellere izin veren PlayerDebugMode ayarini yazmak
 *
 * Buradaki fonksiyonlar planı uretir (saf, test edilebilir); uygulama
 * kismi ayri ve varsayilan olarak calismaz - `--uygula` gerekir.
 */
import fs from "node:fs";
import path from "node:path";

/** Premiere surumlerine karsilik gelen CSXS surumleri. */
export const CSXS_VERSIONS = [9, 10, 11, 12];

export const EXTENSION_ID = "com.gelistir.premiere";

/** Adobe'un kullanici bazli CEP uzanti dizini. */
export function cepExtensionsDir({ platform, env = {}, home = "" }) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Adobe", "CEP", "extensions");
  }
  // Premiere Linux'ta yok; yol yine de hesaplanir ki plan anlasilir olsun.
  return path.join(home, ".adobe", "CEP", "extensions");
}

/** PlayerDebugMode'u acan komutlar (platforma gore). */
export function debugModeCommands(platform) {
  if (platform === "darwin") {
    return CSXS_VERSIONS.map((v) => ({
      label: `CSXS.${v} PlayerDebugMode`,
      command: "defaults",
      args: ["write", `com.adobe.CSXS.${v}`, "PlayerDebugMode", "1"],
    }));
  }
  if (platform === "win32") {
    return CSXS_VERSIONS.map((v) => ({
      label: `CSXS.${v} PlayerDebugMode`,
      command: "reg",
      args: [
        "add", `HKCU\\Software\\Adobe\\CSXS.${v}`,
        "/v", "PlayerDebugMode", "/t", "REG_SZ", "/d", "1", "/f",
      ],
    }));
  }
  return [];
}

/**
 * Kurulum planini cikarir. Hicbir sey degistirmez.
 *
 * @param {object} params
 * @param {string} params.platform  process.platform
 * @param {string} params.home      os.homedir()
 * @param {object} params.env       process.env
 * @param {string} params.repoRoot  gelistir deposunun koku
 * @param {boolean} params.copy     sembolik baglanti yerine kopyalama
 */
export function planSetup({ platform, home, env = {}, repoRoot, copy = false }) {
  const panelSource = path.join(repoRoot, "premiere-panel");
  const extensionsDir = cepExtensionsDir({ platform, env, home });
  const panelTarget = path.join(extensionsDir, EXTENSION_ID);
  const mcpEntry = path.join(repoRoot, "core", "bin", "gelistir-mcp.js");

  // Windows'ta sembolik baglanti yonetici ya da gelistirici modu ister;
  // orada varsayilan kopyalama.
  const link = !copy && platform !== "win32";

  const warnings = [];
  if (!fs.existsSync(panelSource)) {
    warnings.push(`Panel klasoru bulunamadi: ${panelSource}`);
  }
  if (!fs.existsSync(path.join(panelSource, "CSXS", "manifest.xml"))) {
    warnings.push("Panel klasorunde CSXS/manifest.xml yok; depo eksik olabilir.");
  }
  if (!fs.existsSync(mcpEntry)) {
    warnings.push(`MCP sunucusu bulunamadi: ${mcpEntry}`);
  }
  if (platform !== "darwin" && platform !== "win32") {
    warnings.push(
      `Premiere Pro ${platform} uzerinde calismiyor. Cekirdek ve MCP sunucusu ` +
        "calisir ama Premiere araclari kullanilamaz.",
    );
  }

  const existing = fs.existsSync(panelTarget)
    ? fs.lstatSync(panelTarget).isSymbolicLink()
      ? "symlink"
      : "directory"
    : null;

  return {
    platform,
    panelSource,
    extensionsDir,
    panelTarget,
    existing,
    link,
    mcpEntry,
    // -s user olmadan sunucu yalnizca o dizinde gorunur; video kurgularken
    // baska bir klasorde olacaksin, o yuzden kullanici kapsami sart.
    mcpCommand: `claude mcp add premiere -s user -- node ${JSON.stringify(mcpEntry)}`,
    debugCommands: debugModeCommands(platform),
    warnings,
  };
}

/** Planı insan okuyacak sekilde yazar. */
export function formatPlan(plan, { applied = false } = {}) {
  const verb = applied ? "yapildi" : "yapilacak";
  const lines = [`Kurulum plani (${plan.platform})`, ""];

  lines.push(`1. Panel klasoru (${verb})`);
  lines.push(`   kaynak : ${plan.panelSource}`);
  lines.push(`   hedef  : ${plan.panelTarget}`);
  lines.push(`   yontem : ${plan.link ? "sembolik baglanti" : "kopyalama"}`);
  if (plan.existing === "symlink") {
    lines.push("   not    : hedefte zaten bir baglanti var, yenilenecek");
  } else if (plan.existing === "directory") {
    lines.push("   not    : hedefte bir klasor var; UZERINE YAZILMAZ, elle sil");
  }

  lines.push("", `2. PlayerDebugMode (${verb})`);
  if (plan.debugCommands.length === 0) {
    lines.push("   bu platformda gerekmiyor");
  } else {
    for (const cmd of plan.debugCommands) {
      lines.push(`   ${cmd.command} ${cmd.args.join(" ")}`);
    }
  }

  lines.push("", "3. Claude Code'a MCP sunucusunu ekle (bunu SEN calistir)");
  lines.push(`   ${plan.mcpCommand}`);
  lines.push("   (-s user: her dizinden gorunur. Onsuz sadece o klasorde calisir.)");

  if (plan.warnings.length) {
    lines.push("", "Dikkat:");
    for (const w of plan.warnings) lines.push(`   - ${w}`);
  }

  return lines.join("\n");
}

/**
 * Planı uygular.
 * @param {function} run (command, args) => Promise  - surec calistirici
 */
export async function applySetup(plan, { run }) {
  const done = [];
  const failed = [];

  // 1. Panel klasoru
  try {
    fs.mkdirSync(plan.extensionsDir, { recursive: true });

    if (plan.existing === "directory") {
      failed.push({
        step: "panel",
        error:
          `${plan.panelTarget} zaten bir klasor. Icinde kendi degisiklikleriniz ` +
          "olabilir; uzerine yazmiyorum. Elle silip tekrar dene.",
      });
    } else {
      if (plan.existing === "symlink") fs.unlinkSync(plan.panelTarget);
      if (plan.link) {
        fs.symlinkSync(plan.panelSource, plan.panelTarget, "dir");
        done.push(`panel baglandi: ${plan.panelTarget}`);
      } else {
        fs.cpSync(plan.panelSource, plan.panelTarget, { recursive: true });
        done.push(`panel kopyalandi: ${plan.panelTarget}`);
      }
    }
  } catch (err) {
    failed.push({ step: "panel", error: err.message });
  }

  // 2. PlayerDebugMode
  for (const cmd of plan.debugCommands) {
    try {
      await run(cmd.command, cmd.args);
      done.push(cmd.label);
    } catch (err) {
      // Her Premiere surumu her CSXS anahtarini kullanmaz; tek tek basarisizlik
      // olumcul degil.
      failed.push({ step: cmd.label, error: err.message.split("\n")[0] });
    }
  }

  return { done, failed };
}
