import { spawn } from "child_process";

const _cache = new Map();

function run(ffmpegBin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const kill = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ code: 999, stderr: stderr + "\n(timeout)" });
    }, timeoutMs);

    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code: code ?? 1, stderr });
    });
    p.on("error", (e) => {
      clearTimeout(kill);
      resolve({ code: 1, stderr: String(e?.message || e) });
    });
  });
}

async function probeEncoder(ffmpegBin, encoder, extraArgs = []) {
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", "color=c=black:s=128x128:r=30:d=0.1",
    "-an",
    "-c:v", encoder,
    ...extraArgs,
    "-t", "0.1",
    "-f", "null",
    "-"
  ];

  const { code, stderr } = await run(ffmpegBin, args);
  const ok = code === 0;

  return {
    ok,
    code,
    detail: (stderr || "").split("\n").slice(-8).join("\n").trim()
  };
}

async function hasEncoderListed(ffmpegBin, encoder) {
  const { code, stderr } = await run(ffmpegBin, ["-hide_banner", "-encoders"], 4000);
  if (code !== 0) return false;
  return new RegExp(`\\b${encoder}\\b`).test(stderr);
}

export async function getFfmpegCaps(ffmpegBin) {
  if (_cache.has(ffmpegBin)) return _cache.get(ffmpegBin);

  const job = (async () => {
    const listed = async (enc) => await hasEncoderListed(ffmpegBin, enc);
    const results = {};

    if (await listed("h264_nvenc")) results.h264_nvenc = await probeEncoder(ffmpegBin, "h264_nvenc");
    if (await listed("hevc_nvenc")) results.hevc_nvenc = await probeEncoder(ffmpegBin, "hevc_nvenc");
    if (await listed("av1_nvenc"))  results.av1_nvenc  = await probeEncoder(ffmpegBin, "av1_nvenc");
    if (await listed("h264_nvenc")) results.h264_nvenc_10bit = await probeEncoder(ffmpegBin, "h264_nvenc", ["-pix_fmt", "p010le"]);
    if (await listed("hevc_nvenc")) results.hevc_nvenc_10bit = await probeEncoder(ffmpegBin, "hevc_nvenc", ["-pix_fmt", "p010le"]);
    if (await listed("av1_nvenc"))  results.av1_nvenc_10bit  = await probeEncoder(ffmpegBin, "av1_nvenc",  ["-pix_fmt", "p010le"]);
    if (await listed("libsvtav1")) results.libsvtav1 = await probeEncoder(ffmpegBin, "libsvtav1", ["-preset", "8"]);
    if (await listed("libaom-av1")) results.libaom_av1 = await probeEncoder(ffmpegBin, "libaom-av1", ["-cpu-used", "4", "-row-mt", "1"]);

    return results;
  })();

  _cache.set(ffmpegBin, job);
  return job;
}

export async function probeVideoStreamInfo(ffmpegBin, inputPath, timeoutMs = 4000) {
  const { code, stderr } = await run(ffmpegBin, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputPath
  ], timeoutMs);

  const txt = String(stderr || "");
  const m = txt.match(/Stream #\d+:\d+.*Video:\s*([^,]+),\s*([^,]+),\s*(\d+)x(\d+)/i);
  const codec = m?.[1]?.trim() || null;
  const pixFmt = m?.[2]?.trim() || null;
  const width = m?.[3] ? Number(m[3]) : 0;
  const height = m?.[4] ? Number(m[4]) : 0;
  const is10bit = !!(pixFmt && /10le|p010|yuv420p10/i.test(pixFmt));
  const isHDR = /bt2020|smpte2084|arib-std-b67|dolby/i.test(txt);

  return {
    ok: true,
    codec,
    pixFmt,
    width,
    height,
    is10bit,
    isHDR,
    rawTail: txt.split("\n").slice(-12).join("\n")
  };
}
