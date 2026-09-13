import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MusicUrlQueueManager } from '../public/ui/MusicUrlQueueManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

test('single primary action follows the actually visible text pane', async () => {
  const manager = new MusicUrlQueueManager({});
  let textCalls = 0;
  let urlCalls = 0;
  manager.startTextQueue = async () => { textCalls += 1; return 'text'; };
  manager.startQueue = async () => { urlCalls += 1; return 'url'; };
  manager.modalEl = {
    querySelector(selector) {
      if (selector !== '[data-music-queue-pane="text"]') return null;
      return { classList: { contains: (name) => name === 'is-active' } };
    }
  };

  const result = await manager.handlePrimaryAction();
  assert.equal(result, 'text');
  assert.equal(textCalls, 1);
  assert.equal(urlCalls, 0);
  assert.equal(manager.activeTab, 'text');
});

test('single primary action falls back to URL queue when text pane is not active', async () => {
  const manager = new MusicUrlQueueManager({});
  let textCalls = 0;
  let urlCalls = 0;
  manager.startTextQueue = async () => { textCalls += 1; return 'text'; };
  manager.startQueue = async () => { urlCalls += 1; return 'url'; };
  manager.modalEl = {
    querySelector() {
      return { classList: { contains: () => false } };
    }
  };

  const result = await manager.handlePrimaryAction();
  assert.equal(result, 'url');
  assert.equal(textCalls, 0);
  assert.equal(urlCalls, 1);
  assert.equal(manager.activeTab, 'urls');
});

test('bulk music lists use a shrinkable scroll viewport in both UIs', () => {
  const classic = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
  const ytlive = fs.readFileSync(path.join(root, 'public/ytlive.css'), 'utf8');

  const classicBlock = classic.match(/\.music-text-import-list\s*\{[^}]*\}/)?.[0] || '';
  const ytliveBlock = ytlive.match(/\.ytlive-music-text-list\s*\{[^}]*\}/)?.[0] || '';

  assert.match(classicBlock, /flex:\s*1\s+1\s+0/);
  assert.match(classicBlock, /min-height:\s*0/);
  assert.match(ytliveBlock, /flex:\s*1\s+1\s+0/);
  assert.match(ytliveBlock, /min-height:\s*0/);
});

test('classic bulk import has only the shared primary start button', () => {
  const source = fs.readFileSync(path.join(root, 'public/ui/MusicUrlQueueManager.js'), 'utf8');
  assert.equal((source.match(/id="musicUrlQueueStart"/g) || []).length, 1);
  assert.equal((source.match(/id="musicTextImportStart"/g) || []).length, 0);
  assert.match(source, /void this\.handlePrimaryAction\(\)/);
});


test('Classic primary action is isolated to the active tab', async () => {
  const manager = new MusicUrlQueueManager({});
  manager.items = [{ id: 1, url: 'https://open.spotify.com/track/abc', status: 'pending' }];
  manager.textItems = [{ id: 1, artist: 'A', title: 'One', query: 'A - One', status: 'pending' }];
  const beforeUrls = structuredClone(manager.items);
  let urlCalls = 0;
  manager.startQueue = async () => { urlCalls += 1; };
  manager.startTextQueue = async () => 'text-only';
  manager.modalEl = {
    querySelector(selector) {
      if (selector === '[data-music-queue-pane="text"]') {
        return { classList: { contains: (name) => name === 'is-active' } };
      }
      return null;
    }
  };

  const result = await manager.handlePrimaryAction();
  assert.equal(result, 'text-only');
  assert.equal(urlCalls, 0);
  assert.deepEqual(manager.items, beforeUrls);
});

test('Classic and YTLive expose the shared text auto-remove control', () => {
  const classic = fs.readFileSync(path.join(root, 'public/ui/MusicUrlQueueManager.js'), 'utf8');
  const ytlive = fs.readFileSync(path.join(root, 'public/ui/YTLiveMusicApp.js'), 'utf8');
  assert.match(classic, /musicQueue\.textAutoRemove/);
  assert.match(classic, /textAutoRemoveTerminal/);
  assert.match(ytlive, /id="ytliveMusicTextAutoRemove"/);
  assert.match(ytlive, /musicQueue\.textAutoRemove/);
});


test('Classic does not reconstruct an expired completed progress banner', () => {
  const manager = new MusicUrlQueueManager({});
  const progress = manager.progressFromTextOperation({
    id: 'done-old',
    phase: 'done',
    matched: 1,
    failed: 0,
    updatedAt: Date.now() - 10000
  });
  assert.equal(progress, null);
});

test('both UIs schedule completed progress for automatic visual cleanup', () => {
  const classic = fs.readFileSync(path.join(root, 'public/ui/MusicUrlQueueManager.js'), 'utf8');
  const ytlive = fs.readFileSync(path.join(root, 'public/ui/YTLiveMusicApp.js'), 'utf8');
  assert.match(classic, /scheduleTextProgressHide\(state\)/);
  assert.match(classic, /shouldShowMusicTextOperationProgress\(operation\)/);
  assert.match(ytlive, /scheduleMusicTextProgressHide\(state\)/);
  assert.match(ytlive, /shouldShowMusicTextOperationProgress\(operation\)/);
});
