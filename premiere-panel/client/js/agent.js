/**
 * Panel tarafi ajan surucusu.
 *
 * Cekirdek modelle konusur; Premiere araclarini panel calistirir. Akis:
 *   mesaj gonder -> durumu yokla -> "awaiting_tools" ise araclari Premiere'de
 *   kostur ve sonuclari gonder -> "awaiting_approval" ise kullaniciya sor ->
 *   "end_turn" veya "error" olunca dur.
 */
(function (global) {
  var POLL_MS = 700;

  function Agent(core, options) {
    this.core = core;
    this.sessionId = null;
    this.onUpdate = (options && options.onUpdate) || function () {};
    this.onError = (options && options.onError) || function () {};
    this.stopped = false;
  }

  Agent.prototype.start = function () {
    var self = this;
    return this.core.request("POST", "/agent/sessions", {}).then(function (res) {
      self.sessionId = res.session.id;
      self.onUpdate(res.session);
      return res;
    });
  };

  Agent.prototype.ensure = function () {
    return this.sessionId ? Promise.resolve() : this.start();
  };

  Agent.prototype.send = function (text) {
    var self = this;
    return this.ensure()
      .then(function () {
        return self.core.request("POST", "/agent/sessions/" + self.sessionId + "/message", {
          text: text,
        });
      })
      .then(function (res) {
        self.onUpdate(res.session);
        return self.pump();
      });
  };

  Agent.prototype.approve = function (decisions) {
    var self = this;
    return this.core
      .request("POST", "/agent/sessions/" + this.sessionId + "/approve", {
        decisions: decisions,
      })
      .then(function (res) {
        self.onUpdate(res.session);
        return self.pump();
      });
  };

  Agent.prototype.view = function () {
    return this.core
      .request("GET", "/agent/sessions/" + this.sessionId)
      .then(function (res) {
        return res.session;
      });
  };

  /** Bir duraga gelene kadar durumu izler. */
  Agent.prototype.pump = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var busy = false;

      var timer = setInterval(function () {
        if (busy || self.stopped) return;
        busy = true;

        self.view().then(
          function (view) {
            self.onUpdate(view);

            if (view.status === "awaiting_approval") {
              clearInterval(timer);
              resolve(view); // kullanici karar verecek
              return;
            }

            if (view.status === "end_turn") {
              clearInterval(timer);
              resolve(view);
              return;
            }

            if (view.status === "error") {
              clearInterval(timer);
              self.onError(view.error || "Bilinmeyen hata");
              resolve(view);
              return;
            }

            // "thinking" veya "awaiting_tools": beklemeye devam.
            // Premiere araclarini calistirici dongusu (executor.js) kosturuyor.
            busy = false;
          },
          function (err) {
            clearInterval(timer);
            reject(err);
          },
        );
      }, POLL_MS);
    });
  };

  global.GelistirAgent = Agent;
})(window);
