/**
 * Gelistir - Premiere Pro ExtendScript tarafi.
 *
 * Panel bu fonksiyonlari CSInterface.evalScript ile cagirir. Her fonksiyon bir
 * JSON metni dondurur:  {"ok":true, ...}  veya  {"ok":false,"error":"..."}
 *
 * ExtendScript'te JSON nesnesi her Premiere surumunde bulunmuyor, bu yuzden
 * kendi stringifier'imiz var. Ayristirma (parse) tarafi BILEREK yok: girdiler
 * duz konumsal arguman olarak geliyor. Model uretimi metni burada eval etmek
 * Premiere icinde kod calistirmak demek olurdu.
 */

// Premiere zamani "tick" tutar. 1 saniye = 254016000000 tick.
var TICKS_PER_SECOND = 254016000000;

// projectItem.setInPoint/setOutPoint icin medya turu: 4 = video+ses birlikte.
var MEDIATYPE_ANY = 4;

// encodeSequence workAreaType: 0 = butun sequence.
var ENCODE_ENTIRE_SEQUENCE = 0;

// Uzun zaman cizgilerinde yaniti sinirla; model baglamini sismesin.
var MAX_CLIPS_PER_RESPONSE = 240;

// ---------------------------------------------------------------- JSON cikti

function gsPad4(hex) {
  while (hex.length < 4) hex = "0" + hex;
  return hex;
}

function gsQuote(value) {
  var text = String(value);
  var out = '"';
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var code = text.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code > 0x7e) {
      // Turkce karakterler ve kontrol karakterleri kacisli gitsin; CEP
      // koprusunun kodlamasindan bagimsiz olarak dogru cozulur.
      out += "\\u" + gsPad4(code.toString(16));
    } else out += ch;
  }
  return out + '"';
}

function gsJson(value) {
  if (value === null || value === undefined) return "null";
  var type = typeof value;
  if (type === "number") return isFinite(value) ? String(value) : "null";
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return gsQuote(value);
  if (value instanceof Array) {
    var items = [];
    for (var i = 0; i < value.length; i++) items.push(gsJson(value[i]));
    return "[" + items.join(",") + "]";
  }
  var pairs = [];
  for (var key in value) {
    if (value.hasOwnProperty(key)) pairs.push(gsQuote(key) + ":" + gsJson(value[key]));
  }
  return "{" + pairs.join(",") + "}";
}

function gsOk(payload) {
  var out = { ok: true };
  for (var key in payload) {
    if (payload.hasOwnProperty(key)) out[key] = payload[key];
  }
  return gsJson(out);
}

function gsErr(message) {
  return gsJson({ ok: false, error: String(message) });
}

// ---------------------------------------------------------------- yardimcilar

function gsSeconds(time) {
  if (!time) return 0;
  if (time.seconds !== undefined && time.seconds !== null) return Number(time.seconds);
  if (time.ticks !== undefined) return Number(time.ticks) / TICKS_PER_SECOND;
  return 0;
}

function gsTime(seconds) {
  var t = new Time();
  t.seconds = Number(seconds);
  return t;
}

