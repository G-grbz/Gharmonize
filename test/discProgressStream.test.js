import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { DiscProgressStream } from '../public/ui/DiscProgressStream.js';

const response = (role = 'admin', status = 200) => ({
  status, ok: status === 200,
  async json() { return { authorized: role !== 'none', role }; }
});
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };

function fixture(t, fetchImpl = async () => response()) {
  const target = new EventTarget();
  const sources = [];
  const requests = [];
  const timers = new Map();
  const messages = [];
  let id = 0;
  class Source {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
  }
  const stream = new DiscProgressStream(data => messages.push(data), {
    eventTarget: target,
    fetchImpl: async (...args) => { requests.push(args); return fetchImpl(...args); },
    EventSourceImpl: Source,
    setTimer: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimer: timer => timers.delete(timer)
  });
  t.after(() => stream.destroy());
  function auth(loggedIn) {
    const event = new Event('gharmonize:auth');
    event.detail = { loggedIn };
    target.dispatchEvent(event);
  }
  async function runRetry() {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay !== 10_000);
    assert.ok(entry, 'one retry must be scheduled');
    timers.delete(entry[0]);
    entry[1].callback();
    await flush();
    return entry[1].delay;
  }
  return { stream, target, sources, requests, timers, messages, auth, runRetry };
}

for (const role of ['none', 'temporary']) {
  test(`Disc progress never requests the protected stream for ${role} users`, async t => {
    const f = fixture(t, async () => response(role));
    await f.stream.start();
    assert.equal(f.sources.length, 0);
    assert.equal(f.requests[0][0], '/api/access/status');
    assert.equal(f.requests[0][1].credentials, 'same-origin');
    assert.equal(f.timers.size, 0, 'non-admins are not polled or retried');
    // A UI/localStorage hint is not proof of administrator authorization.
    f.auth(true);
    await flush();
    assert.equal(f.sources.length, 0);
    assert.equal(f.timers.size, 0);
  });
}

test('admin cookie status starts exactly one stream and dispatches progress', async t => {
  const f = fixture(t);
  await f.stream.start();
  await f.stream.start();
  f.auth(true);
  await flush();
  assert.equal(f.sources.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sources[0].url, '/api/disc/stream');
  f.sources[0].onmessage({ data: JSON.stringify({ type: 'rip_progress', percent: 42 }) });
  assert.deepEqual(f.messages, [{ type: 'rip_progress', percent: 42 }]);
});

test('logout closes progress immediately, clears reconnects and ignores stale events', async t => {
  const f = fixture(t);
  await f.stream.start();
  const old = f.sources[0];
  old.onerror();
  assert.equal(old.closed, true, 'native EventSource retries are disabled');
  assert.equal(f.timers.size, 1);
  f.auth(false);
  assert.equal(f.timers.size, 0);
  old.onmessage({ data: '{"type":"rip_done"}' });
  old.onerror();
  assert.deepEqual(f.messages, []);
  assert.equal(f.timers.size, 0);
});

test('an expired admin session stops after a public status check rather than repeating stream 401s', async t => {
  let admin = true;
  const f = fixture(t, async () => response(admin ? 'admin' : 'none'));
  await f.stream.start();
  admin = false;
  f.sources[0].onerror();
  assert.equal(await f.runRetry(), 1000);
  assert.equal(f.sources.length, 1);
  assert.equal(f.timers.size, 0);
  admin = true;
  f.auth(true);
  await flush();
  assert.equal(f.sources.length, 2, 'a new valid login reconnects without reloading the page');
});

test('temporary network errors reconnect with backoff only after rechecking administrator access', async t => {
  let unavailable = false;
  const f = fixture(t, async () => {
    if (unavailable) throw new Error('network offline');
    return response();
  });
  await f.stream.start();
  unavailable = true;
  f.sources[0].onerror();
  assert.equal(await f.runRetry(), 1000);
  assert.equal(await f.runRetry(), 2000);
  assert.equal(f.sources.length, 1);
  unavailable = false;
  assert.equal(await f.runRetry(), 4000);
  assert.equal(f.sources.length, 2);
  f.sources[1].onopen();
  f.sources[1].onerror();
  assert.equal(await f.runRetry(), 1000);
});

