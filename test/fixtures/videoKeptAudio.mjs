// Real FFmpeg check of "Change Audio Codec" off: the source audio is copied,
// or re-encoded in its own codec/channels/rate when volume or loudnorm runs.
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
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(temp, { recursive: true });
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 3_000_000 });

function source(name, audioArgs, layout) {
  const file = path.join(root, `${name}.mkv`);
  run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-map', '0:v', '-map', '1:a', '-af', `aformat=channel_layouts=${layout}`,
    '-c:v', 'libx264', '-preset', 'veryfast', ...audioArgs, file]);
  return file;
}
const audioOf = file => JSON.parse(run(ffprobe, ['-v', 'error', '-select_streams', 'a',
  '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json', file])).streams[0];

const eac3 = source('eac3', ['-c:a', 'eac3', '-b:a', '640k'], '5.1');
const truehd = source('truehd', ['-c:a', 'truehd', '-strict', '-2'], '5.1');

const cases = [
  // [title, input, format, audio settings, expected codec, channels, filters applied]
  ['copy', eac3, 'mkv', {}, 'eac3', 6, false],
  ['loudnorm-keeps-eac3', eac3, 'mkv', { loudnorm: true }, 'eac3', 6, true],
  ['volume-keeps-eac3', eac3, 'mkv', { volumeGain: 1.5 }, 'eac3', 6, true],
  ['truehd-copied-filters-skipped', truehd, 'mkv', { loudnorm: true }, 'truehd', 6, false],
  ['truehd-into-mp4-fallback', truehd, 'mp4', {}, 'aac', 6, false]
];
for (const [title, input, format, audio, codec, channels, filtered] of cases) {
  const processes = [];
  const result = await convertMedia(input, format, 'auto', `kept-${title}`, () => {}, { title }, null, true, output, temp, {
    ffmpegBin: ffmpeg, outputRootDir: output,
    onProcess: child => processes.push(child.spawnargs || []),
    selectedStreams: { hasVideo: true, audio: [1], subtitles: [] },
    volumeGain: audio.volumeGain ?? 1, loudnorm: !!audio.loudnorm, loudnormMode: 'ebu_r128',
    videoSettings: { transcodeEnabled: false, audioTranscodeEnabled: false, audioCodec: 'aac', audioSampleRate: '48000' }
  });
  const file = resolveDownloadPathToAbs(result.outputPath, output);
  const args = processes.find(a => a.includes(file)) || [];
  const af = args.includes('-af') ? args[args.indexOf('-af') + 1] : '';
  const got = audioOf(file);
  assert.equal(got.codec_name, codec, `${title} codec`);
  assert.equal(Number(got.channels), channels, `${title} channels`);
  assert.equal(Number(got.sample_rate), 48000, `${title} sample rate (loudnorm must not leave 192 kHz)`);
  assert.equal(/loudnorm|volume=/.test(af), filtered, `${title} filters: ${af}`);
}
console.log('VIDEO_KEPT_AUDIO_OK');
