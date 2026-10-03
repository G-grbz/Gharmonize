import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function uiClass(file, name, extra = {}) {
  const source = fs.readFileSync(new URL(`../public/ui/${file}.js`, import.meta.url), 'utf8')
    .replace(/^import\s[\s\S]*?;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(`${source}\nglobalThis.TestClass = ${name};`, context);
  return context.TestClass;
}

test('Classic title measures before writing, batches resize and never remeasures on scroll', async () => {
  const frames = new Map();
  const listeners = new Map();
  let frameId = 0;
  let reads = 0;
  let writes = 0;
  let observerCallback;
  let height = 40;
  let layoutWritten = false;
  const style = new Proxy({}, { set(target, key, value) { writes++; layoutWritten = true; target[key] = value; return true; } });
  const title = { style, get offsetHeight() { assert.equal(layoutWritten, false, 'Read height before writing styles'); reads++; return height; } };
  const container = { getBoundingClientRect() { reads++; return { width: 1000, top: 20, left: 5 }; } };
  const card = { getBoundingClientRect() { reads++; return { width: 300, top: 100, left: 20 }; } };
  const setup = uiClass('ClassicLayout', 'setupTitlePositioning', {
    document: { querySelector(selector) {
      return { '.title-section': title, '.container': container, '.card-grid .card:first-child': card }[selector];
    }, fonts: { ready: Promise.resolve() } },
    window: { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    ResizeObserver: class { constructor(fn) { observerCallback = fn; } observe() {} disconnect() {} }
  });
  const cleanup = setup();
  await Promise.resolve();
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    layoutWritten = false;
    pending.forEach((fn) => fn());
  };
  flush();
  assert.equal(style.left, '15px');
  assert.equal(style.top, '32px');
  assert.equal(writes, 3);
  for (let i = 0; i < 100; i++) listeners.get('scroll')?.();
  assert.equal(reads, 3);
  for (let i = 0; i < 100; i++) { listeners.get('resize')(); observerCallback(); }
  assert.equal(frames.size, 1);
  flush();
  assert.equal(reads, 6);
  assert.equal(writes, 3, 'Unchanged coordinates must not trigger layout writes');
  height = 60;
  observerCallback();
  flush();
  assert.equal(style.top, '12px');
  cleanup();
  observerCallback();
  assert.equal(frames.size, 0);
});

function panelFixture() {
  const writes = [];
  let hidden = 'true';
  const dom = { body: { style: {} }, getElementById() { return null; } };
  const Panel = uiClass('JobsPanelManager', 'JobsPanelManager', {
    document: dom, window: {}, requestAnimationFrame() {},
    localStorage: { setItem(...args) { writes.push(args); } }
  });
  const panel = new Panel();
  panel.panel = { getAttribute() { return hidden; }, setAttribute(_, value) { hidden = value; }, removeAttribute() {} };
  panel.filter = 'access';
  let renders = 0;
  let bells = 0;
  let checks = 0;
  panel.list = { scrollTop: 0 };
  panel.updateJobsBell = () => { bells++; };
  panel.renderAccessRequests = () => { renders++; };
  panel.cleanupServerItems = async (items) => { checks++; return items; };
  panel.reconcileLostJobs = async () => [];
  panel.mergeItems = (_, incoming) => incoming;
  return { panel, writes, counts: () => ({ renders, bells, checks }) };
}

test('Closed Classic job panel retains updates without rebuilding hidden content', async () => {
  const { panel, writes, counts } = panelFixture();
  await panel.receiveServerItems([{ id: 'a', status: 'downloading', progress: 10 }]);
  assert.equal(panel.state.items[0].progress, 10);
  assert.deepEqual(counts(), { renders: 0, bells: 1, checks: 1 });
  assert.equal(writes.length, 1);
  for (let i = 0; i < 100; i++) await panel.receiveServerItems([{ id: 'a', status: 'downloading', progress: 10 }]);
  assert.deepEqual(counts(), { renders: 0, bells: 1, checks: 1 });
  assert.equal(writes.length, 1);
  panel.open();
  assert.equal(counts().renders, 1);
  await panel.receiveServerItems([{ id: 'a', status: 'downloading', progress: 20 }]);
  assert.equal(counts().renders, 2);
  assert.equal(panel.state.items[0].progress, 20);
});

test('Unchanged Classic jobs still periodically recheck deleted output files', async () => {
  const { panel, counts } = panelFixture();
  const incoming = [{ id: 'a', status: 'completed' }];
  await panel.receiveServerItems(incoming);
  panel.lastServerCheckAt -= 16000;
  panel.cleanupServerItems = async () => [];
  await panel.receiveServerItems(incoming);
  assert.equal(panel.state.items.length, 0);
  assert.equal(counts().renders, 0);
});

test('Classic serializes output checks so late snapshots cannot replace newer progress', async () => {
  const { panel } = panelFixture();
  const first = Promise.withResolvers();
  panel.cleanupServerItems = async (items) => {
    if (items[0].progress === 10) await first.promise;
    return items;
  };
  const older = panel.receiveServerItems([{ id: 'a', status: 'downloading', progress: 10 }]);
  const newer = panel.receiveServerItems([{ id: 'a', status: 'downloading', progress: 20 }]);
  first.resolve();
  await Promise.all([older, newer]);
  assert.equal(panel.state.items[0].progress, 20);
});

test('In-place output pruning still updates the saved Classic job history', async () => {
  const { panel, writes } = panelFixture();
  panel.state.items = [{ id: 'a', status: 'completed', zipPath: '/download/archive.zip' }];
  panel.reconcileLostJobs = async (existing) => {
    existing[0].zipPath = null;
    return existing;
  };
  panel.mergeItems = (existing) => existing;
  await panel.receiveServerItems([]);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0][1]).items[0].zipPath, null);
});

test('Classic ignores duplicate per-job SSE heartbeats but renders terminal state', () => {
  const streams = [];
  const events = [];
  const Manager = uiClass('JobManager', 'JobManager', {
    window: { addEventListener() {} },
    document: { readyState: 'loading', addEventListener() {}, dispatchEvent(event) { events.push(event.type); } },
    CustomEvent: class { constructor(type) { this.type = type; } },
    EventSource: class { constructor() { streams.push(this); } close() { this.closed = true; } }
  });
  const manager = new Manager({});
  let renders = 0;
  manager.saveSessionState = () => {};
  manager.updateJobUI = () => { renders++; };
  manager.trackJob('a');
  const emit = (status) => streams[0].onmessage({ data: JSON.stringify({ id: 'a', status, progress: 10 }) });
  emit('downloading');
  for (let i = 0; i < 100; i++) emit('downloading');
  assert.equal(renders, 1);
  emit('completed');
  assert.equal(renders, 2);
  assert.equal(streams[0].closed, true);
  assert.deepEqual(events, ['job:first-update', 'job:terminal']);
});
