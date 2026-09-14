import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProbe,
  parseSilenceDetect,
  buildConcatFilter,
  loudnessMeasureArgs,
  parseLoudnorm,
  loudnormApplyFilter,
  recommendedBitrateKbps,
  deliveryArgs,
  thumbnailArgs,
} from "../src/ffmpeg.js";

test("parseProbe sure, cozunurluk ve fps okur", () => {
  const info = parseProbe(
    JSON.stringify({
      format: { duration: "123.456" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" },
      ],
    }),
  );
  assert.equal(info.duration, 123.456);
  assert.equal(info.video.height, 1080);
  assert.equal(info.video.fps.toFixed(2), "29.97");
  assert.equal(info.audio.channels, 2);
  assert.ok(info.hasVideo && info.hasAudio);
});

test("parseProbe sessiz videoyu isaretler", () => {
  const info = parseProbe(
    JSON.stringify({ format: { duration: "10" }, streams: [{ codec_type: "video", width: 640, height: 480 }] }),
  );
  assert.equal(info.hasAudio, false);
  assert.equal(info.audio, null);
});

test("parseSilenceDetect log satirlarini araliga cevirir", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 3.512",
    "[silencedetect @ 0x1] silence_end: 5.02 | silence_duration: 1.508",
    "[silencedetect @ 0x1] silence_start: 40.1",
    "[silencedetect @ 0x1] silence_end: 41.0 | silence_duration: 0.9",
  ].join("\n");
  const ranges = parseSilenceDetect(stderr, 60);
  assert.deepEqual(
    ranges.map((r) => [r.start, r.end]),
    [
      [3.512, 5.02],
      [40.1, 41.0],
    ],
  );
  assert.equal(ranges[0].kind, "silence");
});

test("parseSilenceDetect kapanmamis sessizligi sure ile kapatir", () => {
  const ranges = parseSilenceDetect("silence_start: 55.0", 60);
  assert.deepEqual(ranges.map((r) => [r.start, r.end]), [[55.0, 60]]);
});

test("parseSilenceDetect negatif baslangici sifira ceker", () => {
  const ranges = parseSilenceDetect("silence_start: -0.002\nsilence_end: 1.5", 10);
  assert.equal(ranges[0].start, 0);
});

test("buildConcatFilter trim/atrim zincirini kurar", () => {
  const { filter, videoLabel, audioLabel } = buildConcatFilter([
    { start: 0, end: 2 },
    { start: 5, end: 7.5 },
  ]);
  assert.equal(videoLabel, "[vcat]");
  assert.equal(audioLabel, "[acat]");
  assert.ok(filter.includes("[0:v]trim=start=0.000000:end=2.000000,setpts=PTS-STARTPTS[v0]"));
  assert.ok(filter.includes("[0:a]atrim=start=5.000000:end=7.500000,asetpts=PTS-STARTPTS[a1]"));
  assert.ok(filter.includes("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]"));
});

test("buildConcatFilter ses-only zinciri uretir", () => {
  const { filter, videoLabel } = buildConcatFilter([{ start: 1, end: 2 }], { video: false });
  assert.equal(videoLabel, null);
  assert.ok(filter.includes("concat=n=1:v=0:a=1[acat]"));
  assert.ok(!filter.includes("[0:v]"));
});

test("buildConcatFilter bos keeps ile hata verir", () => {
  assert.throws(() => buildConcatFilter([]), /keeps bos/);
});

test("loudnessMeasureArgs dosya yazmaz, json ister", () => {
  const args = loudnessMeasureArgs("in.mp4", [{ start: 0, end: 5 }], { targetLufs: -14 });
  assert.ok(args.includes("-f"));
  assert.equal(args[args.length - 1], "-");
  const chain = args[args.indexOf("-filter_complex") + 1];
  assert.ok(chain.includes("loudnorm=I=-14"));
  assert.ok(chain.includes("print_format=json"));
  assert.ok(!chain.includes("[0:v]"), "olcum icin goruntu decode edilmez");
});

test("parseLoudnorm olculen degerleri okur", () => {
  const stderr = `
[Parsed_loudnorm_0 @ 0x55] 
{
	"input_i" : "-21.35",
	"input_tp" : "-4.28",
	"input_lra" : "8.10",
	"input_thresh" : "-31.62",
	"output_i" : "-14.02",
	"target_offset" : "0.15"
}
`;
  const m = parseLoudnorm(stderr);
  assert.equal(m.inputI, -21.35);
  assert.equal(m.inputTp, -4.28);
  assert.equal(m.inputLra, 8.1);
  assert.equal(m.targetOffset, 0.15);
});

test("parseLoudnorm bozuk cikti icin null doner", () => {
  assert.equal(parseLoudnorm("hicbir sey yok"), null);
  assert.equal(parseLoudnorm("{ bozuk json"), null);
  assert.equal(parseLoudnorm('{"input_lra":"3"}'), null, "input_i olmadan guvenilmez");
});

test("loudnormApplyFilter olculen degerlerle linear mod kullanir", () => {
  const f = loudnormApplyFilter(
    { inputI: -21.35, inputTp: -4.28, inputLra: 8.1, inputThresh: -31.6, targetOffset: 0.15 },
    { targetLufs: -14, truePeakDb: -1, loudnessRange: 11 },
  );
  assert.ok(f.includes("measured_I=-21.35"));
  assert.ok(f.includes("measured_TP=-4.28"));
  assert.ok(f.includes("linear=true"));
  assert.ok(f.startsWith("loudnorm=I=-14:TP=-1:LRA=11"));
});

test("loudnormApplyFilter olcum yoksa tek gecise duser", () => {
  assert.equal(loudnormApplyFilter(null, { targetLufs: -14, truePeakDb: -1, loudnessRange: 11 }),
    "loudnorm=I=-14:TP=-1:LRA=11");
});

