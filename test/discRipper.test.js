import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDominantBluRayStreamCandidate } from '../modules/discRipper.js';

test('Blu-ray rip falls back to an overwhelmingly dominant stream when a tiny clip has another video codec', () => {
  const main = {
    path: '/disc/00059.m2ts',
    size: 28_655_579_136,
    videoCodec: 'AVC/H.264/MPEG-4p10'
  };
  const menu = {
    path: '/disc/00003.m2ts',
    size: 16_871_424,
    videoCodec: 'MPEG-1/2'
  };

  assert.equal(selectDominantBluRayStreamCandidate([main, menu])?.path, main.path);
});

test('Blu-ray rip keeps the playlist when all backing streams use the same video codec', () => {
  const selected = selectDominantBluRayStreamCandidate([
    { path: '/disc/00001.m2ts', size: 9_900, videoCodec: 'AVC/H.264/MPEG-4p10' },
    { path: '/disc/00002.m2ts', size: 100, videoCodec: 'AVC/H.264/MPEG-4p10' }
  ]);

  assert.equal(selected, null);
});

test('Blu-ray rip does not discard a substantial incompatible playlist segment', () => {
  const selected = selectDominantBluRayStreamCandidate([
    { path: '/disc/00001.m2ts', size: 900, videoCodec: 'AVC/H.264/MPEG-4p10' },
    { path: '/disc/00002.m2ts', size: 100, videoCodec: 'MPEG-1/2' }
  ]);

  assert.equal(selected, null);
});
