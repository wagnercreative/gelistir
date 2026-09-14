/**
 * Komut calistirici.
 *
 * Panelin en onemli isi bu: cekirdege uzun-yoklama yapip Premiere'de
 * calistirilacak ExtendScript komutlarini almak. Komutu kim istemis olursa
 * olsun (Claude Code'daki MCP istemcisi, panelin kendi sohbeti, baska bir
 * istemci) hepsi ayni kuyruktan gelir.
 *
 * Panel acik olmadan Premiere araclari calismaz; bu dongu "baglanti"nin
 * kendisi.
 */
(function (global) {
  var POLL_WAIT_MS = 25000; // sunucu bu sure boyunca bekletir
  var RETRY_MS = 3000; // baglanti koptuysa yeniden deneme araligi

  function Executor(core, options) {
    options = options || {};
    this.core = core;
    this.running = false;
    this.onStatus = options.onStatus || function () {};
    this.onCommand = options.onCommand || function () {};
    this.onError = options.onError || function () {};
    this.consecutiveErrors = 0;
  }

  Executor.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.consecutiveErrors = 0;
    this.loop();
  };

  Executor.prototype.stop = function () {
    this.running = false;
    var self = this;
    // Cekirdek bekleyen komutlari bosa beklemesin.
    return this.core.request("POST", "/host/disconnect", {}).catch(function () {
      // kapanisti, hata onemsiz
      return null;
    }).then(function () {
      self.onStatus({ connected: false });
    });
  };

  Executor.prototype.loop = function () {
    var self = this;
    if (!this.running) return;

    this.core
      .request("GET", "/host/poll?wait=" + POLL_WAIT_MS)
      .then(function (res) {
        self.consecutiveErrors = 0;
        self.onStatus(res.status);
        var commands = res.commands || [];
        if (!commands.length) return null;
        return self.execute(commands);
      })
      .then(function () {
        if (self.running) self.loop();
      })
      .catch(function (err) {
        self.consecutiveErrors++;
        // Ilk hatayi bildir, sonrakileri sessizce yeniden dene: sunucu
        // yeniden baslatildiginda panel log'u dolmasin.
        if (self.consecutiveErrors === 1) self.onError(err);
        self.onStatus({ connected: false, error: String(err.message || err) });
        if (self.running) setTimeout(function () {
          self.loop();
        }, RETRY_MS);
      });
  };

  /** Komutlari sirayla calistirir (Premiere tek is parcacigi). */
  Executor.prototype.execute = function (commands) {
    var self = this;
    var results = [];
    var chain = Promise.resolve();

    commands.forEach(function (command) {
      chain = chain.then(function () {
        self.onCommand(command);
        return GelistirHost.hostRaw(command.fn, command.args).then(
          function (raw) {
            var isError = false;
            try {
              isError = JSON.parse(raw).ok === false;
            } catch (err) {
              isError = true; // JSON degilse bir sey ters gitmis
            }
            results.push({ id: command.id, content: raw, isError: isError });
          },
          function (err) {
            // Kopru hatasini da isteyene bildir; kendi basina karar verir.
            results.push({
              id: command.id,
              content: String(err.message || err),
              isError: true,
            });
          },
        );
      });
    });

    return chain.then(function () {
      return self.core.request("POST", "/host/results", { results: results });
    });
  };

  global.GelistirExecutor = Executor;
})(window);
