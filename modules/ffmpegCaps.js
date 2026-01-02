import { spawn } from "child_process";
import path from "path";

const _cache = new Map();

function run(bin, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    const kill = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ code: 999, stdout, stderr: stderr + "\n(timeout)" });
    }, timeoutMs);

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    p.on("error", (e) => {
      clearTimeout(kill);
      resolve({ code: 1, stdout, stderr: String(e?.message || e) });
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

  const { code, stderr } = await run(ffmpegBin, args, 8000);
  const ok = code === 0;

  return {
    ok,
    code,
    detail: (stderr || "").split("\n").slice(-12).join("\n").trim()
  };
}

async function hasEncoderListed(ffmpegBin, encoder) {
  const { code, stdout, stderr } = await run(ffmpegBin, ["-hide_banner", "-encoders"], 8000);
  if (code !== 0) return false;

  const txt = String(stdout || "") + "\n" + String(stderr || "");
  return new RegExp(`\\b${encoder}\\b`).test(txt);
}

export async function getFfmpegCaps(ffmpegBin) {
  if (_cache.has(ffmpegBin)) return _cache.get(ffmpegBin);

  const job = (async () => {
    const listed = async (enc) => await hasEncoderListed(ffmpegBin, enc);
    const results = {};

    if (await listed("h264_nvenc")) results.h264_nvenc = { listed: true, ...(await probeEncoder(ffmpegBin, "h264_nvenc")) };
    if (await listed("hevc_nvenc")) results.hevc_nvenc = { listed: true, ...(await probeEncoder(ffmpegBin, "hevc_nvenc")) };
    if (await listed("av1_nvenc"))  results.av1_nvenc  = { listed: true, ...(await probeEncoder(ffmpegBin, "av1_nvenc")) };
    if (await listed("h264_nvenc")) results.h264_nvenc_10bit = { listed: true, ...(await probeEncoder(ffmpegBin, "h264_nvenc", ["-pix_fmt", "p010le"])) };
    if (await listed("hevc_nvenc")) results.hevc_nvenc_10bit = { listed: true, ...(await probeEncoder(ffmpegBin, "hevc_nvenc", ["-pix_fmt", "p010le"])) };
    if (await listed("av1_nvenc"))  results.av1_nvenc_10bit  = { listed: true, ...(await probeEncoder(ffmpegBin, "av1_nvenc",  ["-pix_fmt", "p010le"])) };
    if (await listed("libsvtav1"))  results.libsvtav1  = { listed: true, ...(await probeEncoder(ffmpegBin, "libsvtav1", ["-preset", "8"])) };
    if (await listed("libaom-av1")) results.libaom_av1 = { listed: true, ...(await probeEncoder(ffmpegBin, "libaom-av1", ["-cpu-used", "4", "-row-mt", "1"])) };

    return results;
  })();

  _cache.set(ffmpegBin, job);
  return job;
}

function guessFfprobePath(ffmpegBin) {
  const s = String(ffmpegBin || "");
  if (!s) return "ffprobe";

  const base = path.basename(s);
  if (/ffmpeg(\.exe)?$/i.test(base)) {
    return s.replace(/ffmpeg(\.exe)?$/i, (m) =>
      m.toLowerCase().includes(".exe") ? "ffprobe.exe" : "ffprobe"
    );
  }

  const dir = path.dirname(s);
  return path.join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
}

async function runFfprobeMaybe(ffmpegBin, inputPath, timeoutMs) {
  const ffprobeBin = guessFfprobePath(ffmpegBin);

  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    "-show_entries",
    "stream=index,codec_name,codec_type,width,height,pix_fmt,profile,level,color_range,color_space,color_transfer,color_primaries,side_data_list,tags",
    inputPath
  ];

  const r = await run(ffprobeBin, args, timeoutMs);
  if (r.code === 0 && r.stdout && r.stdout.trim().startsWith("{")) {
    return { ok: true, jsonText: r.stdout, ffprobeBin, detail: r.stderr };
  }

  return { ok: false, ffprobeBin, detail: (r.stderr || "").slice(-400) };
}

function pickVideoStream(obj) {
  const streams = Array.isArray(obj?.streams) ? obj.streams : [];
  return streams.find(s => s?.codec_type === "video") || null;
}

