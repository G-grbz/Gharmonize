import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
process.env.DATA_DIR = root;
process.env.CACHE_DIR = path.join(root, 'cache');
const find = name => process.env.PATH.split(path.delimiter)
  .map(dir => path.join(dir, name + (process.platform === 'win32' ? '.exe' : '')))
  .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const ffmpeg = find('ffmpeg');
const ffprobe = find('ffprobe');
process.env.FFMPEG_BIN = ffmpeg;
process.env.FFPROBE_BIN = ffprobe;
const { convertMedia } = await import('../../modules/media.js');
const { resolveDownloadPathToAbs } = await import('../../modules/outputPaths.js');
const output = path.join(root, 'outputs');
const temp = path.join(root, 'temp');
fs.mkdirSync(output);
fs.mkdirSync(temp);
const source = path.join(root, 'letterbox.mkv');
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=640x264:r=12:d=8',
  '-vf', 'pad=640:360:0:48:black', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', source]);
for (const [title, override, expected] of [
  ['enabled', { autoCropBlackBars: true }, [320, 134]],
  ['disabled', { autoCropBlackBars: false }, [320, 180]],
  ['source', { autoCropBlackBars: true, heightMode: 'source' }, [640, 360]],
  ['custom', { autoCropBlackBars: true, heightMode: 'custom', targetHeight: 160 }, [320, 160]],
  ['preview', { autoCropBlackBars: true }, [320, 134]]
]) {
  const logs = [];
  const result = await convertMedia(source, 'mp4', 'auto', `crop-${title}`, () => {}, { title, duration: 8 }, null, true, output, temp, {
    ffmpegBin: ffmpeg, outputRootDir: output,
    onLog: payload => logs.push(payload),
    selectedStreams: { hasVideo: true, audio: [], subtitles: [],
      ...(title === 'preview' ? { previewClip: { enabled: true, start: '00:00:02', end: '00:00:04' } } : {}) },
    videoSettings: { transcodeEnabled: true, heightMode: 'auto', scaleMode: 'custom', targetWidth: 320,
      hwaccel: 'off', videoCodec: 'h264', hdrMode: 'none', swSettings: { preset: 'ultrafast', quality: 23, level: 'auto' }, ...override }
  });
  const file = resolveDownloadPathToAbs(result.outputPath, output);
  const probe = JSON.parse(run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]));
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], expected, title);
  if (title === 'enabled' || title === 'preview') {
    assert.equal(logs[0].logKey, 'log.video.blackBarsDetecting');
    assert.equal(logs[1].logKey, 'log.video.blackBarsCropped');
    assert.deepEqual(logs[1].logVars, { sourceWidth: 640, sourceHeight: 360, width: 640, height: 268 });
  } else assert.ok(!logs.some(log => log.logKey?.startsWith('log.video.blackBars')));
  if (title === 'preview') {
    const duration = Number(JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file])).format.duration);
    assert.ok(Math.abs(duration - 2) < 0.1);
  }
}
console.log('AUTO_CROP_OK');
process.exit(0);