function gsRound(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function gsBool(value) {
  return value === true || value === "true" || value === "1";
}

function gsInt(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function gsProject() {
  if (!app.project) throw new Error("Acik proje yok");
  return app.project;
}

function gsSequenceByName(name) {
  var project = gsProject();
  if (!name) {
    if (!project.activeSequence) throw new Error("Aktif sequence yok. Once bir sequence ac.");
    return project.activeSequence;
  }
  for (var i = 0; i < project.sequences.numSequences; i++) {
    if (project.sequences[i].name === name) return project.sequences[i];
  }
  throw new Error("Sequence bulunamadi: " + name);
}

function gsTrack(seq, trackType, trackIndex) {
  var list = String(trackType) === "audio" ? seq.audioTracks : seq.videoTracks;
  var index = gsInt(trackIndex, 0);
  if (index < 0 || index >= list.numTracks) {
    throw new Error(
      (trackType || "video") + " kanali " + index + " yok (toplam " + list.numTracks + ")"
    );
  }
  return list[index];
}

function gsClip(seq, trackType, trackIndex, clipIndex) {
  var track = gsTrack(seq, trackType, trackIndex);
  var index = gsInt(clipIndex, -1);
  if (index < 0 || index >= track.clips.numItems) {
    throw new Error("Klip " + index + " yok (kanalda " + track.clips.numItems + " klip var)");
  }
  return track.clips[index];
}

function gsMediaPath(item) {
  if (!item) return "";
  try {
    return item.getMediaPath() || "";
  } catch (e) {
    return "";
  }
}

function gsDescribeClip(clip, index) {
  return {
    index: index,
    name: clip.name,
    start: gsRound(gsSeconds(clip.start)),
    end: gsRound(gsSeconds(clip.end)),
    inPoint: gsRound(gsSeconds(clip.inPoint)),
    outPoint: gsRound(gsSeconds(clip.outPoint)),
    disabled: clip.disabled === true,
    source: gsMediaPath(clip.projectItem)
  };
}

function gsFindProjectItemByPath(item, target) {
  try {
    if (item.children && item.children.numItems > 0) {
      for (var i = 0; i < item.children.numItems; i++) {
        var found = gsFindProjectItemByPath(item.children[i], target);
        if (found) return found;
      }
      return null;
    }
    if (gsMediaPath(item) === target) return item;
  } catch (e) {
    // klasor olmayan ogelerde children erisimi hata verebilir
  }
  return null;
}

function gsParseKeeps(text) {
  var keeps = [];
  if (!text) return keeps;
  var parts = String(text).split(";");
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var pair = parts[i].split(",");
    var start = parseFloat(pair[0]);
    var end = parseFloat(pair[1]);
    if (isNaN(start) || isNaN(end) || end <= start) continue;
    keeps.push({ start: start, end: end });
  }
  return keeps;
}

// ---------------------------------------------------------------- okuma

function gelistirPing() {
  try {
    var project = app.project;
    return gsOk({
      host: "PPRO",
      version: app.version,
      project: project ? project.name : "",
      activeSequence: project && project.activeSequence ? project.activeSequence.name : ""
    });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirGetProject() {
  try {
    var project = gsProject();
    var sequences = [];
    for (var i = 0; i < project.sequences.numSequences; i++) {
      var seq = project.sequences[i];
      sequences.push({
        name: seq.name,
        id: seq.sequenceID,
        duration: gsRound(gsSeconds(seq.end)),
        active: project.activeSequence && seq.sequenceID === project.activeSequence.sequenceID
      });
    }
    return gsOk({ name: project.name, path: project.path, sequences: sequences });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirGetSequence(sequenceName, maxClips) {
  try {
    var seq = gsSequenceByName(sequenceName);
    var limit = gsInt(maxClips, MAX_CLIPS_PER_RESPONSE);
    if (limit <= 0 || limit > MAX_CLIPS_PER_RESPONSE) limit = MAX_CLIPS_PER_RESPONSE;

    var total = 0;
    var truncated = false;
    var videoTracks = [];
    var audioTracks = [];

    var collect = function (list, target) {
      for (var t = 0; t < list.numTracks; t++) {
        var track = list[t];
        var clips = [];
        for (var c = 0; c < track.clips.numItems; c++) {
          total++;
          if (total > limit) {
            truncated = true;
            break;
          }
          clips.push(gsDescribeClip(track.clips[c], c));
        }
        target.push({ index: t, name: track.name, clipCount: track.clips.numItems, clips: clips });
        if (truncated) break;
      }
    };

    collect(seq.videoTracks, videoTracks);
    collect(seq.audioTracks, audioTracks);

    var markers = [];
    try {
      var marker = seq.markers.getFirstMarker();
      while (marker) {
        markers.push({ time: gsRound(gsSeconds(marker.start)), name: marker.name });
        marker = seq.markers.getNextMarker(marker);
      }
    } catch (e) {
      // bazi surumlerde marker gezinmesi desteklenmiyor
    }

    return gsOk({
      name: seq.name,
      duration: gsRound(gsSeconds(seq.end)),
      videoTracks: videoTracks,
      audioTracks: audioTracks,
      markers: markers,
      truncated: truncated,
      note: truncated ? "Klip listesi " + limit + " oge ile sinirlandi." : ""
    });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirPrimarySource() {
  try {
    var seq = gsSequenceByName("");
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var path = gsMediaPath(track.clips[c].projectItem);
        if (path) {
          return gsOk({
            path: path,
            name: track.clips[c].name,
            clipStart: gsRound(gsSeconds(track.clips[c].start))
          });
        }
      }
    }
    return gsErr("Sequence icinde medya dosyasi olan klip bulunamadi");
  } catch (err) {
    return gsErr(err.toString());
  }
}

// ---------------------------------------------------------------- duzenleme

/**
 * Kesim planini YENI bir sequence olarak kurar. Orijinale dokunmaz.
 * keepsText: "0.000,10.500;20.000,30.000" (kaynak saniyeleri)
 */
function gelistirApplyKeeps(keepsText, sourcePath, newName) {
  try {
    var project = gsProject();
    var keeps = gsParseKeeps(keepsText);
    if (!keeps.length) return gsErr("Kesim plani bos");

    var item = gsFindProjectItemByPath(project.rootItem, sourcePath);
    if (!item) return gsErr("Kaynak proje icinde bulunamadi: " + sourcePath);
    if (!project.createNewSequenceFromClips) {
      return gsErr("Bu Premiere surumu createNewSequenceFromClips desteklemiyor");
    }

    var seq = project.createNewSequenceFromClips(newName || "Gelistir kurgu", [item]);
    if (!seq) return gsErr("Yeni sequence olusturulamadi");
    project.activeSequence = seq;

    // Sequence ayarlari kaynaktan alindi; icerigi temizleyip yeniden kuruyoruz.
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var vt = seq.videoTracks[t];
      for (var c = vt.clips.numItems - 1; c >= 0; c--) vt.clips[c].remove(false, false);
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var at = seq.audioTracks[a];
      for (var d = at.clips.numItems - 1; d >= 0; d--) at.clips[d].remove(false, false);
    }

    var videoTrack = seq.videoTracks[0];
    if (!videoTrack) return gsErr("Yeni sequence'te video kanali yok");

    var cursor = 0;
    for (var k = 0; k < keeps.length; k++) {
      // in/out noktalari yerlestirme aninda okunur; her parca icin yeniden ayarlanir.
      item.setInPoint(keeps[k].start, MEDIATYPE_ANY);
      item.setOutPoint(keeps[k].end, MEDIATYPE_ANY);
      videoTrack.overwriteClip(item, cursor);
      cursor += keeps[k].end - keeps[k].start;
    }

    return gsOk({
      sequence: seq.name,
      id: seq.sequenceID,
      placed: keeps.length,
      duration: gsRound(cursor),
      cuts: Math.max(0, keeps.length - 1)
    });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirDeleteClip(trackType, trackIndex, clipIndex, ripple) {
  try {
    var seq = gsSequenceByName("");
    var clip = gsClip(seq, trackType, trackIndex, clipIndex);
    var info = gsDescribeClip(clip, gsInt(clipIndex, 0));
    clip.remove(gsBool(ripple), true);
    return gsOk({ removed: info, ripple: gsBool(ripple), sequence: seq.name });
  } catch (err) {
    return gsErr(err.toString());
  }
}

/** Klibi silmek yerine sessize/gizliye alir - geri alinabilir. */
function gelistirSetClipEnabled(trackType, trackIndex, clipIndex, enabled) {
  try {
    var seq = gsSequenceByName("");
    var clip = gsClip(seq, trackType, trackIndex, clipIndex);
    clip.disabled = !gsBool(enabled);
    return gsOk({ clip: gsDescribeClip(clip, gsInt(clipIndex, 0)), enabled: gsBool(enabled) });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirTrimClip(trackType, trackIndex, clipIndex, newInPoint, newOutPoint) {
  try {
    var seq = gsSequenceByName("");
    var clip = gsClip(seq, trackType, trackIndex, clipIndex);
    var before = gsDescribeClip(clip, gsInt(clipIndex, 0));

    var inSec = parseFloat(newInPoint);
    var outSec = parseFloat(newOutPoint);
    if (!isNaN(inSec)) clip.inPoint = gsTime(inSec);
    if (!isNaN(outSec)) clip.outPoint = gsTime(outSec);

    return gsOk({ before: before, after: gsDescribeClip(clip, gsInt(clipIndex, 0)) });
  } catch (err) {
    return gsErr(err.toString());
  }
}

/**
 * Klip kazancini ayarlar.
 *
 * DIKKAT: Premiere'in Level parametresi 0-1 arasi normalize bir deger ve
 * esleme surumler arasinda birebir belgelenmis degil. Burada yaygin kabul
 * goren yaklasim kullaniliyor (ust sinir +15 dB). Nihai yayin gurlugu bu
 * degerle degil, cekirdekteki iki gecisli loudnorm ile belirleniyor.
 */
function gelistirSetClipGain(trackIndex, clipIndex, gainDb) {
  try {
    var seq = gsSequenceByName("");
    var clip = gsClip(seq, "audio", trackIndex, clipIndex);
    var db = parseFloat(gainDb);
    if (isNaN(db)) return gsErr("gainDb sayi olmali");
    if (db > 15) return gsErr("En fazla +15 dB desteklenir");

    var normalized = Math.pow(10, (db - 15) / 20);
    var applied = false;
    for (var i = 0; i < clip.components.numItems; i++) {
      var component = clip.components[i];
      if (String(component.displayName).toLowerCase().indexOf("volume") === -1) continue;
      for (var p = 0; p < component.properties.numItems; p++) {
        var prop = component.properties[p];
        if (String(prop.displayName).toLowerCase().indexOf("level") === -1) continue;
        prop.setValue(normalized, true);
        applied = true;
        break;
      }
      if (applied) break;
    }
    if (!applied) return gsErr("Klipte Volume/Level parametresi bulunamadi");

    return gsOk({
      clipIndex: gsInt(clipIndex, 0),
      gainDb: db,
      normalized: Math.round(normalized * 100000) / 100000,
      note: "Esleme yaklasiktir; yayin gurlugu loudnorm ile ayarlanir."
    });
  } catch (err) {
    return gsErr(err.toString());
  }
}

/** markersText: "12.5|Kurulum;90|Ornek" */
function gelistirAddMarkers(markersText) {
  try {
    var seq = gsSequenceByName("");
    var rows = String(markersText || "").split(";");
    var added = [];
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i]) continue;
      var parts = rows[i].split("|");
      var time = parseFloat(parts[0]);
      if (isNaN(time)) continue;
      var marker = seq.markers.createMarker(time);
      if (parts.length > 1 && parts[1]) marker.name = parts[1];
      added.push({ time: gsRound(time), name: parts[1] || "" });
    }
    if (!added.length) return gsErr("Gecerli marker verilmedi");
    return gsOk({
      added: added,
      note: "Bunlar zaman cizgisi isaretleri. YouTube bolumleri aciklamadan okunur."
    });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirInsertMogrt(mogrtPath, atSeconds, videoTrackIndex, titleText) {
  try {
    var seq = gsSequenceByName("");
    var file = new File(mogrtPath);
    if (!file.exists) return gsErr("Sablon bulunamadi: " + mogrtPath);

    var trackIndex = gsInt(videoTrackIndex, seq.videoTracks.numTracks - 1);
    var clip = seq.importMGT(mogrtPath, Number(atSeconds) || 0, trackIndex, 0);
    if (!clip) return gsErr("Sablon yerlestirilemedi");

    var textApplied = false;
    if (titleText) {
      var component = clip.getMGTComponent();
      if (component && component.properties) {
        for (var i = 0; i < component.properties.numItems; i++) {
          var prop = component.properties[i];
          if (!prop.setValue) continue;
          try {
            prop.setValue(titleText, true);
            textApplied = true;
            break;
          } catch (e) {
            // bu ozellik metin degil, sonrakine bak
          }
        }
      }
    }
    return gsOk({ track: trackIndex, at: Number(atSeconds) || 0, textApplied: textApplied });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirImportMedia(filePath) {
  try {
    var project = gsProject();
    var file = new File(filePath);
    if (!file.exists) return gsErr("Dosya bulunamadi: " + filePath);
    var ok = project.importFiles([filePath], true, project.rootItem, false);
    if (!ok) return gsErr("Ice aktarilamadi: " + filePath);
    return gsOk({ imported: filePath });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirSetActiveSequence(sequenceName) {
  try {
    var seq = gsSequenceByName(sequenceName);
    gsProject().activeSequence = seq;
    return gsOk({ sequence: seq.name, duration: gsRound(gsSeconds(seq.end)) });
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gelistirSetPlayhead(seconds) {
  try {
    var seq = gsSequenceByName("");
    var value = Number(seconds);
    if (isNaN(value)) return gsErr("seconds sayi olmali");
    seq.setPlayerPosition(String(Math.round(value * TICKS_PER_SECOND)));
    return gsOk({ at: gsRound(value) });
  } catch (err) {
    return gsErr(err.toString());
  }
}

// ---------------------------------------------------------------- cikti

function gelistirExportSequence(outputPath, presetPath) {
  try {
    var seq = gsSequenceByName("");
    if (!outputPath) return gsErr("Cikti yolu bos");
    if (!presetPath) return gsErr("Export preset (.epr) secilmedi");

    var presetFile = new File(presetPath);
    if (!presetFile.exists) return gsErr("Preset dosyasi bulunamadi: " + presetPath);

    app.encoder.launchEncoder();
    var jobId = app.encoder.encodeSequence(
      seq,
      outputPath,
      presetPath,
      ENCODE_ENTIRE_SEQUENCE,
      0 // islem bitince kuyruktan silme
    );
    app.encoder.startBatch();

    return gsOk({ jobId: jobId, output: outputPath, sequence: seq.name });
  } catch (err) {
    return gsErr(err.toString());
  }
}
