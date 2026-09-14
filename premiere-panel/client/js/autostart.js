/**
 * Cekirdegi panelden baslatma.
 *
 * Panel calismak icin bir cekirdege ihtiyac duyuyor ve kullanicinin her
 * seferinde ayri bir pencere acmasi gereksiz bir yuk. Cekirdek kapaliysa
 * panel onu kendisi baslatabiliyor.
 *
 * Iki bilgi gerekiyor ve ikisini de panel kendi basina bulamaz:
 *   - gercek node yolu: panelin icindeki node Premiere'in kendi surecidir,
 *     process.execPath Premiere'i gosterir
 *   - depo koku: panel Windows'ta CEP dizinine KOPYALANDIGI icin deponun
 *     nerede oldugunu bilemez
 *
 * Ikisini de `gelistir kurulum --uygula` ~/.gelistir/config.json icine
 * yaziyor; burada onlari okuyoruz.
 */
(function (global) {
  var node = global.GelistirNode;

  function configPath() {
    if (!node.os || !node.path) return null;
    return node.path.join(node.os.homedir(), ".gelistir", "config.json");
  }

  function readConfig() {
    var file = configPath();
    if (!file || !node.fs) return null;
    try {
      return JSON.parse(node.fs.readFileSync(file, "utf8"));
    } catch (err) {
      return null;
    }
  }

  /**
   * Cekirdegi arka planda baslatir.
   * @returns {{ok: boolean, reason?: string, command?: string, pid?: number}}
   */
  function start() {
    if (!node.fs || !node.path) {
      return { ok: false, reason: "Panelde node erisimi yok (manifest: --enable-nodejs)." };
    }

    var cfg = readConfig();
    if (!cfg || !cfg.nodePath || !cfg.repoRoot) {
      return {
        ok: false,
        reason:
          "Ayarlarda node yolu ya da depo koku yok. Bir kez " +
          "`gelistir kurulum --uygula` calistir.",
      };
    }

    var entry = node.path.join(cfg.repoRoot, "core", "bin", "gelistir.js");
    if (!node.fs.existsSync(entry)) {
      return { ok: false, reason: "Cekirdek dosyasi bulunamadi: " + entry };
    }
    if (!node.fs.existsSync(cfg.nodePath)) {
      return { ok: false, reason: "node bulunamadi: " + cfg.nodePath };
    }

    var childProcess;
    try {
      childProcess = require("child_process");
    } catch (err) {
      return { ok: false, reason: "child_process yuklenemedi: " + err.message };
    }

    try {
      // detached + unref: Premiere kapaninca cekirdek olmesin, panel de
      // surecin cikisini beklemesin.
      var child = childProcess.spawn(cfg.nodePath, [entry, "serve"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return { ok: true, pid: child.pid, command: cfg.nodePath + " " + entry + " serve" };
    } catch (err) {
      return { ok: false, reason: String(err.message || err) };
    }
  }

  global.GelistirAutostart = { start: start, readConfig: readConfig, configPath: configPath };
})(window);