function detectHdrDvFromStream(vs) {
  const pix  = String(vs?.pix_fmt || "").toLowerCase();
  const ct   = String(vs?.color_transfer || "").toLowerCase();
  const prim = String(vs?.color_primaries || "").toLowerCase();
  const csp  = String(vs?.color_space || "").toLowerCase();

  const side = Array.isArray(vs?.side_data_list) ? vs.side_data_list : [];
  const sideTxt = JSON.stringify(side).toLowerCase();

  const is10bit = /10le|p010|yuv420p10/.test(pix);

  const isHDR =
    /smpte2084|2084|pq/.test(ct) ||
    /arib-std-b67|b67|hlg/.test(ct) ||
    /bt2020/.test(prim) ||
    /bt2020/.test(csp) ||
    /mastering/.test(sideTxt) ||
    /content light level|cll|maxcll|maxfall/.test(sideTxt);

  const tagCodec = String(vs?.tags?.codec_tag_string || "").toLowerCase();
  const prof = String(vs?.profile || "").toLowerCase();

  const isDV =
    /dovi|dolby/.test(sideTxt) ||
    /dovi|dolby/.test(prof) ||
    /dvhe|dvh1/.test(tagCodec);

  return { is10bit, isHDR, isDV };
}

function extractHdrMetadata(vs) {
  const side = Array.isArray(vs?.side_data_list) ? vs.side_data_list : [];
  const sideTxt = JSON.stringify(side);

  const getAny = (keys) => {
    for (const it of side) {
      for (const k of keys) {
        if (it && typeof it[k] === "string" && it[k].trim()) return it[k].trim();
      }
    }
    return null;
  };

  const mastering_display =
    getAny(["mastering_display_metadata", "mastering_display", "mastering_display_metadata_string"]) ||
    (/"mastering[^"]*":\s*"([^"]+)"/i.exec(sideTxt)?.[1] ?? null);

  const content_light_level =
    getAny(["content_light_level", "content_light_level_metadata", "content_light_level_metadata_string"]) ||
    (/"content[^"]*light[^"]*":\s*"([^"]+)"/i.exec(sideTxt)?.[1] ?? null);

  return { mastering_display, content_light_level };
}

export async function probeVideoStreamInfo(ffmpegBin, inputPath, timeoutMs = 15000) {
  const probe = await runFfprobeMaybe(ffmpegBin, inputPath, timeoutMs);

  if (probe.ok) {
    try {
      const obj = JSON.parse(probe.jsonText);
      const vs = pickVideoStream(obj);

      if (!vs) {
        return {
          ok: false,
          codec: null,
          pixFmt: null,
          width: 0,
          height: 0,
          is10bit: false,
          isHDR: false,
          isDV: false,
          ffmpegCode: 2,
          rawTail: "ffprobe: no video stream found"
        };
      }

      const { is10bit, isHDR, isDV } = detectHdrDvFromStream(vs);
      const { mastering_display, content_light_level } = extractHdrMetadata(vs);

      return {
        ok: true,
        codec: vs.codec_name || null,
        pixFmt: vs.pix_fmt || null,
        width: Number(vs.width) || 0,
        height: Number(vs.height) || 0,

        color_transfer: vs.color_transfer || null,
        color_primaries: vs.color_primaries || null,
        color_space: vs.color_space || null,
        color_range: vs.color_range || null,

        mastering_display,
        content_light_level,

        is10bit,
        isHDR,
        isDV,

        ffmpegCode: 0,
        rawTail: `ffprobe(${probe.ffprobeBin}) ok`
      };
    } catch {
    }
  }

  const { code, stderr } = await run(ffmpegBin, [
    "-hide_banner",
    "-loglevel", "info",
    "-i", inputPath
  ], timeoutMs);

  const txt = String(stderr || "");
  const m =
    txt.match(/Stream #\d+:\d+(?:\([^)]+\))?.*Video:\s*([^,]+),\s*([^,]+),\s*(\d+)x(\d+)/i) ||
    txt.match(/Video:\s*([^,]+),\s*([^,]+),\s*(\d+)x(\d+)/i);

  const codec  = m?.[1]?.trim() || null;
  const pixFmt = m?.[2]?.trim() || null;
  const width  = m?.[3] ? Number(m[3]) : 0;
  const height = m?.[4] ? Number(m[4]) : 0;

  const is10bit = !!(pixFmt && /10le|p010|yuv420p10/i.test(pixFmt));
  const isHDR = /bt2020|bt2020nc|smpte2084|arib-std-b67|mastering display metadata|content light level|hdr10|hlg|pq/i.test(txt);
  const isDV  = /dolby vision|dovi/i.test(txt);

  return {
    ok: !!(codec || (width > 0 && height > 0)),
    codec,
    pixFmt,
    width,
    height,
    is10bit,
    isHDR,
    isDV,
    ffmpegCode: code,
    rawTail: txt.split("\n").slice(-24).join("\n")
  };
}
