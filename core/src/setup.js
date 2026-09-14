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

import { saveConfig } from "./config.js";

/** Premiere surumlerine karsilik gelen CSXS surumleri. */
export const CSXS_VERSIONS = [9, 10, 11, 12];

export const EXTENSION_ID = "com.gelistir.premiere";

/**
 * Kopyalanan panele birakilan iz.
 *
 * Windows'ta panel sembolik baglanti yerine KOPYALANIYOR, yani hedefte her
 * zaman normal bir klasor bulunuyor. Bu iz olmadan "bizim kopyaladigimiz
 * klasor" ile "kullanicinin elle koydugu klasor" ayirt edilemiyor ve her
 * guncelleme reddediliyordu.
 */
export const MARKER_FILE = ".gelistir-kurulum.json";

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
export function planSetup({ platform, home, env = {}, repoRoot, copy = false, force = false }) {
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

  // "managed": bu aracin kopyaladigi klasor (iz dosyasi var) - degistirilebilir
  // "directory": disaridan gelen bir klasor - dokunulmaz
  let existing = null;
  if (fs.existsSync(panelTarget)) {
    if (fs.lstatSync(panelTarget).isSymbolicLink()) existing = "symlink";
    else if (fs.existsSync(path.join(panelTarget, MARKER_FILE))) existing = "managed";
    else existing = "directory";
  }

  return {
    platform,
    panelSource,
    extensionsDir,
    panelTarget,
    existing,
    link,
    mcpEntry,
    coreEntry: path.join(repoRoot, "core", "bin", "gelistir.js"),
    // Panel cekirdegi kendi baslatabilsin diye ayarlara yazilacak degerler.
    trace: { repoRoot, nodePath: process.execPath },
    // -s user olmadan sunucu yalnizca o dizinde gorunur; video kurgularken
    // baska bir klasorde olacaksin, o yuzden kullanici kapsami sart.
    //
    // Yol duz cift tirnakla sarilir, JSON.stringify ILE DEGIL: Windows
    // yollarindaki ters boluyu kacisli yazardi (C:\\Users\\...) ve komut
    // cmd.exe'ye bozuk gidiyordu. Windows yollarinda cift tirnak karakteri
    // bulunamaz, bu yuzden duz sarma guvenli.
    mcpCommand: `claude mcp add premiere -s user -- node "${mcpEntry}"`,
    debugCommands: debugModeCommands(platform),
    force,
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
  } else if (plan.existing === "managed") {
    lines.push("   not    : onceki kurulumun kopyasi var, yenilenecek");
  } else if (plan.existing === "directory") {
    lines.push(
      plan.force
        ? "   not    : hedefte bizim olmayan bir klasor var; --zorla verildi, SILINECEK"
        : "   not    : hedefte bizim olmayan bir klasor var; UZERINE YAZILMAZ (--zorla ile sil)",
    );
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

  // Depo kokunu ve gercek node yolunu ayarlara yaz. Premiere paneli bunlari
  // okuyup cekirdegi kendi baslatiyor; panelin icindeki node Premiere'in
  // kendi sureci oldugu icin bu bilgiyi baska turlu bulamaz.
  try {
    saveConfig(plan.trace);
    done.push(`ayarlara yazildi: repoRoot, nodePath`);
  } catch (err) {
    failed.push({ step: "ayarlar", error: err.message });
  }

  // 1. Panel klasoru
  try {
    fs.mkdirSync(plan.extensionsDir, { recursive: true });

    const foreign = plan.existing === "directory" && !plan.force;
    if (foreign) {
      failed.push({
        step: "panel",
        error:
          `${plan.panelTarget} bu aracin olusturmadigi bir klasor (kurulum izi yok). ` +
          "Icinde kendi degisiklikleriniz olabilir; uzerine yazmiyorum. " +
          "Silmek icin: gelistir kurulum --uygula --zorla",
      });
    } else {
      if (plan.existing === "symlink") fs.unlinkSync(plan.panelTarget);
      else if (plan.existing) fs.rmSync(plan.panelTarget, { recursive: true, force: true });

      if (plan.link) {
        fs.symlinkSync(plan.panelSource, plan.panelTarget, "dir");
        done.push(`panel baglandi: ${plan.panelTarget}`);
      } else {
        fs.cpSync(plan.panelSource, plan.panelTarget, { recursive: true });
        // Sonraki guncellemede "bu kopya bizim" diyebilmek icin iz birak.
        fs.writeFileSync(
          path.join(plan.panelTarget, MARKER_FILE),
          JSON.stringify(
            { repoRoot: plan.trace.repoRoot, installedAt: new Date().toISOString() },
            null,
            2,
          ) + "\n",
        );
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
