import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
const realSource = process.argv[3];
const liveStart = process.argv[4] || '00:00:00';
const startSeconds = liveStart.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const liveEnd = new Date((startSeconds + 60) * 1000).toISOString().slice(11, 19);
process.env.DATA_DIR = root;
process.env.CACHE_DIR = path.join(root, 'cache');
const find = name => process.env.PATH.split(path.delimiter)
  .map(dir => path.join(dir, name + (process.platform === 'win32' ? '.exe' : '')))
  .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const ffmpeg = process.env.TIMELINE_FFMPEG || find('ffmpeg');
const ffprobe = process.env.TIMELINE_FFPROBE || find('ffprobe');
process.env.FFMPEG_BIN = ffmpeg;
process.env.FFPROBE_BIN = ffprobe;
const { convertMedia } = await import('../../modules/media.js');
const { resolveDownloadPathToAbs } = await import('../../modules/outputPaths.js');
const output = path.join(root, 'outputs');
const temp = path.join(root, 'temp');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(temp, { recursive: true });
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 3_000_000 });
const packets = file => JSON.parse(run(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pts_time,duration_time', '-of', 'json', file])).packets;
let source = realSource;
if (!source) {
  const seed = path.join(root, 'seed.mkv');
  run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-c:a', 'aac', seed]);
  const frames = packets(seed);
  const mapFile = (name, times) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, '# timestamp format v2\n' + [...times, times.at(-1) + 40].join('\n') + '\n');
    return file;
  };
  const videoTimes = mapFile('video.txt', frames.filter(p => p.stream_index === 0)
    .map((_, i) => 80 + 40 * i + (i >= 50 ? 120 : 0) + (i >= 150 ? 80 : 0)));
  let lastAudioTime = 0;
  const audioTimes = mapFile('audio.txt', frames.filter(p => p.stream_index === 1)
    .map((_, i) => lastAudioTime = Math.max(lastAudioTime, Math.round(i * 1024 / 48) - Math.floor(i / 64) * 32)));
  const delayedTimes = mapFile('delayed.txt', frames.filter(p => p.stream_index === 2)
    .map((_, i) => 240 + Math.round(i * 1024 / 48)));
  source = path.join(root, 'irregular.mkv');
  run('mkvmerge', ['-o', source, '--disable-lacing', '--timestamps', `0:${videoTimes}`,
    '--timestamps', `1:${audioTimes}`, '--timestamps', `2:${delayedTimes}`, seed]);
}

const cases = realSource
  ? [['live', 'mkv', 'ac3', {}, 25]]
  : [
    ['ac3', 'mkv', 'ac3', {}, 25], ['aac', 'mp4', 'aac', {}, 25],
    ['eac3', 'mkv', 'eac3', {}, 25],
    ['preview', 'mkv', 'ac3', {}, 25], ['fps24', 'mkv', 'ac3', { fps: '24' }, 24],
    ['copy', 'mkv', 'copy', { videoCodec: 'copy' }, 25],
    ['video-copy', 'mkv', 'ac3', { videoCodec: 'copy' }, 25],
    ['audio-copy', 'mkv', 'copy', {}, 25],
    ['tempo', 'mkv', 'ac3', { audioAtempoAdjust: '25_24' }, 25]
  ];
