/**
 * Panel mantigi.
 *
 * Ana arayuz sohbet: kullanici ne istedigini yazar, cekirdekteki ajan
 * Premiere araclarini cagirir, panel bu araclari ExtendScript ile kosturur.
 *
 * Altta ayrica sohbetsiz, sabit adimli bir akis var (tek tusla).
 */
(function () {
  var host = GelistirHost.host;
  var cs = GelistirHost.cs;
  var core = new GelistirCore();
  var node = window.GelistirNode;
  var agent = null;
  var executor = null;
  var coreRetryTimer = null;

  var state = {
    hostReady: false,
    coreReady: false,
    source: "",
    planJob: null,
    presetPath: localStorage.getItem("gelistir.preset") || "",
    coreHintShown: false,
    autostartTried: false,
    chatAvailable: false,
    renderedLog: 0,
    chatBusy: false,
    busy: false,
  };

  var TOOL_LABELS = {
    premiere_get_project: "projeye bakiyor",
    premiere_get_sequence: "zaman cizgisini okuyor",
    premiere_get_primary_source: "kaynak dosyayi buluyor",
    premiere_apply_keeps: "kesimleri yeni sequence'e diziyor",
    premiere_set_clip_enabled: "klibi devre disi birakiyor",
    premiere_delete_clip: "klip siliyor",
    premiere_trim_clip: "klibi kirpiyor",
    premiere_set_clip_gain: "ses kazancini ayarliyor",
    premiere_add_markers: "marker koyuyor",
    premiere_set_playhead: "oynatma kafasini tasiyor",
    premiere_export_sequence: "Media Encoder'a gonderiyor",
    media_probe: "dosyayi inceliyor",
    media_transcribe: "konusmayi yaziya ceviriyor",
    media_detect_silence: "sessizlikleri ariyor",
    transcript_read: "dokumu okuyor",
    build_cut_plan: "kesim planini kuruyor",
    deliver_youtube_package: "yayina hazir paketi yaziyor",
  };

  // ------------------------------------------------------------ yardimcilar

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function log(message, kind) {
    var box = $("log");
    var line = document.createElement("div");
    line.className = "log-line" + (kind ? " " + kind : "");
    line.textContent = "[" + new Date().toLocaleTimeString() + "] " + message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function mmss(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function joinPath() {
    var parts = Array.prototype.slice.call(arguments);
    return node.path ? node.path.join.apply(node.path, parts) : parts.join("/");
  }

  function dirName(file) {
    return node.path ? node.path.dirname(file) : String(file).replace(/[\\/][^\\/]*$/, "");
  }

  function baseName(file) {
    return String(file).replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  }

  // ------------------------------------------------------------ sohbet

  function addMessage(role, html) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = html;
    $("messages").appendChild(el);
    $("messages").scrollTop = $("messages").scrollHeight;
    return el;
  }

  /** Cekirdegin log'u dogrunun kaynagi; sadece yeni satirlari ekliyoruz. */
  function renderSessionLog(view) {
    var entries = view.log || [];
    for (var i = state.renderedLog; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.role === "user") {
        addMessage("user", escapeHtml(entry.text));
      } else if (entry.role === "assistant") {
        addMessage("assistant", formatAssistant(entry.text));
      } else if (entry.role === "tools") {
        var names = (entry.calls || []).map(function (c) {
          return TOOL_LABELS[c.name] || c.name;
        });
        addMessage("tool", "&#9881; " + escapeHtml(names.join(", ")));
      } else if (entry.role === "progress") {
        addMessage("progress", escapeHtml(entry.text));
      }
    }
    state.renderedLog = entries.length;
  }

  /** Cok basit bicimlendirme: satir sonlari, `kod`, - liste. */
  function formatAssistant(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br />");
  }

  function setThinking(on) {
    $("thinking").hidden = !on;
    $("btn-send").disabled = on || !state.coreReady || !state.chatAvailable;
    state.chatBusy = on;
  }

  function renderApproval(view) {
    var box = $("approval");
    if (!view.pendingApproval || !view.pendingApproval.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }

    var html = "<h3>Onay gerekiyor</h3>";
    view.pendingApproval.forEach(function (item) {
      html +=
        '<div class="approval-item">' +
        "<div class=\"approval-name\">" + escapeHtml(TOOL_LABELS[item.name] || item.name) + "</div>" +
        "<div class=\"approval-why\">" + escapeHtml(item.summary || "") + "</div>" +
        "<pre>" + escapeHtml(JSON.stringify(item.input, null, 2)) + "</pre>" +
        "</div>";
    });
    html +=
      '<div class="approval-actions">' +
      '<button id="btn-allow" class="primary">Izin ver</button>' +
      '<button id="btn-deny" class="small">Reddet</button>' +
      "</div>";

    box.innerHTML = html;
    box.hidden = false;

    var decide = function (decision) {
      var decisions = {};
      view.pendingApproval.forEach(function (item) {
        decisions[item.id] = decision;
      });
      box.hidden = true;
      setThinking(true);
      agent.approve(decisions).then(afterTurn, chatError);
    };
    $("btn-allow").addEventListener("click", function () {
      decide("allow");
    });
    $("btn-deny").addEventListener("click", function () {
      decide("deny");
    });
  }

  function afterTurn(view) {
    if (!view) {
      setThinking(false);
      return;
    }
    renderSessionLog(view);
    renderApproval(view);
    setThinking(view.status === "thinking" || view.status === "awaiting_tools");
    if (view.status === "error" && view.error) {
      addMessage("error", escapeHtml(view.error));
      setThinking(false);
    }
    if (view.degraded) {
      log("Beta ozellikleri kapali; sade istek modunda calisiliyor.", "warn");
    }
  }

  function chatError(err) {
    setThinking(false);
    addMessage("error", escapeHtml(String(err.message || err)));
    log(String(err.message || err), "error");
  }

  function sendChat(text) {
    var message = String(text || $("input").value || "").trim();
    if (!message || state.chatBusy) return;
    if (!state.chatAvailable) {
      addMessage(
        "error",
        "Panel sohbeti icin ANTHROPIC_API_KEY gerekli. Claude Code'dan " +
          "kullanmak icin anahtar gerekmiyor.",
      );
      return;
    }
    $("input").value = "";
    setThinking(true);

    if (!agent) {
      agent = new GelistirAgent(core, {
        onUpdate: function (view) {
          renderSessionLog(view);
        },
        onError: function (message) {
          log(message, "error");
        },
      });
    }

    agent.send(message).then(afterTurn, chatError);
  }

  function newSession() {
    agent = null;
    state.renderedLog = 0;
    $("messages").innerHTML = "";
    $("approval").hidden = true;
    addMessage("system", "Yeni oturum. Onceki konusma cekirdekte kaldi.");
    setThinking(false);
  }

  // ------------------------------------------------------------ baglanti

  function connectHost() {
    if (!cs.isAvailable()) {
      $("host-status").textContent = "Premiere: bagli degil (panel disinda)";
      $("host-status").className = "status bad";
      return Promise.resolve();
    }
    return host("gelistirPing").then(
      function (info) {
        state.hostReady = true;
        $("host-status").textContent =
          "Premiere " + (info.version || "") +
          (info.project ? " - " + info.project : "") +
          (info.activeSequence ? " / " + info.activeSequence : "");
        $("host-status").className = "status ok";
      },
      function (err) {
        state.hostReady = false;
        $("host-status").textContent = "Premiere: " + err.message;
        $("host-status").className = "status bad";
      },
    );
  }

  function chip(label, ok) {
    var el = document.createElement("span");
    el.className = "chip " + (ok ? "ok" : "bad");
    el.textContent = label;
    return el;
  }

  /**
   * Komut calistiriciyi baslatir. Bu dongu "Premiere baglantisi"nin kendisi:
   * Claude Code'daki MCP istemcisi de, panelin sohbeti de komutlari buradan
   * gecirir.
   */
  function startExecutor() {
    if (executor) return;
    executor = new GelistirExecutor(core, {
      onStatus: function (status) {
        var el = $("bridge-status");
        if (!status || !status.connected) {
          el.textContent = "Kopru: kapali" + (status && status.error ? " - " + status.error : "");
          el.className = "status bad";
          return;
        }
        var detail = "Kopru acik - Claude Code kullanabilir";
        if (status.running) detail += " (" + status.running + " komut calisiyor)";
        else if (status.lastCommand) detail += " - son: " + status.lastCommand.label;
        el.textContent = detail;
        el.className = "status ok";
      },
      onCommand: function (command) {
        log("Premiere: " + command.fn + "(" + command.args.join(", ") + ")");
      },
      onError: function (err) {
        log("Kopru: " + (err.message || err), "warn");
      },
    });
    executor.start();
    log("Komut calistirici basladi; Premiere araclari kullanilabilir.", "ok");
  }

  function connectCore() {
    return core.health().then(
      function (h) {
        state.coreReady = true;
        state.coreHintShown = false;
        state.autostartTried = false;
        if (coreRetryTimer) {
          clearTimeout(coreRetryTimer);
          coreRetryTimer = null;
        }
        $("core-status").textContent = "Cekirdek bagli - " + h.model;
        $("core-status").className = "status ok";
        $("token-row").hidden = true;

        // Cipler yalnizca arac durumunu gosterir. API anahtari buraya
        // konmuyordu cunku MCP yolunda gerekmiyor; gereksiz yere "eksik bir
        // sey var" izlenimi veriyordu.
        $("chips").innerHTML = "";
        [
          chip("ffmpeg", h.ffmpeg),
          chip("ffprobe", h.ffprobe),
          chip(h.whisper ? "whisper" : "whisper yok", Boolean(h.whisper)),
        ].forEach(function (c) {
          $("chips").appendChild(c);
        });

        if (!h.ffmpeg) log("ffmpeg bulunamadi - kesim ve kodlama yapilamaz.", "error");
        if (!h.whisper) log("whisper yok: dokum, altyazi ve bolumler uretilemez.", "warn");

        // Panel sohbeti kendi anahtarini ister; Claude Code yolu istemez.
        state.chatAvailable = Boolean(h.hasApiKey);
        $("chat-blocked").hidden = state.chatAvailable;
        $("suggestions").hidden = !state.chatAvailable;
        $("input").disabled = !state.chatAvailable;
        $("input").placeholder = state.chatAvailable
          ? "Ornek: girisi kisalt ve sessizlikleri at"
          : "Panel sohbeti icin ANTHROPIC_API_KEY gerekli";

        startExecutor();
      },
      function (err) {
        state.coreReady = false;
        $("core-status").textContent = err.message;
        $("core-status").className = "status bad";

        // Token hatasi ile "cekirdek yok" hatasi farkli seyler: sadece
        // yetkilendirme sorununda token alanini ac.
        var authProblem = err.status === 401;
        $("token-row").hidden = !authProblem;

        if (authProblem) {
          if (!state.coreHintShown) {
            state.coreHintShown = true;
            log("Token gecersiz. `gelistir token` cikisini yukaridaki alana yapistir.", "warn");
          }
        } else if (!state.autostartTried) {
          // Cekirdek kapali: bir kez kendimiz baslatmayi deneriz. Kullanicinin
          // her acilista ayri bir pencere acmasi gereksiz.
          state.autostartTried = true;
          $("core-status").textContent = "Cekirdek baslatiliyor...";
          var result = GelistirAutostart.start();
          if (result.ok) {
            log("Cekirdek baslatildi: " + result.command, "ok");
          } else {
            log("Cekirdek baslatilamadi: " + result.reason, "warn");
            log(
              "Elle baslat: depo kokundeki sunucu.cmd (Windows) ya da " +
                "`sh sunucu.sh`. Panel baglanti kurulunca kendiliginden toparlanir.",
              "warn",
            );
          }
        }
        // Kullaniciyi yenile dugmesine basmaya zorlamayalim: cekirdek
        // sonradan ayaga kalkarsa panel kendi kendine toparlansin.
        if (!authProblem) scheduleCoreRetry();
      },
    );
  }

  /** Cekirdek gelene kadar sessizce yeniden dener. */
  function scheduleCoreRetry() {
    if (coreRetryTimer) return;
    coreRetryTimer = setTimeout(function () {
      coreRetryTimer = null;
      $("core-status").textContent = "Cekirdek bekleniyor...";
      connectCore().then(refreshButtons);
    }, 3000);
  }

  // ------------------------------------------------------------ tek tusla akis

  function setStep(name, status, detail) {
    var el = $("step-" + name);
    if (!el) return;
    el.className = "step " + status;
    var detailEl = el.querySelector(".step-detail");
    if (detailEl) detailEl.textContent = detail || "";
  }

  function setBusy(busy) {
    state.busy = busy;
    Array.prototype.forEach.call(document.querySelectorAll("button.action"), function (b) {
      b.disabled = busy;
    });
    if (!busy) refreshButtons();
  }

  function refreshButtons() {
    $("btn-send").disabled = state.chatBusy || !state.coreReady || !state.chatAvailable;
    if (state.busy) return;
    $("btn-analyze").disabled = !(state.hostReady && state.coreReady);
    $("btn-apply").disabled = !(state.planJob && state.hostReady);
    $("btn-export").disabled = !(state.planJob && state.hostReady);
    $("btn-quick").disabled = !state.coreReady;
  }

  function keepsToText(keeps) {
    return keeps
      .map(function (k) {
        return k.start.toFixed(3) + "," + k.end.toFixed(3);
      })
      .join(";");
  }

  function analyze() {
    setBusy(true);
    setStep("analyze", "running", "kaynak bulunuyor");
    host("gelistirPrimarySource")
      .then(function (info) {
        state.source = info.path;
        log("Kaynak: " + info.path);
        return core.createJob({
          input: info.path,
          outDir: joinPath(dirName(info.path), baseName(info.path) + "-youtube"),
          mode: "plan",
        });
      })
      .then(function (res) {
        return core.follow(res.job.id, function (e) {
          setStep("analyze", "running", e.label + (e.detail ? ": " + e.detail : ""));
        });
      })
      .then(function (job) {
        var plan = job.result.cutPlan;
        state.planJob = {
          id: job.id,
          bundleDir: job.result.bundleDir,
          stateFile: joinPath(job.result.bundleDir, "job.json"),
          keeps: plan.keeps,
        };
        setStep("analyze", "done",
          mmss(plan.sourceDuration) + " -> " + mmss(plan.outputDuration) +
          " (" + Math.max(0, plan.keeps.length - 1) + " kesim)");
        (job.result.warnings || []).forEach(function (w) {
          log("Dikkat: " + w, "warn");
        });
        renderPlan(job.result);
      })
      .catch(function (err) {
        setStep("analyze", "error", err.message);
        log(err.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function renderPlan(result) {
    var box = $("plan");
    box.hidden = false;
    var byKind = {};
    ((result.planResult && result.planResult.removals) || []).forEach(function (r) {
      byKind[r.kind] = (byKind[r.kind] || 0) + (r.end - r.start);
    });
    var labels = {
      silence: "Sessizlik", deadair: "Olu hava", filler: "Dolgu sozcugu",
      retake: "Tekrar cekim", offtopic: "Konu disi", error: "Hatali bilgi",
    };
    var html = "<h3>Kesim ozeti</h3><ul>";
    var kinds = Object.keys(byKind);
    if (!kinds.length) html += "<li>Sadece sessizlik kesimi</li>";
    kinds.forEach(function (kind) {
      html += "<li>" + (labels[kind] || kind) + ": " + byKind[kind].toFixed(1) + " sn</li>";
    });
    html += "</ul>";
    if ((result.chapters || []).length) {
      html += "<h3>Bolumler</h3><ul>";
      result.chapters.forEach(function (c) {
        html += "<li>" + mmss(c.time) + " " + escapeHtml(c.title) + "</li>";
      });
      html += "</ul>";
    }
    box.innerHTML = html;
  }

  function applyCutPlan() {
    if (!state.planJob) return;
    setBusy(true);
    setStep("apply", "running", "zaman cizgisi kuruluyor");
    host("gelistirApplyKeeps", [
      keepsToText(state.planJob.keeps),
      state.source,
      "Gelistir - " + baseName(state.source),
    ])
      .then(function (info) {
        setStep("apply", "done", info.placed + " parca, " + mmss(info.duration));
        log("Yeni sequence: " + info.sequence + " (orijinale dokunulmadi)", "ok");
      })
      .catch(function (err) {
        setStep("apply", "error", err.message);
        log(err.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function choosePreset() {
    if (!window.cep || !window.cep.fs) {
      log("Dosya secici yok; preset yolunu elle gir.", "warn");
      return;
    }
    var result = window.cep.fs.showOpenDialog(false, false, "Export preset (.epr) sec", "", ["epr"]);
    if (result && result.data && result.data.length) {
      state.presetPath = result.data[0];
      localStorage.setItem("gelistir.preset", state.presetPath);
      $("preset-label").textContent = state.presetPath;
    }
  }

  /** AME arka planda kodluyor; dosya boyutu sabitlenene kadar bekle. */
  function waitForFile(file, timeoutMs) {
    var fs = node.fs;
    if (!fs) return Promise.reject(new Error("Dosya izleme icin node erisimi gerekli"));
    var deadline = Date.now() + (timeoutMs || 3600000);
    var lastSize = -1;
    var stable = 0;
    return new Promise(function (resolve, reject) {
      var timer = setInterval(function () {
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("Master dosyasi zamaninda hazir olmadi: " + file));
          return;
        }
        var size = 0;
        try {
          size = fs.statSync(file).size;
        } catch (err) {
          setStep("master", "running", "Media Encoder kuyrukta");
          return;
        }
        if (size > 0 && size === lastSize) {
          if (++stable >= 3) {
            clearInterval(timer);
            resolve(size);
            return;
          }
        } else stable = 0;
        lastSize = size;
        setStep("master", "running", (size / 1048576).toFixed(1) + " MB");
      }, 2000);
    });
  }

  function exportAndBundle() {
    if (!state.planJob) return;
    if (!state.presetPath) {
      log("Once bir export preset (.epr) sec.", "error");
      return;
    }
    setBusy(true);
    var masterPath = joinPath(state.planJob.bundleDir, "master.mp4");
    setStep("master", "running", "Media Encoder'a gonderiliyor");

    host("gelistirExportSequence", [masterPath, state.presetPath])
      .then(function () {
        return waitForFile(masterPath);
      })
      .then(function (size) {
        setStep("master", "done", (size / 1048576).toFixed(1) + " MB");
        setStep("bundle", "running", "paket hazirlaniyor");
        return core.createJob({
          input: masterPath,
          outDir: state.planJob.bundleDir,
          mode: "deliver",
          stateFile: state.planJob.stateFile,
        });
      })
      .then(function (res) {
        return core.follow(res.job.id, function (e) {
          setStep("bundle", "running", e.label + (e.detail ? ": " + e.detail : ""));
        });
      })
      .then(function (job) {
        setStep("bundle", "done", job.result.bundleDir);
        renderBundle(job.result);
      })
      .catch(function (err) {
        setStep("bundle", "error", err.message);
        log(err.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function quickRun() {
    setBusy(true);
    var file = state.source;
    if (window.cep && window.cep.fs) {
      var picked = window.cep.fs.showOpenDialog(false, false, "Video sec", "", [
        "mp4", "mov", "mxf", "mkv", "avi",
      ]);
      if (picked && picked.data && picked.data[0]) file = picked.data[0];
    }

    Promise.resolve(file)
      .then(function (chosen) {
        if (!chosen) throw new Error("Dosya secilmedi");
        state.source = chosen;
        return core.createJob({
          input: chosen,
          outDir: joinPath(dirName(chosen), baseName(chosen) + "-youtube"),
          mode: "full",
        });
      })
      .then(function (res) {
        return core.follow(res.job.id, function (e) {
          setStep("quick", "running", e.label + (e.detail ? ": " + e.detail : ""));
        });
      })
      .then(function (job) {
        setStep("quick", "done", job.result.bundleDir);
        renderBundle(job.result);
      })
      .catch(function (err) {
        setStep("quick", "error", err.message);
        log(err.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  function renderBundle(result) {
    var box = $("bundle");
    box.hidden = false;
    var meta = result.metadata || {};
    var html = "<h3>Yayina hazir</h3>";
    if (meta.title) html += "<p class='title'>" + escapeHtml(meta.title) + "</p>";
    html += "<ul>";
    Object.keys(result.files || {}).forEach(function (key) {
      html += "<li>" + key + ": <code>" + escapeHtml(String(result.files[key])) + "</code></li>";
    });
    html += "</ul>";
    if ((meta.warnings || []).length) {
      html += "<h3>Yuklemeden once</h3><ul>";
      meta.warnings.forEach(function (w) {
        html += "<li>" + escapeHtml(w) + "</li>";
      });
      html += "</ul>";
    }
    html +=
      "<p class='hint'>Yayinlama dugmesine bu panel basmaz. Chrome eklentisi " +
      "metinleri YouTube Studio'ya doldurabilir.</p>";
    box.innerHTML = html;
  }

  // ------------------------------------------------------------ baslangic

  function init() {
    var bg = cs.isAvailable() ? cs.hostBackgroundColor() : null;
    if (bg) document.body.style.background = bg;
    if (state.presetPath) $("preset-label").textContent = state.presetPath;

    $("btn-send").addEventListener("click", function () {
      sendChat();
    });
    $("input").addEventListener("keydown", function (e) {
      // Enter gonderir, Shift+Enter satir atlar.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll(".suggest"), function (b) {
      b.addEventListener("click", function () {
        sendChat(b.textContent);
      });
    });
    $("btn-new").addEventListener("click", newSession);

    $("btn-analyze").addEventListener("click", analyze);
    $("btn-apply").addEventListener("click", applyCutPlan);
    $("btn-export").addEventListener("click", exportAndBundle);
    $("btn-quick").addEventListener("click", quickRun);
    $("btn-preset").addEventListener("click", choosePreset);

    $("btn-reconnect").addEventListener("click", function () {
      connectHost().then(connectCore).then(refreshButtons);
    });
    $("btn-token").addEventListener("click", function () {
      core.setToken($("token-input").value);
      connectCore().then(refreshButtons);
    });

    window.addEventListener("beforeunload", function () {
      if (executor) executor.stop();
    });

    log("Panel hazir. Cekirdek icin `gelistir serve` ya da Claude Code'daki " +
        "MCP sunucusu calisiyor olmali.");
    connectHost().then(connectCore).then(refreshButtons);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
