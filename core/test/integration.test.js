import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULTS } from "../src/config.js";
import { runPipeline } from "../src/pipeline.js";

/**
 * Uctan uca boru hatti testi.
 *
 * Gercek ffmpeg yerine, beklenen cagrilari taniyip kanned cikti ureten sahte
 * kabuk betikleri kullaniyoruz. Boylece sira, dosya yazimi, rapor ve paket
 * icerigi ffmpeg kurulu olmadan da dogrulanabiliyor.
 */
function makeStubs(dir) {
  const ffprobe = path.join(dir, "ffprobe");
  fs.writeFileSync(
    ffprobe,
    `#!/bin/sh
cat <<'JSON'
{
  "format": { "duration": "120.000" },
  "streams": [
    { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
      "r_frame_rate": "30/1" },
    { "codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000" }
  ]
}
JSON
`,
  );

  const ffmpeg = path.join(dir, "ffmpeg");
  fs.writeFileSync(
    ffmpeg,
    `#!/bin/sh
args="$*"
case "$args" in
  *silencedetect*)
    echo "[silencedetect @ 0x1] silence_start: 10.0" >&2
    echo "[silencedetect @ 0x1] silence_end: 14.0 | silence_duration: 4.0" >&2
    echo "[silencedetect @ 0x1] silence_start: 60.0" >&2
    echo "[silencedetect @ 0x1] silence_end: 63.0 | silence_duration: 3.0" >&2
    exit 0
    ;;
  *print_format=json*)
    cat >&2 <<'JSON'
{
	"input_i" : "-21.35",
	"input_tp" : "-4.28",
	"input_lra" : "8.10",
	"input_thresh" : "-31.62",
	"output_i" : "-14.02",
	"target_offset" : "0.15"
}
JSON
    exit 0
    ;;
esac
# Diger tum cagrilarda son arguman cikti dosyasidir.
for a in "$@"; do last="$a"; done
printf 'sahte-medya-verisi' > "$last"
echo "frame= 1 time=00:00:10.00" >&2
exit 0
`,
  );

  fs.chmodSync(ffprobe, 0o755);
  fs.chmodSync(ffmpeg, 0o755);
  return { ffmpeg, ffprobe };
}

test("boru hatti API anahtari ve whisper olmadan paketi yazar", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-e2e-"));
  const { ffmpeg, ffprobe } = makeStubs(work);
  const input = path.join(work, "cekim.mp4");
  fs.writeFileSync(input, "sahte kaynak");
  const outDir = path.join(work, "cikti");

  const steps = [];
  const result = await runPipeline({
    input,
    outDir,
    mode: "full",
    apiKey: "",
    config: {
      ...DEFAULTS,
      ffmpeg,
      ffprobe,
      whisper: "whisper-kesinlikle-yok-xyz",
      thumbnailCandidates: 2,
    },
    onEvent: (e) => {
      if (!steps.includes(e.step)) steps.push(e.step);
    },
  });

  // Adimlar dogru sirada gecildi
  // Atlanan adimlar da bildirilir (panel takilmis gorunmesin), detayinda nedeni yazar.
  assert.deepEqual(steps, [
    "probe", "audio", "transcribe", "silence", "plan", "cut",
    "subtitles", "master", "metadata", "bundle",
  ]);

  // Sessizlikler kesim planina dondu: 120 sn - (4 + 3) sn, nefes paylari dusulmus
  assert.equal(result.cutPlan.keeps.length, 3);
  assert.ok(result.cutPlan.removedSeconds > 6, `atilan ${result.cutPlan.removedSeconds}`);
  assert.ok(result.cutPlan.removedSeconds < 7, `atilan ${result.cutPlan.removedSeconds}`);

  // Paket dosyalari gercekten diske yazildi
  for (const key of ["video", "metadata", "aciklama", "rapor"]) {
    assert.ok(result.files[key], `${key} eksik`);
    assert.ok(fs.existsSync(result.files[key]), `${result.files[key]} yok`);
  }
  assert.ok(fs.existsSync(path.join(outDir, "job.json")));
  assert.equal(result.files.bolumler, undefined, "bolum yok, dosya da olmamali");

  // Kapak adaylari
  assert.ok(fs.existsSync(path.join(outDir, "kapak-1.jpg")));
  assert.ok(fs.existsSync(path.join(outDir, "kapak-2.jpg")));

  // metadata.json tutarli ve yayinlanmaya hazir degil olarak isaretli
  const meta = JSON.parse(fs.readFileSync(result.files.metadata, "utf8"));
  assert.equal(meta.privacyStatus, "private");
  assert.equal(meta.subtitleFile, null);
  assert.equal(meta.videoFile, "cekim-youtube.mp4");
  assert.deepEqual(meta.chapters, []);
  assert.equal(meta.durationSeconds, Math.round(result.cutPlan.outputDuration));

  // Eksikler sessizce gecilmedi
  const warnings = meta.warnings.join(" ");
  assert.match(warnings, /whisper bulunamadi/);
  assert.match(warnings, /ANTHROPIC_API_KEY yok/);

  // Rapor gercek sayilari tasiyor
  const report = fs.readFileSync(result.files.rapor, "utf8");
  assert.match(report, /Kaynak suresi: 2:00/);
  assert.match(report, /Sessizlik/);
  assert.match(report, /-21\.4 LUFS -> hedef -14 LUFS/);
  assert.match(report, /- \[ \]/);

  fs.rmSync(work, { recursive: true, force: true });
});

