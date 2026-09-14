/**
 * Test yardimcilari (dosya adi *.test.js olmadigi icin test kosucusu bunu
 * ayri bir test dosyasi saymaz).
 */
import fs from "node:fs";
import path from "node:path";

/** Beklenen cagrilari taniyip kanned cikti ureten sahte ffmpeg/ffprobe. */
export function makeMediaStubs(dir, { duration = 120 } = {}) {
  const ffprobe = path.join(dir, "ffprobe");
  fs.writeFileSync(
    ffprobe,
    `#!/bin/sh
cat <<'JSON'
{
  "format": { "duration": "${duration}.000" },
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

// ---------------------------------------------------------------- model taklidi

export const assistantText = (text, usage = { input_tokens: 5, output_tokens: 7 }) => ({
  stop_reason: "end_turn",
  stop_details: null,
  usage,
  content: [{ type: "text", text }],
});

export const assistantToolUse = (calls, text = "") => ({
  stop_reason: "tool_use",
  stop_details: null,
  usage: { input_tokens: 8, output_tokens: 9 },
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
  ],
});

export const assistantRefusal = (category = "cyber") => ({
  stop_reason: "refusal",
  stop_details: { type: "refusal", category, explanation: "policy" },
  usage: {},
  content: [],
});

export const assistantPause = () => ({
  stop_reason: "pause_turn",
  stop_details: null,
  usage: {},
  content: [{ type: "text", text: "devam ediyorum" }],
});

/**
 * Sirayla verilen yanitlari donduren sahte Anthropic istemcisi.
 * betaStatus verilirse beta ucu o HTTP koduyla hata verir.
 */
export function stubClient(responses, { betaStatus = null } = {}) {
  const queue = [...responses];
  const calls = [];

  const streamFor = (beta) => (params) => {
    calls.push({ beta, params });
    if (beta && betaStatus) {
      const err = new Error("beta desteklenmiyor");
      err.status = betaStatus;
      throw err;
    }
    return {
      finalMessage: async () => {
        if (!queue.length) throw new Error("stubClient: senaryo bitti, fazladan cagri yapildi");
        return queue.shift();
      },
    };
  };

  return {
    calls,
    remaining: () => queue.length,
    beta: { messages: { stream: streamFor(true) } },
    messages: { stream: streamFor(false) },
  };
}
