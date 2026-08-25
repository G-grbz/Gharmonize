import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  deezerGatewayTrackToMeta,
  parseDeezerUrl,
  resolveDeezerUrlLite
} from '../modules/deezer.js';

test('Deezer inspired-by URLs accept optional global locale prefixes', () => {
  const cases = [
    ['https://www.deezer.com/smarttracklist/inspired-by-1', ''],
    ['https://www.deezer.com/tr/smarttracklist/inspired-by-2', 'tr'],
    ['https://www.deezer.com/en/smarttracklist/inspired-by-3', 'en'],
    ['https://www.deezer.com/fr/smarttracklist/inspired-by-42', 'fr'],
    ['https://www.deezer.com/pt-BR/smarttracklist/inspired-by-123', 'pt-br']
  ];

  for (const [url, locale] of cases) {
    assert.deepEqual(parseDeezerUrl(url), {
      type: 'smarttracklist',
      id: url.match(/inspired-by-\d+/)[0],
      view: '',
      locale
    });
  }
});

test('Deezer smart-tracklist parsing rejects malformed and unrelated paths', () => {
  for (const url of [
    'https://www.deezer.com/foo/smarttracklist/inspired-by-1',
    'https://www.deezer.com/tr/smarttracklist/inspired-by-xx',
    'https://www.deezer.com/tr/smarttracklist/inspired-by-1/extra',
    'https://example.com/tr/smarttracklist/inspired-by-1'
  ]) {
    assert.equal(parseDeezerUrl(url).type, 'unknown');
  }
});

test('Deezer gateway rows retain useful metadata when public hydration fails', () => {
  const meta = deezerGatewayTrackToMeta({
    SNG_ID: '12345',
    SNG_TITLE: 'Example Song',
    ART_ID: '55',
    ART_NAME: 'Example Artist',
    ALB_ID: '77',
    ALB_TITLE: 'Example Album',
    ALB_PICTURE: 'abcdef0123456789',
    DURATION: '201',
    ISRC: 'TRABC2500001',
    PHYSICAL_RELEASE_DATE: '2025-05-16',
    TRACK_NUMBER: '4',
    DISK_NUMBER: '1'
  });

  assert.equal(meta.deezer_track_id, 12345);
  assert.equal(meta.title, 'Example Song');
  assert.equal(meta.artist, 'Example Artist');
  assert.equal(meta.album, 'Example Album');
  assert.equal(meta.duration_ms, 201000);
  assert.equal(meta.isrc, 'TRABC2500001');
  assert.match(meta.coverUrl, /abcdef0123456789/);
});

test('personalized Deezer lists explain that DEEZER_ARL is required', async () => {
  const previous = process.env.DEEZER_ARL;
  delete process.env.DEEZER_ARL;
  try {
    await assert.rejects(
      () => resolveDeezerUrlLite('https://www.deezer.com/de/smarttracklist/inspired-by-1'),
      (error) => error?.code === 'DEEZER_ARL_REQUIRED' && /personalized/i.test(error.message)
    );
  } finally {
    if (typeof previous === 'undefined') delete process.env.DEEZER_ARL;
    else process.env.DEEZER_ARL = previous;
  }
});

test('classic UI treats Deezer inspired-by URLs as playlists', () => {
  const source = fs.readFileSync('public/ui/MediaConverterApp.js', 'utf8');
  assert.ok(source.includes("/^inspired-by-\\d+$/i.test(parts[smartTracklistIndex + 1] || '')"));
  assert.match(source, /smartTracklistIndex\s*>=\s*0[\s\S]{0,200}?return 'playlist'/);
});
