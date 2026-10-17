import { spawnSafe } from './safeProcess.js';
import { terminateProcess } from './processTermination.js';

export function shouldDetectBlackBars(settings = {}) {
  return settings.autoCropBlackBars === true
    && settings.transcodeEnabled === true
    && String(settings.heightMode || 'auto').toLowerCase() === 'auto'
    && String(settings.videoCodec || 'auto').toLowerCase() !== 'copy'
    && !settings.cropEnabled;
}

export function cropSampleWindows(duration, start = 0) {
  const seconds = Number(duration);
  const offset = Number(start);
  if (!Number.isFinite(seconds) || seconds < 1 || !Number.isFinite(offset) || offset < 0) return [];
  const length = Math.min(2, Math.max(0.75, seconds / 5));
  return [0.1, 0.25, 0.5, 0.75, 0.9].map(fraction => ({
    start: offset + Math.min(seconds - length, seconds * fraction),
    duration: length
  }));
}

// Cropdetect runs in the same orientation as the conversion filter chain.
export function cropAnalysisGeometry(info = {}, orientation = 'auto') {
  let width = Number(info.width);
  let height = Number(info.height);
  const rotation = Math.abs(Number(info.rotation) || 0) % 180;
  if (orientation === 'auto' && rotation === 90) [width, height] = [height, width];
  if (orientation === '90cw' || orientation === '90ccw') [width, height] = [height, width];
  return { width, height };
}

export function parseCropRect(line, width, height) {
  const match = String(line).match(/\bcrop=(\d{1,6}):(\d{1,6}):(\d{1,6}):(\d{1,6})\b/);
  if (!match) return null;
  const [w, h, x, y] = match.slice(1).map(Number);
  if (w < 2 || h < 2 || x + w > width || y + h > height) return null;
  // Discard black/faded frames and implausibly small content rectangles.
  if (w < width * 0.6 || h < height * 0.45) return null;
  return { w, h, x, y };
}

export function selectBlackBarCrop(samples, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) return null;
  const rectangles = samples.filter(Boolean);
  if (rectangles.length < 3) return null;
  // Use the union, not the most aggressive crop: any sampled wider/taller
  // scene must remain visible (including changing aspect ratios).
  let left = Math.min(...rectangles.map(r => r.x));
  let top = Math.min(...rectangles.map(r => r.y));
  let right = Math.min(...rectangles.map(r => width - r.x - r.w));
  let bottom = Math.min(...rectangles.map(r => height - r.y - r.h));
  const safePair = (a, b, size) => {
    const minimum = Math.max(4, Math.round(size * 0.005));
    const tolerance = Math.max(4, Math.round(size * 0.01));
    if (a < minimum || b < minimum || Math.abs(a - b) > tolerance) return [0, 0];
    // Keep an extra even pixel at each boundary to avoid trimming real content.
    return [Math.max(0, Math.floor(a / 2) * 2 - 2), Math.max(0, Math.floor(b / 2) * 2 - 2)];
  };
  [left, right] = safePair(left, right, width);
  [top, bottom] = safePair(top, bottom, height);
  if (!(left || right || top || bottom)) return null;
  const w = Math.floor((width - left - right) / 2) * 2;
  const h = Math.floor((height - top - bottom) / 2) * 2;
  return { w, h, x: left, y: top, filter: `crop=${w}:${h}:${left}:${top}` };
}

// At most five short, sequential samples; never scan the entire movie or run
// multiple crop probes in parallel for a single conversion.
export async function detectBlackBars({
  ffmpegBin, inputPath, width, height, duration, start = 0,
  orientation = 'auto', orientationFilter = null,
  onProcess, isCanceled = () => false, spawn = spawnSafe,
  // Accurate clip seeking must decode the preceding GOP before producing a
  // sample. Give clipped 4K/HEVC inputs more time without seeking outside them.
  timeoutMs = Number(start) > 0 ? 60_000 : 30_000,
  sampleTimeoutMs = Number(start) > 0 ? 12_000 : 7_000
}) {
  const windows = cropSampleWindows(duration, start);
  if (!windows.length || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  const deadline = Date.now() + timeoutMs;
  const samples = [];
  for (const window of windows) {
    if (isCanceled()) throw new Error('CANCELED');
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const rect = await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', '2'];
      // Sampling the nearby keyframe is sufficient for whole-file border
      // analysis and avoids decoding a long 4K GOP just to discard its frames.
      // Explicit clips keep accurate seeking so samples cannot precede them.
      if (Number(start) === 0) args.push('-noaccurate_seek');
      if (orientation !== 'auto') args.push('-noautorotate');
      args.push('-ss', String(window.start), '-i', inputPath,
        '-t', String(window.duration), '-map', '0:v:0', '-an', '-sn', '-dn',
        '-filter_threads', '1', '-vf',
        [orientationFilter, 'fps=4', 'cropdetect=limit=0.094:round=2:reset=0:skip=2'].filter(Boolean).join(','),
        '-f', 'null', '-');
      let child;
      try {
        child = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch {
        resolve(null);
        return;
      }
      let last = null;
      let pending = '';
      let failed = false;
      let canceled = false;
      let settled = false;
      let forceFinish;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceFinish);
        clearInterval(cancelTimer);
        if (canceled || isCanceled()) reject(new Error('CANCELED'));
        else resolve(!failed && code === 0 ? last : null);
      };
      const stop = () => {
        failed = true;
        terminateProcess(child, { graceMs: 1000 });
        if (!settled) forceFinish = setTimeout(() => finish(1), 2500);
      };
      const timer = setTimeout(stop, Math.min(sampleTimeoutMs, remaining));
      const cancelTimer = setInterval(() => {
        if (!canceled && isCanceled()) { canceled = true; stop(); }
      }, 200);
      child.stderr.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop().slice(-2048);
        for (const line of lines) {
          // Input filenames/tags can appear in stderr too; only trust the
          // cropdetect filter's own geometry records, never media metadata.
          if (!/^\[(?:Parsed_)?cropdetect(?:_\d+)? @ /.test(line)) continue;
          const detected = parseCropRect(line, width, height);
          if (detected) last = detected;
        }
      });
      child.once('error', () => finish(1));
      child.once('close', code => finish(code));
      try { onProcess?.(child); } catch {}
    });
    // Failed/inconclusive windows are not evidence that a border is safe to cut.
    if (!rect) return null;
    samples.push(rect);
  }
  return selectBlackBarCrop(samples, width, height);
}
