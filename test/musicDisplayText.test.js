import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMusicDisplayText } from '../modules/musicDisplayText.js';
import { pickPlaylistOutputName, ensurePlaylistOutputDir } from '../modules/outputPaths.js';
import { sanitizeFilename } from '../modules/utils.js';

test('redundant lowercase-i dots are cleaned without transliterating or changing case', () => {
  assert.equal(normalizeMusicDisplayText('Gördün Mü Yillar Geçmi\u0307ş'), 'Gördün Mü Yillar Geçmiş');
  assert.equal(normalizeMusicDisplayText('Geçmiş'), 'Geçmiş');
  assert.equal(normalizeMusicDisplayText('İnci Işık ı Arvo Pärt Ólafur Arnalds'), 'İnci Işık ı Arvo Pärt Ólafur Arnalds');
  assert.equal(normalizeMusicDisplayText('Derni\u0065\u0300re Danse'), 'Dernière Danse');
  assert.equal(normalizeMusicDisplayText('Żółć ṡ'), 'Żółć ṡ');
  assert.equal(sanitizeFilename('Artist - Geçmi\u0307ş.mp3'), 'Artist - Geçmiş.mp3');
});

test('new playlist folders clean catalogue text and leave existing directories untouched', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-name-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirty = 'Gördün Mü Yillar Geçmi\u0307ş - mp3';
  fs.mkdirSync(path.join(root, dirty));
  for (const source of ['spotify', 'apple_music', 'deezer', 'tidal', 'soundcloud', 'text']) {
    const job = { format: 'mp3', metadata: { source, isPlaylist: true, frozenTitle: 'Gördün Mü Yillar Geçmi\u0307ş' } };
    assert.equal(pickPlaylistOutputName(job), 'Gördün Mü Yillar Geçmiş - mp3');
  }
  const job = { format: 'mp3', metadata: { source: 'spotify', isPlaylist: true, spotifyTitle: 'Gördün Mü Yillar Geçmi\u0307ş' } };
  assert.equal(path.basename(ensurePlaylistOutputDir(job, root)), 'Gördün Mü Yillar Geçmiş - mp3');
  assert.ok(fs.existsSync(path.join(root, dirty)), 'never silently rename an existing output directory');
  const existing = { format: 'mp3', metadata: { ...job.metadata, outputSubdir: dirty } };
  assert.equal(path.basename(ensurePlaylistOutputDir(existing, root)), dirty, 'saved paths must stay valid');
});