for (const [title, format, audioCodec, override, fps] of cases) {
  const processes = [];
  const stages = [];
  const result = await convertMedia(source, format, 'auto', `timeline-${title}`, () => {}, { title }, null, true, output, temp, {
    ffmpegBin: ffmpeg, outputRootDir: output,
    onStage: stage => stages.push(stage),
    onProcess: child => processes.push(child.spawnargs || []),
    selectedStreams: { hasVideo: true, audio: realSource ? [1] : [1, 2], subtitles: [],
      ...((title === 'preview' || realSource) ? { previewClip: { enabled: true, start: realSource ? liveStart : '00:00:02', end: realSource ? liveEnd : '00:00:04' } } : {}) },
    videoSettings: { transcodeEnabled: true, heightMode: 'auto', scaleMode: 'custom', targetWidth: realSource ? 640 : 160,
      hwaccel: process.env.TIMELINE_HWACCEL || 'off', videoCodec: 'h264', hdrMode: 'none', fps: 'source', swSettings: { preset: 'veryfast', quality: 23, level: 'auto' },
      audioTranscodeEnabled: true, audioCodec, audioBitrate: '192k', audioChannels: 'original', audioSampleRate: '48000', ...override }
  });
  const file = resolveDownloadPathToAbs(result.outputPath, output);
  assert.deepEqual(stages, ['preparing', 'converting', 'ready'], `${title} conversion stages`);
  const args = processes.find(args => args.includes(file));
  assert.ok(args, title);
  const af = args.includes('-af') ? args[args.indexOf('-af') + 1] : '';
  if (audioCodec === 'copy') assert.equal(af, '', title);
  else assert.match(af, /^aresample=async=1:min_hard_comp=0.01/, title);
  if (title === 'tempo') assert.match(af, /aresample=[^,]+,atempo=0\.96/);
  if (override.videoCodec === 'copy') {
    assert.ok(!args.includes('-vf'), title);
    assert.ok(!af.includes('first_pts=0'), title);
  }
  if (['copy', 'video-copy', 'audio-copy', 'tempo'].includes(title)) continue;
  if (!realSource && title !== 'preview') {
    const rms = (start, end) => {
      const pcm = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:1',
        '-af', `atrim=start=${start}:end=${end}`, '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'],
      { timeout: 30_000, maxBuffer: 1_000_000 });
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2) energy += (pcm.readInt16LE(i) / 32768) ** 2;
      return Math.sqrt(energy / (pcm.length / 2));
    };
    // Materializing the delayed track must add silence, not move its content
    // earlier by independently resetting its PTS to zero.
    assert.ok(rms(0, 0.1) < 0.001, `${title} delayed track silence`);
    assert.ok(rms(0.4, 0.5) > 0.03, `${title} delayed track content`);
  }
  const original = packets(file);
  // Export raw tracks only. No G-TMCE manifests/timestamp maps or --sync flags.
  const tracks = JSON.parse(run('mkvmerge', ['-J', file])).tracks;
  const video = path.join(root, `${title}.h264`);
  const audios = tracks.filter(t => t.type === 'audio').map((t, i) => ({
    id: t.id, file: path.join(root, `${title}-${i}.${audioCodec}`)
  }));
  if (format === 'mp4') {
    run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', video]);
    for (const [i, audio] of audios.entries()) {
      run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-map', `0:a:${i}`, '-c', 'copy', '-f', 'adts', audio.file]);
    }
  } else {
    run('mkvextract', [file, 'tracks', `0:${video}`, ...audios.map(t => `${t.id}:${t.file}`)]);
  }
  const rebuilt = path.join(root, `${title}-rebuilt.mkv`);
  run('mkvmerge', ['-o', rebuilt, '--default-duration', `0:${fps}fps`, video, ...audios.map(t => t.file)]);
  const after = packets(rebuilt);
  const shifts = [];
  for (let stream = 0; stream <= audios.length; stream++) {
    const a = original.filter(p => p.stream_index === stream);
    const b = after.filter(p => p.stream_index === stream);
    assert.equal(b.length, a.length, `${title} stream ${stream} packet count`);
    const deltas = a.map((p, i) => Number(b[i].pts_time) - Number(p.pts_time));
    // MKVToolNix's raw AAC reader and Matroska's millisecond timebase introduce
    // up to 2ms rounding spread; this is not accumulated timestamp drift.
    const rounding = audioCodec === 'aac' && stream > 0 ? 0.0021 : 0.0011;
    assert.ok(Math.max(...deltas) - Math.min(...deltas) <= rounding, `${title} stream ${stream} drift`);
    shifts.push(deltas[0]);
    if (stream === 0) {
      const sorted = a.map(p => Number(p.pts_time)).sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) assert.ok(Math.abs(sorted[i] - sorted[i - 1] - 1 / fps) < 0.0011);
    }
  }
  // Raw AAC loses 1024-sample priming; AC-3 loses 256-sample priming. That
  // bounded codec delay is distinct from accumulating drift or source offsets.
  const tolerance = audioCodec === 'aac' ? 0.023 : 0.007;
  assert.ok(Math.max(...shifts) - Math.min(...shifts) <= tolerance, `${title} remux A/V shift`);
  const durations = [file, rebuilt].map(f => Number(JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', f])).format.duration));
  assert.ok(Math.abs(durations[1] - durations[0]) < 0.05, `${title} duration`);
  console.log(JSON.stringify({ case: title, durations, shifts, file, rebuilt }));
}
console.log('VIDEO_TIMELINE_OK');
process.exit(0);
