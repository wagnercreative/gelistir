/**
 * Panel mantigi.
 *
 * Iki akis var:
 *   A) Premiere akisi : analiz -> zaman cizgisine uygula -> master al -> paketle
 *   B) Hizli akis     : dosyayi dogrudan cekirdege ver, Premiere'e dokunma
 */
(function () {
  var cs = new CSInterface();
  var core = new GelistirCore();
  var node = window.GelistirNode;

  var state = {
    hostReady: false,
    coreReady: false,
    source: "",
    planJob: null, // { id, bundleDir, stateFile, keeps, cutPlan }
    presetPath: localStorage.getItem("gelistir.preset") || "",
    busy: false,
  };

  // ------------------------------------------------------------ yardimcilar

  function $(id) {
    return document.getElementById(id);
  }

  function log(message, kind) {
    var box = $("log");
    var line = document.createElement("div");
    line.className = "log-line" + (kind ? " " + kind : "");
    var time = new Date().toLocaleTimeString();
    line.textContent = "[" + time + "] " + message;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function setStep(name, status, detail) {
    var el = $("step-" + name);
    if (!el) return;
    el.className = "step " + status;
    var detailEl = el.querySelector(".step-detail");
    if (detailEl) detailEl.textContent = detail || "";
  }

  function setBusy(busy) {
    state.busy = busy;
    document.querySelectorAll("button.action").forEach(function (b) {
      b.disabled = busy;
    });
    $("spinner").hidden = !busy;
    refreshButtons();
  }

  function refreshButtons() {
    if (state.busy) return;
    $("btn-analyze").disabled = !(state.hostReady && state.coreReady);
    $("btn-apply").disabled = !(state.planJob && state.hostReady);
    $("btn-export").disabled = !(state.planJob && state.hostReady);
    $("btn-quick").disabled = !state.coreReady;
  }

  /** ExtendScript cagrisini Promise'e cevirir ve "OK|a=b" yanitini nesneye ayristirir. */
  function host(fn, args) {
    var quoted = (args || []).map(function (a) {
      return '"' + String(a === null || a === undefined ? "" : a).replace(/["\\]/g, "\\$&") + '"';
    });
    var script = fn + "(" + quoted.join(", ") + ")";
    return new Promise(function (resolve, reject) {
      cs.evalScript(script, function (raw) {
        var text = String(raw || "");
        if (text === "EvalScript error." || text === "undefined" || text === "") {
          reject(new Error(fn + " calistirilamadi. Panel Premiere icinde mi acik?"));
          return;
        }
        var parts = text.split("|");
        if (parts[0] === "ERR") {
          reject(new Error(parts.slice(1).join("|") || "Bilinmeyen ExtendScript hatasi"));
          return;
        }
        if (parts[0] !== "OK") {
          reject(new Error("Beklenmeyen yanit: " + text.slice(0, 200)));
          return;
        }
        var out = {};
        for (var i = 1; i < parts.length; i++) {
          var idx = parts[i].indexOf("=");
          if (idx > 0) out[parts[i].slice(0, idx)] = parts[i].slice(idx + 1);
        }
        resolve(out);
      });
    });
  }

  function keepsToText(keeps) {
    return keeps
      .map(function (k) {
        return k.start.toFixed(3) + "," + k.end.toFixed(3);
      })
      .join(";");
  }

  function mmss(seconds) {
    var s = Math.max(0, Math.round(Number(seconds) || 0));
    var m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  }

  function joinPath() {
    var parts = Array.prototype.slice.call(arguments);
    if (node.path) return node.path.join.apply(node.path, parts);
    return parts.join("/");
  }

  function dirName(file) {
    if (node.path) return node.path.dirname(file);
    return String(file).replace(/[\\/][^\\/]*$/, "");
  }

  function baseName(file) {
    var name = String(file).replace(/^.*[\\/]/, "");
    return name.replace(/\.[^.]+$/, "");
  }

  // ------------------------------------------------------------ baglanti

  function connectHost() {
    if (!cs.isAvailable()) {
      log("CEP koprusu yok - panel Premiere disinda aciliyor.", "warn");
      $("host-status").textContent = "Premiere: bagli degil";
      return Promise.resolve();
    }
    return host("gelistirPing")
      .then(function (info) {
        state.hostReady = true;
        $("host-status").textContent =
          "Premiere " + (info.version || "") + (info.project ? " - " + info.project : "");
        $("host-status").className = "status ok";
      })
      .catch(function (err) {
        state.hostReady = false;
        $("host-status").textContent = "Premiere: " + err.message;
        $("host-status").className = "status bad";
      });
  }

  function connectCore() {
    return core
      .health()
      .then(function (h) {
        state.coreReady = true;
        $("core-status").textContent = "Cekirdek bagli - " + h.model;
        $("core-status").className = "status ok";

        var chips = [];
        chips.push(chip("ffmpeg", h.ffmpeg));
        chips.push(chip("ffprobe", h.ffprobe));
        chips.push(chip(h.whisper ? "whisper: " + h.whisper : "whisper yok", Boolean(h.whisper)));
        chips.push(chip(h.hasApiKey ? "API anahtari var" : "API anahtari yok", h.hasApiKey));
        $("chips").innerHTML = "";
        chips.forEach(function (c) {
          $("chips").appendChild(c);
        });

        if (!h.ffmpeg) log("ffmpeg bulunamadi - kesim ve kodlama yapilamaz.", "error");
        if (!h.whisper) log("whisper yok: dokum, altyazi ve bolumler uretilemez.", "warn");
        if (!h.hasApiKey) log("ANTHROPIC_API_KEY yok: sadece sessizlik kesimi yapilir.", "warn");
      })
      .catch(function (err) {
        state.coreReady = false;
        $("core-status").textContent = err.message;
        $("core-status").className = "status bad";
        $("token-row").hidden = false;
      });
  }

  function chip(label, ok) {
    var el = document.createElement("span");
    el.className = "chip " + (ok ? "ok" : "bad");
    el.textContent = label;
    return el;
  }

  // ------------------------------------------------------------ akis A: analiz

  function analyze() {
    setBusy(true);
    setStep("analyze", "running", "kaynak bulunuyor");
    host("gelistirPrimarySource")
      .then(function (info) {
        state.source = info.path;
        log("Kaynak: " + info.path);
        var outDir = joinPath(dirName(info.path), baseName(info.path) + "-youtube");
        return core.createJob({ input: info.path, outDir: outDir, mode: "plan" });
      })
      .then(function (res) {
        var id = res.job.id;
        log("Plan isi basladi (#" + id + ")");
        return core.follow(id, function (e) {
          setStep("analyze", "running", e.label + (e.detail ? ": " + e.detail : ""));
          if (e.detail) log(e.label + ": " + e.detail);
        });
      })
      .then(function (job) {
        var plan = job.result.cutPlan;
        state.planJob = {
          id: job.id,
          bundleDir: job.result.bundleDir,
          stateFile: joinPath(job.result.bundleDir, "job.json"),
          keeps: plan.keeps,
          cutPlan: plan,
        };
        setStep("analyze", "done",
          mmss(plan.sourceDuration) + " -> " + mmss(plan.outputDuration) +
          " (" + Math.max(0, plan.keeps.length - 1) + " kesim)");
        log(
          "Plan hazir: " + plan.keeps.length + " parca, " +
          plan.removedSeconds.toFixed(1) + " sn atiliyor (%" +
          (plan.removedRatio * 100).toFixed(1) + ")",
          "ok",
        );
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
    var rows = (result.planResult && result.planResult.removals) || [];
    var byKind = {};
    rows.forEach(function (r) {
      byKind[r.kind] = (byKind[r.kind] || 0) + (r.end - r.start);
    });
    var labels = {
      silence: "Sessizlik",
      deadair: "Olu hava",
      filler: "Dolgu sozcugu",
      retake: "Tekrar cekim",
      offtopic: "Konu disi",
      error: "Hatali bilgi",
    };
    var html = "<h3>Kesim ozeti</h3><ul>";
    Object.keys(byKind).forEach(function (kind) {
      html += "<li>" + (labels[kind] || kind) + ": " + byKind[kind].toFixed(1) + " sn</li>";
    });
    if (!Object.keys(byKind).length) html += "<li>Sadece sessizlik kesimi</li>";
    html += "</ul>";

    var chapters = result.chapters || [];
    if (chapters.length) {
      html += "<h3>Bolumler</h3><ul>";
      chapters.forEach(function (c) {
        html += "<li>" + mmss(c.time) + " " + c.title + "</li>";
      });
      html += "</ul>";
    }
    box.innerHTML = html;
  }

  // ------------------------------------------------------------ akis A: uygula

  function applyCutPlan() {
    if (!state.planJob) return;
    setBusy(true);
    setStep("apply", "running", "zaman cizgisi kuruluyor");
    var name = "Gelistir - " + baseName(state.source);
    host("gelistirApplyCutPlan", [keepsToText(state.planJob.keeps), state.source, name])
      .then(function (info) {
        setStep("apply", "done", info.placed + " parca, " + mmss(info.duration));
        log("Yeni sequence: " + info.sequence + " (" + info.placed + " parca)", "ok");
        log("Orijinal sequence'e dokunulmadi; istedigin gibi elle duzeltebilirsin.");
      })
      .catch(function (err) {
        setStep("apply", "error", err.message);
        log(err.message, "error");
      })
      .then(function () {
        setBusy(false);
      });
  }

  // ------------------------------------------------------------ akis A: master + paket

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
      log("Preset: " + state.presetPath);
    }
  }

  /** AME arka planda kodluyor; dosya boyutu sabitlenene kadar bekle. */
  function waitForFile(file, timeoutMs) {
    var fs = node.fs;
    if (!fs) return Promise.reject(new Error("Dosya izleme icin node erisimi gerekli"));
    var deadline = Date.now() + (timeoutMs || 1000 * 60 * 60);
    var lastSize = -1;
    var stableCount = 0;
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
          stableCount++;
          if (stableCount >= 3) {
            clearInterval(timer);
            resolve(size);
            return;
          }
        } else {
          stableCount = 0;
        }
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
      .then(function (info) {
        log("Media Encoder kuyruga alindi: " + info.output);
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
        log("Paket hazir: " + job.result.bundleDir, "ok");
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

  // ------------------------------------------------------------ akis B: hizli

  function quickRun() {
    setBusy(true);
    var pick = Promise.resolve(state.source);
    if (!state.source && window.cep && window.cep.fs) {
      var result = window.cep.fs.showOpenDialog(false, false, "Video sec", "", [
        "mp4", "mov", "mxf", "mkv", "avi",
      ]);
      pick = Promise.resolve(result && result.data && result.data[0]);
    } else if (!state.source) {
      pick = host("gelistirPrimarySource").then(function (i) {
        return i.path;
      });
    }

    pick
      .then(function (file) {
        if (!file) throw new Error("Dosya secilmedi");
        state.source = file;
        log("Hizli akis: " + file);
        var outDir = joinPath(dirName(file), baseName(file) + "-youtube");
        return core.createJob({ input: file, outDir: outDir, mode: "full" });
      })
      .then(function (res) {
        setStep("quick", "running", "basladi");
        return core.follow(res.job.id, function (e) {
          setStep("quick", "running", e.label + (e.detail ? ": " + e.detail : ""));
          if (e.step === "cut" && e.detail) log(e.detail);
        });
      })
      .then(function (job) {
        setStep("quick", "done", job.result.bundleDir);
        log("Paket hazir: " + job.result.bundleDir, "ok");
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
      "<p class='hint'>Chrome eklentisi bu isin metadata'sini YouTube Studio'ya " +
      "doldurabilir. Yayinlama dugmesine kendin basmalisin.</p>";
    box.innerHTML = html;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ------------------------------------------------------------ baslangic

  function init() {
    var bg = cs.isAvailable() ? cs.hostBackgroundColor() : null;
    if (bg) document.body.style.background = bg;
    if (state.presetPath) $("preset-label").textContent = state.presetPath;

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

    log("Panel hazir. Terminalde `gelistir serve` calistigindan emin ol.");
    connectHost().then(connectCore).then(refreshButtons);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
