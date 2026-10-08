import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseFile } from 'music-metadata';

const root = process.argv[2];
process.env.DATA_DIR = root;
process.env.CACHE_DIR = path.join(root, 'cache');
process.env.MP3_WRITE_XING = '0'; // Old configurations must not break VBR/remux.
process.env.WRITE_ID3V1 = '1';
const ffmpegVersion = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
assert.match(ffmpegVersion, /ffmpeg version/);
// Resolve PATH executables so managed binaries cannot influence this fixture.
const find = (name) => process.env.PATH.split(path.delimiter)
  .map((dir) => path.join(dir, name + (process.platform === 'win32' ? '.exe' : '')))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const ffmpeg = find('ffmpeg');
const ffprobe = find('ffprobe');
process.env.FFMPEG_BIN = ffmpeg;
process.env.FFPROBE_BIN = ffprobe;
const { convertMedia, retagMediaFile } = await import('../../modules/media.js');
const { attachLyricsToMedia, lyricsFetcher } = await import('../../modules/lyrics.js');
const { writeRichId3v2Tag, rewriteId3v11Tag } = await import('../../modules/id3.js');
const { resolveDownloadPathToAbs } = await import('../../modules/outputPaths.js');

const output = path.join(root, 'outputs');
const temp = path.join(root, 'temp');
fs.mkdirSync(output);
fs.mkdirSync(temp);
const source = path.join(root, 'variable.wav');
const cover = path.join(root, 'cover.jpg');
const metadata = { artist: 'Arvo Pärt', title: 'Spiegel im Spiegel', album: 'Fixture Album', duration: 9 };
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
const encode = (args) => run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', ...args]);
// Silence followed by a complex tone produces different frame bitrates and
// exposes duration estimation errors which a constant tone would not catch.
encode(['-f', 'lavfi', '-i', "aevalsrc='if(lt(t,3),0,0.3*sin(2*PI*440*t)+0.15*sin(2*PI*293*t))':s=48000:d=9", source]);
encode(['-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-threads', '1', cover]);

const probe = (file) => JSON.parse(run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
function verify(file) {
  const result = probe(file);
  assert.ok(Math.abs(Number(result.format.duration) - 9) < 0.1, `wrong duration: ${result.format.duration}`);
  assert.ok(result.streams.some((stream) => stream.disposition?.attached_pic === 1), 'cover must survive');
  const bytes = fs.readFileSync(file);
  const id3Length = bytes.subarray(0, 3).toString() === 'ID3'
    ? 10 + bytes.subarray(6, 10).reduce((size, value) => size * 128 + value, 0) : 0;
  assert.match(bytes.subarray(id3Length, id3Length + 512).toString('latin1'), /Xing|Info/, 'duration header must survive ID3 rewrites');
}
const audioHash = (file) => encode(['-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
const coverHash = (file) => encode(['-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();

// Instrumental/no-lyrics output must be correct without a later remux repairing it.
for (const bitrate of ['auto', '0', 'lossless', '192k']) {
  if (bitrate === '192k') delete process.env.MP3_WRITE_XING;
  const result = await convertMedia(source, 'mp3', bitrate, `mp3-duration-${bitrate}`, () => {}, metadata, cover, false, output, temp, {
    outputRootDir: output, ffmpegBin: ffmpeg, sampleRate: '48000', includeLyrics: false, embedLyrics: false,
  });
  assert.ok(result?.outputPath);
  const file = resolveDownloadPathToAbs(result.outputPath, output);
  verify(file);
  const parsed = await parseFile(file);
  assert.equal(parsed.common.artist, metadata.artist);
  assert.equal(parsed.common.title, metadata.title);
  assert.ok(Math.abs(parsed.format.duration - 9) < 0.1);
}

// Reproduce the old defect, then verify that retag repairs it by stream copy.
process.env.MP3_WRITE_XING = '0';
const legacy = path.join(output, 'legacy.mp3');
encode(['-i', source, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-q:a', '0', '-c:v', 'copy', '-disposition:v', 'attached_pic', '-write_xing', '0', legacy]);
assert.ok(Math.abs(Number(probe(legacy).format.duration) - 9) > 1, 'legacy fixture must reproduce inaccurate VBR duration');
const originalAudio = audioHash(legacy);
const originalCover = coverHash(legacy);
await retagMediaFile(legacy, 'mp3', metadata, null, { ffmpegBin: ffmpeg, tempDir: temp });
verify(legacy);
assert.equal(audioHash(legacy), originalAudio, 'retag must not re-encode audio');
assert.equal(coverHash(legacy), originalCover);

// Exercise actual lyric remux locally, without contacting LRCLib.
lyricsFetcher.searchLyrics = async () => ({ plainLyrics: 'Fixture lyric line' });
const lyrics = await attachLyricsToMedia(legacy, metadata, { includeLyrics: false, embedLyrics: true, returnDetails: true });
assert.equal(lyrics?.embedded, true);
writeRichId3v2Tag(legacy, metadata);
rewriteId3v11Tag(legacy, metadata);
verify(legacy);
assert.equal(audioHash(legacy), originalAudio, 'lyrics must not re-encode audio');
assert.equal(coverHash(legacy), originalCover);
const parsed = await parseFile(legacy);
assert.equal(parsed.common.artist, metadata.artist);
assert.equal(parsed.common.title, metadata.title);
assert.equal(probe(legacy).format.tags.lyrics, 'Fixture lyric line', 'embedded lyrics must survive final ID3 updates');
console.log('MP3_DURATION_OK');
process.exit(0);