test("boru hatti hazir .srt dokumuyle altyazi ve bolum uretir", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-e2e-srt-"));
  const { ffmpeg, ffprobe } = makeStubs(work);
  const input = path.join(work, "ders.mp4");
  fs.writeFileSync(input, "sahte kaynak");

  const srtPath = path.join(work, "ders.srt");
  fs.writeFileSync(
    srtPath,
    [
      "1",
      "00:00:00,000 --> 00:00:05,000",
      "Merhaba arkadaslar bugun kurgu otomasyonu",
      "",
      "2",
      "00:00:20,000 --> 00:00:26,000",
      "Simdi kurulum adimlarina geciyoruz",
      "",
      "3",
      "00:01:10,000 --> 00:01:16,000",
      "Son olarak yayina alma kismi",
      "",
    ].join("\n"),
  );

  const outDir = path.join(work, "cikti");
  const result = await runPipeline({
    input,
    outDir,
    mode: "full",
    srtPath,
    apiKey: "",
    config: { ...DEFAULTS, ffmpeg, ffprobe, thumbnailCandidates: 1 },
  });

  // Altyazi yazildi ve kesilmis zaman cizgisine oturdu
  assert.ok(result.files.altyazi, "altyazi uretilmedi");
  const srt = fs.readFileSync(result.files.altyazi, "utf8");
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /Merhaba arkadaslar bugun kurgu/);

  // 10-14 sn arasi kesildigi icin ikinci satir 20 sn'den once baslamali
  const secondCueStart = srt.split("\n\n")[1].split("\n")[1];
  assert.ok(secondCueStart.startsWith("00:00:1"), `ikinci kuyruk: ${secondCueStart}`);

  // Dokum var ama API anahtari yok: bolum uretilemez, uyari verilir
  const meta = JSON.parse(fs.readFileSync(result.files.metadata, "utf8"));
  assert.match(meta.warnings.join(" "), /ANTHROPIC_API_KEY yok/);
  assert.equal(meta.subtitleFile, path.basename(result.files.altyazi));

  fs.rmSync(work, { recursive: true, force: true });
});

test("plan modu Premiere icin job.json birakir ve kodlama yapmaz", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-e2e-plan-"));
  const { ffmpeg, ffprobe } = makeStubs(work);
  const input = path.join(work, "cekim.mp4");
  fs.writeFileSync(input, "sahte kaynak");
  const outDir = path.join(work, "cikti");

  const steps = [];
  const result = await runPipeline({
    input,
    outDir,
    mode: "plan",
    apiKey: "",
    config: { ...DEFAULTS, ffmpeg, ffprobe, whisper: "whisper-yok-xyz" },
    onEvent: (e) => {
      if (!steps.includes(e.step)) steps.push(e.step);
    },
  });

  assert.deepEqual(steps, ["probe", "audio", "transcribe", "silence", "plan", "cut"]);
  assert.ok(result.files.plan.endsWith("job.json"));
  assert.equal(fs.existsSync(path.join(outDir, "cekim-youtube.mp4")), false, "video kodlanmamali");

  // job.json paneli besleyecek her seyi tasiyor
  const state = JSON.parse(fs.readFileSync(result.files.plan, "utf8"));
  assert.equal(state.mode, "plan");
  assert.ok(Array.isArray(state.cutPlan.keeps) && state.cutPlan.keeps.length === 3);
  assert.equal(state.probeInfo.video.height, 1080);

  fs.rmSync(work, { recursive: true, force: true });
});

test("deliver modu plan durumunu kullanarak master'i paketler", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-e2e-deliver-"));
  const { ffmpeg, ffprobe } = makeStubs(work);
  const input = path.join(work, "cekim.mp4");
  fs.writeFileSync(input, "sahte kaynak");
  const outDir = path.join(work, "cikti");
  const config = { ...DEFAULTS, ffmpeg, ffprobe, thumbnailCandidates: 1 };

  const srtPath = path.join(work, "d.srt");
  fs.writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:04,000\nilk cumle\n");

  const plan = await runPipeline({ input, outDir, mode: "plan", srtPath, apiKey: "", config });

  // Premiere'den cikmis master'i taklit et (stub ffprobe her zaman 120 sn der,
  // plandaki cikti suresi ~113 sn; bu fark uyari uretmeli).
  const master = path.join(work, "master.mp4");
  fs.writeFileSync(master, "sahte master");

  const delivered = await runPipeline({
    input: master,
    outDir,
    mode: "deliver",
    state: plan,
    apiKey: "",
    config,
  });

  assert.ok(fs.existsSync(delivered.files.video));
  assert.ok(fs.existsSync(delivered.files.altyazi), "altyazi plan durumundan uretilmeli");
  assert.match(delivered.warnings.join(" "), /Master suresi/);

  fs.rmSync(work, { recursive: true, force: true });
});
