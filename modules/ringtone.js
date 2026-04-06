import { spawn } from "child_process";
import { probeMediaFile } from "./probe.js";
import { FFMPEG_BIN } from "./binaries.js";

const DEFAULT_DURATION_SEC = 30;
const MIN_DURATION_SEC = 5;
const DEFAULT_FADE_IN_SEC = 0.5;
const DEFAULT_FADE_OUT_SEC = 1.0;
const MIN_FADE_OUT_SEC = 0.05;
const MAX_FADE_OUT_SEC = 3.0;

const TARGET_PRESETS = {
  iphone: {
    label: "iPhone",
    format: "m4r",
    sampleRate: 44100,
    defaultBitrate: "256k",
    maxDurationSec: 40
  },
  android: {
    label: "Android",
    format: "mp3",
    sampleRate: 44100,
    defaultBitrate: "192k",
    maxDurationSec: 60
  }
};

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function roundSeconds(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function parseTimeLike(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const src = String(value).trim();
  if (!src) return null;

  const timeMatch = src.match(
    /^(?:(\d+):)?([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/
  );
  if (timeMatch) {
    const hours = Number(timeMatch[1] || 0);
    const minutes = Number(timeMatch[2] || 0);
    const seconds = Number(timeMatch[3] || 0);
    const total = (hours * 3600) + (minutes * 60) + seconds;
    return Number.isFinite(total) ? total : null;
  }

  const num = Number(src.replace(",", "."));
  return Number.isFinite(num) ? num : null;
}

function parseObjectLike(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

function getTargetPreset(target = "android") {
  const key = String(target || "").trim().toLowerCase();
  return TARGET_PRESETS[key] || TARGET_PRESETS.android;
}

async function probeDurationSeconds(inputPath) {
  try {
    const probe = await probeMediaFile(inputPath);
    const raw =
      probe?.format?.duration ??
      probe?.streams?.find((stream) => Number(stream?.duration) > 0)?.duration ??
      null;
    const duration = Number(raw);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  } catch {
    return null;
  }
}

async function decodeAudioEnvelope(
  inputPath,
  {
    ffmpegBin = FFMPEG_BIN || "ffmpeg",
    onProcess,
    isCanceled,
    selectedStreams
  } = {}
) {
  const totalDuration = await probeDurationSeconds(inputPath);
  const analysisRate = totalDuration && totalDuration > 1800 ? 1000 : 2000;

  return await new Promise((resolve, reject) => {
    let canceled = false;
    const args = ["-hide_banner", "-nostdin", "-v", "error", "-i", inputPath];

    const selectedAudioIndex =
      Array.isArray(selectedStreams?.audio) &&
      Number.isInteger(selectedStreams.audio[0]) &&
      selectedStreams.audio[0] >= 0
        ? selectedStreams.audio[0]
        : null;

    if (selectedAudioIndex != null) {
      args.push("-map", `0:${selectedAudioIndex}`);
    } else {
      args.push("-map", "0:a:0?");
    }

    args.push("-vn", "-ac", "1", "-ar", String(analysisRate), "-f", "f32le", "pipe:1");

    const child = spawn(ffmpegBin, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      if (typeof onProcess === "function") onProcess(child);
    } catch {}

    const stdoutChunks = [];
    let stderr = "";

    const cancelTimer = setInterval(() => {
      if (!canceled && typeof isCanceled === "function" && isCanceled()) {
        canceled = true;
        try { child.kill("SIGTERM"); } catch {}
      }
    }, 200);
    cancelTimer.unref?.();

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      clearInterval(cancelTimer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearInterval(cancelTimer);
      if (canceled || signal === "SIGTERM" || signal === "SIGKILL") {
        return reject(new Error("CANCELED"));
      }
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-6).join("\n");
        return reject(new Error(tail || `FFmpeg analysis failed (${code})`));
      }

      const buffer = Buffer.concat(stdoutChunks);
      resolve({ buffer, analysisRate, totalDuration });
    });
  });
}

function chooseBestWindow(energies, totalDuration, clipDuration, windowSec) {
  const clipWindows = Math.max(1, Math.ceil(clipDuration / windowSec));
  if (energies.length <= clipWindows) {
    return 0;
  }

  const smoothed = energies.map((_, index) => {
    let total = 0;
    let count = 0;
    for (let i = Math.max(0, index - 2); i <= Math.min(energies.length - 1, index + 2); i++) {
      total += energies[i];
      count += 1;
    }
    return count > 0 ? total / count : 0;
  });

  const prefix = [0];
  for (const value of smoothed) prefix.push(prefix[prefix.length - 1] + value);

  const overallMean = prefix[prefix.length - 1] / Math.max(1, smoothed.length);
  let overallPeak = 0;
  for (const value of smoothed) {
    if (value > overallPeak) overallPeak = value;
  }
  if (overallPeak <= 1e-6) {
    return clamp(totalDuration * 0.3, 0, Math.max(0, totalDuration - clipDuration));
  }

  const guardStartSec =
    totalDuration > clipDuration + 15
      ? Math.min(12, Math.max(3, totalDuration * 0.08))
      : 0;
  const guardEndSec =
    totalDuration > clipDuration + 15
      ? Math.min(12, Math.max(3, totalDuration * 0.06))
      : 0;

  const maxWindowStart = Math.max(0, smoothed.length - clipWindows);
  let minStartWindow = Math.max(0, Math.floor(guardStartSec / windowSec));
  let maxStartWindow = Math.max(
    minStartWindow,
    Math.floor((totalDuration - clipDuration - guardEndSec) / windowSec)
  );

  if (maxStartWindow > maxWindowStart) maxStartWindow = maxWindowStart;
  if (minStartWindow > maxStartWindow) {
    minStartWindow = 0;
    maxStartWindow = maxWindowStart;
  }

  let bestScore = -Infinity;
  let bestWindow = minStartWindow;

  for (let startWindow = minStartWindow; startWindow <= maxStartWindow; startWindow++) {
    const endWindow = Math.min(smoothed.length, startWindow + clipWindows);
    const avgEnergy =
      (prefix[endWindow] - prefix[startWindow]) / Math.max(1, endWindow - startWindow);
    const edgeEnergy = Math.min(
      smoothed[startWindow] ?? avgEnergy,
      smoothed[Math.max(startWindow, endWindow - 1)] ?? avgEnergy
    );
    const centerRatio = (((startWindow + (clipWindows / 2)) * windowSec) / totalDuration) || 0;
    const centerPenalty = Math.abs(centerRatio - 0.52) * overallMean * 0.45;
    const score = (avgEnergy * 0.85) + (edgeEnergy * 0.25) - centerPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestWindow = startWindow;
    }
  }

  return clamp(bestWindow * windowSec, 0, Math.max(0, totalDuration - clipDuration));
}

