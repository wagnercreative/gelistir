/**
 * CSInterface'in ihtiyac duydugumuz kadari.
 *
 * Adobe'un resmi CSInterface.js dosyasi da birebir uyumludur; istersen bu dosyayi
 * onunla degistirebilirsin. Burada sadece panelin kullandigi dort sey var:
 * evalScript, getSystemPath, getHostEnvironment, openURLInDefaultBrowser.
 */
(function (global) {
  function CSInterface() {}

  function bridge() {
    if (!global.__adobe_cep__) {
      throw new Error(
        "CEP kopruleri yok. Bu sayfa Premiere Pro paneli olarak acilmali " +
          "(Pencere > Uzantilar > Gelistir).",
      );
    }
    return global.__adobe_cep__;
  }

  CSInterface.prototype.isAvailable = function () {
    return Boolean(global.__adobe_cep__);
  };

  /** ExtendScript calistirir. callback'e her zaman string doner. */
  CSInterface.prototype.evalScript = function (script, callback) {
    bridge().evalScript(script, callback || function () {});
  };

  /**
   * type: "extension" | "userData" | "commonFiles" | "myDocuments" | "hostApplication"
   * Donen deger file:// URL'i olabilir; yerel yola cevirip veriyoruz.
   */
  CSInterface.prototype.getSystemPath = function (type) {
    var raw = bridge().getSystemPath(type);
    if (!raw) return "";
    var path = decodeURI(raw);
    if (path.indexOf("file:///") === 0) {
      path = path.substring(8);
      // Windows'ta "C:/..."; macOS/Linux'ta bas taraftaki / geri gelmeli.
      if (!/^[a-zA-Z]:/.test(path)) path = "/" + path;
    }
    return path;
  };

  CSInterface.prototype.getHostEnvironment = function () {
    try {
      return JSON.parse(bridge().getHostEnvironment());
    } catch (err) {
      return null;
    }
  };

  CSInterface.prototype.getExtensionID = function () {
    return bridge().getExtensionId();
  };

  CSInterface.prototype.openURLInDefaultBrowser = function (url) {
    return bridge().openURLInDefaultBrowser(url);
  };

  /** Premiere'in tema rengini panele tasir (koyu/acik tema uyumu). */
  CSInterface.prototype.hostBackgroundColor = function () {
    var env = this.getHostEnvironment();
    var color = env && env.appSkinInfo && env.appSkinInfo.panelBackgroundColor;
    if (!color || !color.color) return null;
    var c = color.color;
    return "rgb(" + Math.round(c.red) + "," + Math.round(c.green) + "," + Math.round(c.blue) + ")";
  };

  global.CSInterface = CSInterface;
})(window);