test('logout while an access check is pending aborts it and cannot open a stale stream', async t => {
  let resolveStatus;
  const f = fixture(t, () => new Promise(resolve => { resolveStatus = resolve; }));
  const starting = f.stream.start();
  f.auth(false);
  assert.equal(f.requests[0][1].signal.aborted, true);
  resolveStatus(response());
  await starting;
  assert.equal(f.sources.length, 0);
  assert.equal(f.timers.size, 0);
});

test('page lifecycle and cross-tab logout release the stream and restore it safely', async t => {
  const f = fixture(t);
  await f.stream.start();
  f.target.dispatchEvent(new Event('pagehide'));
  assert.equal(f.sources[0].closed, true);
  f.auth(true);
  await flush();
  assert.equal(f.sources.length, 1);
  f.target.dispatchEvent(new Event('pageshow'));
  await flush();
  assert.equal(f.sources.length, 2);
  const storage = new Event('storage');
  storage.key = 'gharmonize_admin_token';
  storage.newValue = null;
  f.target.dispatchEvent(storage);
  assert.equal(f.sources[1].closed, true);
  f.stream.destroy();
  f.auth(true);
  await flush();
  assert.equal(f.sources.length, 2);
});

test('status 401/403 does not create EventSource or schedule repeated protected requests', async t => {
  for (const status of [401, 403]) {
    const f = fixture(t, async () => response('none', status));
    await f.stream.start();
    assert.equal(f.sources.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('Disc Ripper panel uses the managed progress stream, not unconditional EventSource', () => {
  const source = fs.readFileSync('public/ui/discRipperPanel.js', 'utf8');
  assert.ok(source.includes("import { DiscProgressStream } from './DiscProgressStream.js'"));
  assert.ok(source.includes('new DiscProgressStream(handleProgressUpdate)'));
  assert.equal(source.includes('new EventSource('), false);
});

function serverFixture() {
  const source = fs.readFileSync('routes/disc.js', 'utf8');
  const start = source.indexOf('router.get("/api/disc/stream"');
  const end = source.indexOf('\n// Sends scan progress log', start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let heartbeat;
  const clients = new Set();
  let cleared = 0;
  vm.runInNewContext(source.slice(start, end), {
    router: { get(route, auth, limit, callback) { assert.equal(route, '/api/disc/stream'); handler = callback; } },
    requireAuth() {}, rateLimit() {}, discClients: clients,
    setInterval(callback, delay) { assert.equal(delay, 15_000); heartbeat = callback; return 123; },
    clearInterval(id) { assert.equal(id, 123); cleared += 1; }
  });
  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes = [];
  res.writeHead = (status, headers) => {
    assert.equal(status, 200);
    assert.equal(headers['X-Accel-Buffering'], 'no');
  };
  res.write = data => writes.push(data);
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  handler(req, res);
  return { req, res, clients, writes, tick: () => heartbeat(), cleared: () => cleared };
}

test('idle server SSE sends regular heartbeats and frees its interval/client on disconnect', () => {
  const f = serverFixture();
  assert.equal(f.clients.has(f.res), true);
  f.tick();
  f.tick();
  assert.deepEqual(f.writes, [': ping\n\n', ': ping\n\n', ': ping\n\n']);
  f.res.emit('close');
  assert.equal(f.clients.size, 0);
  assert.equal(f.cleared(), 1);
  f.tick();
  f.res.emit('error', new Error('late socket error'));
  assert.equal(f.writes.length, 3);
  assert.equal(f.cleared(), 1);
});

test('server SSE also releases failed/aborted responses instead of retaining dead clients', () => {
  const aborted = serverFixture();
  aborted.req.emit('aborted');
  assert.equal(aborted.clients.size, 0);
  assert.equal(aborted.cleared(), 1);
  const failed = serverFixture();
  failed.res.write = () => { throw new Error('closed socket'); };
  failed.tick();
  assert.equal(failed.clients.size, 0);
  assert.equal(failed.res.destroyed, true);
  assert.equal(failed.cleared(), 1);
});