export function getRingtoneTargetPreset(target = "android") {
  return getTargetPreset(target);
}

export function isRingtoneEnabled(ringtone) {
  return !!(ringtone && ringtone.enabled);
}

export function normalizeRingtoneConfig(raw) {
  const src = parseObjectLike(raw);
  if (!src) return null;

  const outputMode = String(src.outputMode || "").trim().toLowerCase();
  const enabledFlag = parseBoolean(src.enabled);
  const inferredEnabled =
    enabledFlag === true ||
    outputMode === "ringtone" ||
    src.target != null ||
    src.mode != null ||
    src.durationSec != null ||
    src.startSec != null ||
    src.endSec != null ||
    src.fadeInSec != null ||
    src.fadeOutSec != null;

  if (!inferredEnabled || enabledFlag === false) return null;

  const targetKey = String(src.target || src.platform || "android").trim().toLowerCase();
  const preset = getTargetPreset(targetKey);
  const modeRaw = String(src.mode || "auto").trim().toLowerCase();
  const mode = modeRaw === "manual" ? "manual" : "auto";

  const startRaw = parseTimeLike(src.startSec ?? src.start ?? src.clipStart);
  const endRaw = parseTimeLike(src.endSec ?? src.end ?? src.clipEnd);
  let durationSec =
    parseTimeLike(src.durationSec ?? src.duration ?? src.clipDuration) ??
    DEFAULT_DURATION_SEC;
  const fadeInRaw = parseTimeLike(
    src.fadeInSec ?? src.fadeIn ?? src.fadeInDuration
  );
  const fadeOutRaw = parseTimeLike(
    src.fadeOutSec ?? src.fadeOut ?? src.fadeOutDuration
  );

  let startSec = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0;
  if (Number.isFinite(startRaw) && Number.isFinite(endRaw) && endRaw > startRaw) {
    durationSec = endRaw - startRaw;
  }

  durationSec = clamp(durationSec, MIN_DURATION_SEC, preset.maxDurationSec);
  startSec = roundSeconds(startSec);
  durationSec = roundSeconds(durationSec);
  const fadeInSec = roundSeconds(
    Number.isFinite(fadeInRaw)
      ? clamp(fadeInRaw, MIN_FADE_OUT_SEC, MAX_FADE_OUT_SEC)
      : DEFAULT_FADE_IN_SEC
  );
  const fadeOutSec = roundSeconds(
    Number.isFinite(fadeOutRaw)
      ? clamp(fadeOutRaw, MIN_FADE_OUT_SEC, MAX_FADE_OUT_SEC)
      : DEFAULT_FADE_OUT_SEC
  );

  return {
    enabled: true,
    target: targetKey === "iphone" ? "iphone" : "android",
    targetLabel: preset.label,
    mode,
    outputFormat: preset.format,
    sampleRate: preset.sampleRate,
    defaultBitrate: preset.defaultBitrate,
    durationSec,
    startSec: mode === "manual" ? startSec : null,
    maxDurationSec: preset.maxDurationSec,
    fadeInSec,
    fadeOutSec
  };
}

