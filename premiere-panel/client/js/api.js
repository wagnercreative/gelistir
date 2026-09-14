/**
 * Yerel cekirdek (gelistir-core) istemcisi.
 *
 * Token ~/.gelistir/token dosyasindan okunur. Panelde node erisimi acik
 * (manifest'te --enable-nodejs), o yuzden dosyayi dogrudan okuyabiliyoruz;
 * okunamazsa kullanici token'i elle girebilir.
 */
(function (global) {
  var nodeFs = null;
  var nodeOs = null;
  var nodePath = null;
  try {
    nodeFs = require("fs");
    nodeOs = require("os");
    nodePath = require("path");
  } catch (err) {
    // node kapali: token elle girilir
  }

  function tokenFilePath() {
    if (!nodeOs || !nodePath) return null;
    return nodePath.join(nodeOs.homedir(), ".gelistir", "token");
  }

  function readTokenFromDisk() {
    var file = tokenFilePath();
    if (!file || !nodeFs) return "";
    try {
      return String(nodeFs.readFileSync(file, "utf8")).trim();
    } catch (err) {
      return "";
    }
  }

  function Core(options) {
    options = options || {};
    this.host = options.host || "127.0.0.1";
    this.port = options.port || 8787;
    this.token = options.token || readTokenFromDisk() || localStorage.getItem("gelistir.token") || "";
  }

  Core.prototype.base = function () {
    return "http://" + this.host + ":" + this.port;
  };

  Core.prototype.setToken = function (token) {
    this.token = String(token || "").trim();
    try {
      localStorage.setItem("gelistir.token", this.token);
    } catch (err) {
      // ozel mod / depolama kapali
    }
  };

  Core.prototype.request = function (method, path, body) {
    var self = this;
    var init = {
      method: method,
      headers: { authorization: "Bearer " + this.token },
    };
    if (body) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(this.base() + path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : {};
        } catch (err) {
          throw new Error("Cekirdek gecersiz yanit dondu: " + text.slice(0, 200));
        }
        if (!res.ok) {
          var message = data && data.error ? data.error : "HTTP " + res.status;
          if (res.status === 401) {
            message += " (token: " + (tokenFilePath() || "elle gir") + ")";
          }
          var err = new Error(message);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (err instanceof TypeError) {
        throw new Error(
          "Cekirdege ulasilamadi (" + self.base() + "). Terminalde `gelistir serve` calisiyor mu?",
        );
      }
      throw err;
    });
  };

  Core.prototype.ping = function () {
    return this.request("GET", "/ping");
  };
  Core.prototype.health = function () {
    return this.request("GET", "/health");
  };
  Core.prototype.config = function () {
    return this.request("GET", "/config");
  };
  Core.prototype.saveConfig = function (patch) {
    return this.request("POST", "/config", { config: patch });
  };
  Core.prototype.createJob = function (payload) {
    return this.request("POST", "/jobs", payload);
  };
  Core.prototype.job = function (id) {
    return this.request("GET", "/jobs/" + id);
  };
  Core.prototype.events = function (id, since) {
    return this.request("GET", "/jobs/" + id + "/events?since=" + (since || 0));
  };
  Core.prototype.cancel = function (id) {
    return this.request("POST", "/jobs/" + id + "/cancel", {});
  };

  /**
   * Is bitene kadar olaylari izler.
   * onEvent her yeni olay icin, sonuc ise tamamlanan is nesnesiyle doner.
   */
  Core.prototype.follow = function (id, onEvent) {
    var self = this;
    var since = 0;
    return new Promise(function (resolve, reject) {
      var timer = setInterval(function () {
        self
          .events(id, since)
          .then(function (data) {
            since = data.last;
            (data.events || []).forEach(function (e) {
              if (onEvent) onEvent(e);
            });
            if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
              clearInterval(timer);
              self.job(id).then(function (res) {
                if (data.status === "done") resolve(res.job);
                else reject(new Error(res.job.error || "Is " + data.status));
              }, reject);
            }
          })
          .catch(function (err) {
            clearInterval(timer);
            reject(err);
          });
      }, 700);
    });
  };

  global.GelistirCore = Core;
  global.GelistirNode = { fs: nodeFs, os: nodeOs, path: nodePath, tokenFilePath: tokenFilePath };
})(window);
