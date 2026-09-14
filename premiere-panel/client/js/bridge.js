/**
 * ExtendScript koprusu.
 *
 * host/gelistir.jsx her fonksiyondan JSON metni donduruyor:
 *   {"ok":true, ...}  veya  {"ok":false,"error":"..."}
 *
 * hostRaw ham metni verir (ajan bunu oldugu gibi modele geri gonderir),
 * host ise cozulmus nesneyi verir ve ok:false ise hata atar.
 */
(function (global) {
  var cs = new CSInterface();

  function quote(value) {
    if (value === null || value === undefined) value = "";
    return '"' + String(value).replace(/[\\"]/g, "\\$&").replace(/\r?\n/g, "\\n") + '"';
  }

  function hostRaw(fn, args) {
    var script = fn + "(" + (args || []).map(quote).join(", ") + ")";
    return new Promise(function (resolve, reject) {
      if (!cs.isAvailable()) {
        reject(new Error("Panel Premiere icinde acik degil (CEP koprusu yok)."));
        return;
      }
      cs.evalScript(script, function (raw) {
        var text = String(raw === null || raw === undefined ? "" : raw);
        if (text === "" || text === "undefined" || text === "EvalScript error.") {
          reject(new Error(fn + " calistirilamadi. host/gelistir.jsx yuklendi mi?"));
          return;
        }
        resolve(text);
      });
    });
  }

  function host(fn, args) {
    return hostRaw(fn, args).then(function (text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(fn + " gecerli JSON dondurmedi: " + text.slice(0, 200));
      }
      if (!data.ok) throw new Error(data.error || "Bilinmeyen ExtendScript hatasi");
      return data;
    });
  }

  global.GelistirHost = { cs: cs, host: host, hostRaw: hostRaw };
})(window);
