import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [root, format, scenario] = process.argv.slice(2);
process.env.DATA_DIR = root;
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.PROGRESS_CASE = scenario;
const output = path.join(root, 'outputs');
const temp = path.join(root, 'temp');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(temp, { recursive: true });
const input = path.join(temp, 'source.mp4');
fs.writeFileSync(input, 'fixture input');
const { convertMedia } = await import('../../modules/media.js');
const events = [];
await convertMedia(input, format, 'auto', 'progress', (percent, details) => {
  events.push({ percent, ...details });
}, {}, null, true, output, temp, {
  outputRootDir: output, includeLyrics: false,
  selectedStreams: { hasVideo: true, audio: [], subtitles: [],
    ...(scenario === 'clip-duration' ? { previewClip: { enabled: true, start: '00:00:02', end: '00:00:22' } } : {}) },
  videoSettings: { transcodeEnabled: true, hwaccel: 'off', videoCodec: 'h264',
    heightMode: 'source', hdrMode: 'none', swSettings: { preset: 'veryfast', level: 'auto' } }
});
const live = events.filter(event => event.percent > 0 && event.percent < 100);
assert.ok(live.some(event => event.percent === 25), 'must report live progress before completion');
assert.ok(live.some(event => event.percent === 50), 'must continue updating during conversion');
for (const event of live) {
  assert.equal(event.durationSeconds, 20);
  assert.equal(event.durationText, '00:00:20');
  assert.ok(event.elapsedSeconds > 0);
  assert.ok(event.fps > 0);
}
assert.equal(events.at(-1).percent, 100);
console.log('MEDIA_PROGRESS_OK');
