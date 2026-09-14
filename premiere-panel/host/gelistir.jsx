/**
 * Gelistir - Premiere Pro ExtendScript tarafi.
 *
 * Panel bu fonksiyonlari CSInterface.evalScript ile cagirir. ExtendScript'te
 * JSON nesnesi her surumde yok; bu yuzden veri alisverisi duz metinle yapiliyor:
 *   - Donen degerler:  "OK|alan=deger|alan=deger" veya "ERR|mesaj"
 *   - Giren keeps:     "0.000,10.500;20.000,30.000"
 */

// Premiere zamani "tick" tutar. 1 saniye = 254016000000 tick.
var TICKS_PER_SECOND = 254016000000;

// projectItem.setInPoint/setOutPoint icin medya turu: 4 = video+ses birlikte.
var MEDIATYPE_ANY = 4;

// encodeSequence workAreaType: 0 = butun sequence.
var ENCODE_ENTIRE_SEQUENCE = 0;

function gsEscape(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\|/g, "/").replace(/[\r\n]+/g, " ");
}

function gsOk(pairs) {
  var out = "OK";
  for (var i = 0; i < pairs.length; i++) {
    out += "|" + pairs[i][0] + "=" + gsEscape(pairs[i][1]);
  }
  return out;
}

function gsErr(message) {
  return "ERR|" + gsEscape(message);
}

function gsSecondsFromTime(time) {
  if (!time) return 0;
  // seconds alani bazi surumlerde string doner.
  if (time.seconds !== undefined && time.seconds !== null) return Number(time.seconds);
  if (time.ticks !== undefined) return Number(time.ticks) / TICKS_PER_SECOND;
  return 0;
}

/** Aktif sequence ve icindeki klipler hakkinda ozet bilgi. */
function gelistirSequenceInfo() {
  try {
    var project = app.project;
    if (!project) return gsErr("Acik proje yok");
    var seq = project.activeSequence;
    if (!seq) return gsErr("Aktif sequence yok. Once bir sequence ac.");

    var clipCount = 0;
    var sources = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        clipCount++;
        var item = clip.projectItem;
        if (item) {
          var mediaPath = "";
          try {
            mediaPath = item.getMediaPath();
          } catch (e) {
            mediaPath = "";
          }
          if (mediaPath) {
            var seen = false;
            for (var s = 0; s < sources.length; s++) {
              if (sources[s] === mediaPath) {
                seen = true;
                break;
              }
            }
            if (!seen) sources.push(mediaPath);
          }
        }
      }
    }

    return gsOk([
      ["project", project.name],
      ["projectPath", project.path],
      ["sequence", seq.name],
      ["sequenceId", seq.sequenceID],
      ["duration", gsSecondsFromTime(seq.end).toFixed(3)],
      ["videoTracks", seq.videoTracks.numTracks],
      ["audioTracks", seq.audioTracks.numTracks],
      ["clipCount", clipCount],
      ["sourceCount", sources.length],
      ["firstSource", sources.length ? sources[0] : ""],
    ]);
  } catch (err) {
    return gsErr(err.toString());
  }
}

/** Aktif sequence'teki ilk video klibin kaynak dosyasi (cekirdek bunu analiz eder). */
function gelistirPrimarySource() {
  try {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return gsErr("Aktif sequence yok");
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var track = seq.videoTracks[t];
      for (var c = 0; c < track.clips.numItems; c++) {
        var item = track.clips[c].projectItem;
        if (!item) continue;
        var mediaPath = item.getMediaPath();
        if (mediaPath) {
          return gsOk([
            ["path", mediaPath],
            ["name", item.name],
            ["clipStart", gsSecondsFromTime(track.clips[c].start).toFixed(3)],
          ]);
        }
      }
    }
    return gsErr("Sequence icinde medya dosyasi olan klip bulunamadi");
  } catch (err) {
    return gsErr(err.toString());
  }
}