test("recommendedBitrateKbps YouTube tablosunu izler", () => {
  assert.equal(recommendedBitrateKbps(1080, 30), 8000);
  assert.equal(recommendedBitrateKbps(1080, 60), 12000);
  assert.equal(recommendedBitrateKbps(2160, 30), 35000);
  assert.equal(recommendedBitrateKbps(720, 30), 5000);
  assert.equal(recommendedBitrateKbps(240, 30), 1000, "tablonun altinda en dusuk satir");
});

test("deliveryArgs tek gecislik kes+normalize+kodla komutu kurar", () => {
  const args = deliveryArgs({
    input: "kaynak.mp4",
    output: "cikti.mp4",
    keeps: [{ start: 0, end: 10 }, { start: 20, end: 30 }],
    measured: { inputI: -20, inputTp: -3, inputLra: 7, inputThresh: -30, targetOffset: 0 },
    probeInfo: { hasVideo: true, hasAudio: true, video: { height: 1080, fps: 30 } },
    options: { videoCodec: "libx264", x264Preset: "slow", audioBitrate: "384k", faststart: true },
  });
  const joined = args.join(" ");
  assert.ok(joined.includes("-c:v libx264"));
  assert.ok(joined.includes("-b:v 8000k"));
  assert.ok(joined.includes("-pix_fmt yuv420p"));
  assert.ok(joined.includes("-movflags +faststart"));
  assert.ok(joined.includes("-ar 48000"));
  assert.ok(joined.includes("measured_I=-20"));
  assert.equal(args[args.length - 1], "cikti.mp4");
  assert.ok(joined.includes("-map [vcat]"));
});

test("deliveryArgs altyaziyi yakarken yolu kacisli yazar", () => {
  const args = deliveryArgs({
    input: "a.mp4",
    output: "b.mp4",
    keeps: [{ start: 0, end: 5 }],
    subtitlePath: "C:\\Videolar\\alt.srt",
    probeInfo: { hasVideo: true, hasAudio: true, video: { height: 720, fps: 30 } },
  });
  const chain = args[args.indexOf("-filter_complex") + 1];
  assert.ok(chain.includes("subtitles='C\\:/Videolar/alt.srt'"), chain);
  assert.ok(args.join(" ").includes("-map [vsub]"));
});

test("deliveryArgs sessiz olmayan, goruntusuz kaynakta video akisi eklemez", () => {
  const args = deliveryArgs({
    input: "ses.wav",
    output: "cikti.m4a",
    keeps: [{ start: 0, end: 5 }],
    probeInfo: { hasVideo: false, hasAudio: true },
  });
  const joined = args.join(" ");
  assert.ok(!joined.includes("-c:v"));
  assert.ok(joined.includes("-map [aout]"));
});

test("thumbnailArgs -ss girdiden once gelir (hizli arama)", () => {
  const args = thumbnailArgs("a.mp4", 12.5, "k.jpg");
  assert.ok(args.indexOf("-ss") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-ss") + 1], "12.500");
});

test("run hata nesnesine stderr'i baglar (olcum cagrilari buna guvenir)", async () => {
  const { run } = await import("../src/ffmpeg.js");
  // Sifir olmayan kodla cikip stderr'e yazan bir surec.
  await assert.rejects(
    run("sh", ["-c", "echo 'silence_start: 1.0' >&2; exit 1"]),
    (err) => {
      assert.match(err.stderr, /silence_start/);
      assert.equal(err.code, 1);
      return true;
    },
  );
});

test("run olmayan program icin anlasilir hata verir", async () => {
  const { run } = await import("../src/ffmpeg.js");
  await assert.rejects(run("kesinlikle-olmayan-program-xyz", ["-v"]), /PATH/);
});

test("Windows'ta uzantisiz komut icin .cmd/.bat/.exe denenir", async () => {
  const { run } = await import("../src/ffmpeg.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  // npm/pipx sarmalayicisini taklit et: "arac" yok ama "arac.cmd" var.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-win-"));
  const wrapper = path.join(dir, "arac.cmd");
  fs.writeFileSync(wrapper, "#!/bin/sh\necho 'sarmalayici kostu'\n");
  fs.chmodSync(wrapper, 0o755);

  const bare = path.join(dir, "arac");
  // Once gercek platform davranisi: uzantisiz yok, hata verir
  await assert.rejects(run(bare, []), /baslatilamadi/);

  // win32 davranisiyla: .cmd bulunur
  const { stdout } = await run(bare, [], { platform: "win32" });
  assert.match(stdout, /sarmalayici kostu/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("Windows fallback zaten uzantili komutta denenmez", async () => {
  const { run } = await import("../src/ffmpeg.js");
  await assert.rejects(
    run("olmayan-arac.exe", [], { platform: "win32" }),
    /olmayan-arac\.exe baslatilamadi/,
  );
});

test("Windows fallback hicbiri yoksa ilk hatayi bildirir", async () => {
  const { run } = await import("../src/ffmpeg.js");
  await assert.rejects(run("kesinlikle-olmayan-xyz", [], { platform: "win32" }), (err) => {
    assert.match(err.message, /kesinlikle-olmayan-xyz baslatilamadi/);
    assert.ok(!err.message.includes(".cmd"), "kullaniciya uzanti detayi gosterilmemeli");
    return true;
  });
});

test("calisan komutun sifir olmayan cikis kodu fallback tetiklemez", async () => {
  const { run } = await import("../src/ffmpeg.js");
  await assert.rejects(
    run("sh", ["-c", "exit 3"], { platform: "win32" }),
    (err) => {
      assert.equal(err.code, 3);
      assert.equal(err.spawnFailed, undefined);
      return true;
    },
  );
});
