import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function fixture({ lyrics = 'A lyric', embedded = true, sidecar = null } = {}) {
  const source = fs.readFileSync(new URL('../modules/lyrics.js', import.meta.url), 'utf8');
  const attach = source.slice(source.indexOf('export async function attachLyricsToMedia'))
    .replace(/^export /, '');
  const messages = [];
  const context = vm.createContext({
    fs: { readFileSync() { return lyrics; } }, path,
    normalizeArtistName: (s) => s, normalizeTitle: (s) => s,
    emitLog: (_, payload) => messages.push(payload),
    lyricsFetcher: {
      async searchLyrics() { return lyrics ? { plainLyrics: lyrics } : null; },
      async downloadLyrics() { return sidecar; }
    },
    async embedLyricsInMedia() { return embedded; }
  });
  vm.runInContext(`${attach}\nglobalThis.attach = attachLyricsToMedia;`, context);
  return { attach: context.attach, messages };
}
const metadata = { artist: 'Indila', title: 'Dernière Danse' };

test('Embed-only lyrics return success details and count found exactly once', async () => {
  const { attach, messages } = fixture();
  const stats = [];
  const result = await attach('/tmp/track.mp3', metadata, {
    includeLyrics: false, embedLyrics: true, returnDetails: true,
    onLyricsStats: (value) => stats.push(value)
  });
  assert.equal(result.found, true);
  assert.equal(result.embedded, true);
  assert.equal(result.lyricsPath, null);
  assert.equal(stats.length, 1);
  assert.equal(stats[0].found, 1);
  assert.ok(messages.every((message) => message.logKey !== 'log.lyrics.notFoundForTrack'));
});

test('Lyrics distinguish failed embedding from missing lyrics without breaking the legacy path API', async () => {
  const failed = fixture({ embedded: false });
  const result = await failed.attach('/tmp/track.mp3', metadata, {
    includeLyrics: false, embedLyrics: true, returnDetails: true
  });
  assert.equal(result.found, true);
  assert.equal(result.embedded, false);
  const missing = fixture({ lyrics: '' });
  assert.equal(await missing.attach('/tmp/track.mp3', metadata, {
    includeLyrics: false, embedLyrics: true, returnDetails: true
  }), null);
  const legacy = fixture({ sidecar: '/tmp/track.lrc' });
  assert.equal(await legacy.attach('/tmp/track.mp3', metadata), '/tmp/track.lrc');
});