export function resolveRingtoneOutputFormat(ringtone, fallbackFormat = "mp3") {
  return isRingtoneEnabled(ringtone) ? ringtone.outputFormat : fallbackFormat;
}

export function resolveRingtoneBitrate(ringtone, bitrate) {
  if (!isRingtoneEnabled(ringtone)) return bitrate;
  const value = String(bitrate || "").trim().toLowerCase();
  if (!value || ["auto", "0", "lossless", "original"].includes(value)) {
    return ringtone.defaultBitrate;
  }
  return bitrate;
}

export function resolveRingtoneSampleRate(ringtone, fallbackSampleRate = 48000) {
  if (!isRingtoneEnabled(ringtone)) return fallbackSampleRate;
  return ringtone.sampleRate || fallbackSampleRate;
}

export function describeRingtone(ringtone) {
  if (!isRingtoneEnabled(ringtone)) return "";
  const target = ringtone.target === "iphone" ? "iPhone" : "Android";
  const duration = `${Math.round(Number(ringtone.durationSec || 0))}s`;
  const mode = ringtone.mode === "manual" ? "manual" : "auto";
  return `${target} ringtone • ${duration} • ${mode}`;
}

export async function resolveRingtoneSegment(inputPath, ringtone, opts = {}) {
  if (!isRingtoneEnabled(ringtone)) return null;

  const requestedDuration = Number(ringtone.durationSec || DEFAULT_DURATION_SEC) || DEFAULT_DURATION_SEC;
  const sourceDuration = await probeDurationSeconds(inputPath);
  const durationSec =
    Number.isFinite(sourceDuration) && sourceDuration > 0
      ? Math.min(requestedDuration, sourceDuration)
      : requestedDuration;

  if (ringtone.mode === "manual") {
    let startSec = Math.max(0, Number(ringtone.startSec || 0) || 0);
    if (Number.isFinite(sourceDuration) && sourceDuration > durationSec) {
      startSec = Math.min(startSec, Math.max(0, sourceDuration - durationSec));
    } else if (Number.isFinite(sourceDuration) && sourceDuration <= durationSec) {
      startSec = 0;
    }

    return {
      mode: "manual",
      startSec: roundSeconds(startSec),
      durationSec: roundSeconds(durationSec),
      endSec: roundSeconds(startSec + durationSec),
      sourceDurationSec: Number.isFinite(sourceDuration) ? roundSeconds(sourceDuration) : null
    };
  }

  if (!Number.isFinite(sourceDuration) || sourceDuration <= durationSec + 0.35) {
    return {
      mode: "auto",
      startSec: 0,
      durationSec: roundSeconds(durationSec),
      endSec: roundSeconds(durationSec),
      sourceDurationSec: Number.isFinite(sourceDuration) ? roundSeconds(sourceDuration) : null
    };
  }

  const { buffer, analysisRate } = await decodeAudioEnvelope(inputPath, opts);
  const sampleCount = Math.floor(buffer.byteLength / 4);

  if (sampleCount <= 0) {
    const fallbackStart = clamp(sourceDuration * 0.3, 0, Math.max(0, sourceDuration - durationSec));
    return {
      mode: "auto",
      startSec: roundSeconds(fallbackStart),
      durationSec: roundSeconds(durationSec),
      endSec: roundSeconds(fallbackStart + durationSec),
      sourceDurationSec: roundSeconds(sourceDuration)
    };
  }

  const samples = new Float32Array(sampleCount);
  for (let i = 0, offset = 0; i < sampleCount; i++, offset += 4) {
    samples[i] = buffer.readFloatLE(offset);
  }
  const windowSec = sourceDuration > 900 ? 1 : 0.5;
  const samplesPerWindow = Math.max(1, Math.floor(analysisRate * windowSec));
  const energies = [];

  for (let offset = 0; offset < samples.length; offset += samplesPerWindow) {
    const end = Math.min(samples.length, offset + samplesPerWindow);
    let sumSq = 0;
    for (let i = offset; i < end; i++) {
      const sample = samples[i];
      sumSq += sample * sample;
    }
    const count = Math.max(1, end - offset);
    energies.push(Math.sqrt(sumSq / count));
  }

  const startSec = chooseBestWindow(energies, sourceDuration, durationSec, windowSec);

  return {
    mode: "auto",
    startSec: roundSeconds(startSec),
    durationSec: roundSeconds(durationSec),
    endSec: roundSeconds(startSec + durationSec),
    sourceDurationSec: roundSeconds(sourceDuration)
  };
}
