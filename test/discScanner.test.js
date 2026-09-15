import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calculateBluRayPlaylistSize,
  resolveBluRayPlaylistDuration
} from '../modules/discScanner.js';

test('Blu-ray MPLS duration wins over an incorrect virtual ffprobe duration', () => {
  const duration = resolveBluRayPlaylistDuration(
    { playlist_duration: 119_702_911_111 },
    {},
    2132.26
  );

  assert.equal(duration, 119.702911111);
  assert.equal(resolveBluRayPlaylistDuration({}, {}, 2132.26), 2132.26);
});

test('Blu-ray clipped playlists do not count the same complete M2TS repeatedly', () => {
  const sourceSize = 28_655_579_136;
  const result = calculateBluRayPlaylistSize(
    119.702911111,
    [
      { path: '/disc/00059.m2ts', size: sourceSize, duration: 6526.56 },
      { path: '/disc/00059.m2ts', size: sourceSize, duration: 6526.56 }
    ],
    sourceSize * 4
  );

  assert.equal(result.estimated, true);
  assert.ok(result.sizeBytes > 500 * 1024 * 1024);
  assert.ok(result.sizeBytes < 510 * 1024 * 1024);
});

test('Blu-ray full-length playlists retain a closely matching reported size', () => {
  const reportedSize = 28_672_450_560;
  const result = calculateBluRayPlaylistSize(
    6538.528,
    [
      { path: '/disc/00059.m2ts', size: 28_655_579_136, duration: 6526.56 },
      { path: '/disc/00003.m2ts', size: 16_871_424, duration: 11.968 }
    ],
    reportedSize
  );

  assert.deepEqual(result, { sizeBytes: reportedSize, estimated: false });
});

test('Disc Ripper labels the longest valid Blu-ray playlist as a main feature candidate', () => {
  const scanner = fs.readFileSync('modules/discScanner.js', 'utf8');
  const panel = fs.readFileSync('public/ui/discRipperPanel.js', 'utf8');

  assert.ok(scanner.includes('titles[0].isMainFeatureCandidate = true'));
  assert.ok(panel.includes("disc.title.mainFeatureCandidate"));
  assert.ok(panel.includes("disc.title.estimatedSizeLabel"));
});