function gsFindProjectItemByPath(item, target) {
  try {
    if (item.type === ProjectItemType.BIN || (item.children && item.children.numItems > 0)) {
      for (var i = 0; i < item.children.numItems; i++) {
        var found = gsFindProjectItemByPath(item.children[i], target);
        if (found) return found;
      }
      return null;
    }
    var mediaPath = item.getMediaPath();
    if (mediaPath && mediaPath === target) return item;
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

function gsClearSequence(seq) {
  var removed = 0;
  for (var t = 0; t < seq.videoTracks.numTracks; t++) {
    var vt = seq.videoTracks[t];
    for (var c = vt.clips.numItems - 1; c >= 0; c--) {
      vt.clips[c].remove(false, false);
      removed++;
    }
  }
  for (var a = 0; a < seq.audioTracks.numTracks; a++) {
    var at = seq.audioTracks[a];
    for (var d = at.clips.numItems - 1; d >= 0; d--) {
      at.clips[d].remove(false, false);
      removed++;
    }
  }
  return removed;
}

/**
 * Kesim planini zaman cizgisine uygular.
 *
 * Yeni bir sequence olusturup tutulacak parcalari sirayla yerlestirir.
 * Orijinal sequence'e dokunulmaz; boylece geri donmek her zaman mumkun.
 *
 * @param keepsText "baslangic,bitis;baslangic,bitis" (kaynak saniyeleri)
 * @param sourcePath analiz edilen medya dosyasinin yolu
 * @param newName   olusturulacak sequence adi
 */
function gelistirApplyCutPlan(keepsText, sourcePath, newName) {
  try {
    var project = app.project;
    if (!project) return gsErr("Acik proje yok");
    var keeps = gsParseKeeps(keepsText);
    if (!keeps.length) return gsErr("Kesim plani bos");

    var item = gsFindProjectItemByPath(project.rootItem, sourcePath);
    if (!item) {
      return gsErr("Kaynak proje icinde bulunamadi: " + sourcePath);
    }

    var name = newName || "Gelistir kurgu";
    var seq = null;

    // createNewSequenceFromClips sequence ayarlarini kaynaga gore kurar.
    if (project.createNewSequenceFromClips) {
      seq = project.createNewSequenceFromClips(name, [item]);
    }
    if (!seq) return gsErr("Yeni sequence olusturulamadi");

    project.activeSequence = seq;
    gsClearSequence(seq);

    var videoTrack = seq.videoTracks[0];
    if (!videoTrack) return gsErr("Yeni sequence'te video kanali yok");

    var cursor = 0;
    var placed = 0;
    for (var i = 0; i < keeps.length; i++) {
      // in/out noktalari yerlestirme aninda okunur; her parca icin yeniden ayarlanir.
      item.setInPoint(keeps[i].start, MEDIATYPE_ANY);
      item.setOutPoint(keeps[i].end, MEDIATYPE_ANY);
      videoTrack.overwriteClip(item, cursor);
      cursor += keeps[i].end - keeps[i].start;
      placed++;
    }

    return gsOk([
      ["sequence", seq.name],
      ["sequenceId", seq.sequenceID],
      ["placed", placed],
      ["duration", cursor.toFixed(3)],
      ["cuts", Math.max(0, placed - 1)],
    ]);
  } catch (err) {
    return gsErr(err.toString());
  }
}

/**
 * Aktif sequence'i Adobe Media Encoder'a gonderir.
 * Master dosya alinir; YouTube icin son kodlama ve gurluk ayari cekirdekte yapilir.
 */
function gelistirExportSequence(outputPath, presetPath) {
  try {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return gsErr("Aktif sequence yok");
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

    return gsOk([
      ["jobId", jobId],
      ["output", outputPath],
      ["sequence", seq.name],
    ]);
  } catch (err) {
    return gsErr(err.toString());
  }
}

/**
 * Motion Graphics sablonu (.mogrt) yerlestirir - acilis basligi / alt bant icin.
 * Sablon yoksa sessizce atlanir; panel bunu zorunlu adim saymaz.
 */
function gelistirInsertMogrt(mogrtPath, atSeconds, videoTrackIndex, titleText) {
  try {
    var seq = app.project ? app.project.activeSequence : null;
    if (!seq) return gsErr("Aktif sequence yok");
    var file = new File(mogrtPath);
    if (!file.exists) return gsErr("Sablon bulunamadi: " + mogrtPath);

    var trackIndex = parseInt(videoTrackIndex, 10);
    if (isNaN(trackIndex)) trackIndex = seq.videoTracks.numTracks - 1;

    var clip = seq.importMGT(mogrtPath, Number(atSeconds) || 0, trackIndex, 0);
    if (!clip) return gsErr("Sablon yerlestirilemedi");

    if (titleText) {
      var component = clip.getMGTComponent();
      if (component && component.properties) {
        for (var i = 0; i < component.properties.numItems; i++) {
          var prop = component.properties[i];
          // Sablondaki ilk metin alanini doldur.
          if (prop.displayName && prop.setValue) {
            try {
              prop.setValue(titleText, true);
              break;
            } catch (e) {
              // bu ozellik metin degil, sonrakine bak
            }
          }
        }
      }
    }

    return gsOk([["track", trackIndex], ["at", Number(atSeconds) || 0]]);
  } catch (err) {
    return gsErr(err.toString());
  }
}

/** Panel yuklendiginde baglantiyi dogrulamak icin. */
function gelistirPing() {
  try {
    return gsOk([
      ["host", "PPRO"],
      ["version", app.version],
      ["project", app.project ? app.project.name : ""],
    ]);
  } catch (err) {
    return gsErr(err.toString());
  }
}
