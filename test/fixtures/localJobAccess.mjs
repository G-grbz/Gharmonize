import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [root, mode] = process.argv.slice(2);
process.env.DATA_DIR = root;
process.env.LOCAL_INPUT_DIR = path.join(root, 'library');
process.env.ENV_USER_PATH = path.join(root, '.env');
process.env.GHARMONIZE_MASTER_KEY_FILE = path.join(root, '.gharmonize-key');
process.env.GHARMONIZE_ACCESS_MODE = mode;
process.env.GHARMONIZE_TEMP_ACCESS_ENABLED = '1';
process.env.GHARMONIZE_TEMP_ACCESS_HOURS = '1';
process.env.GHARMONIZE_ACCESS_REVISION = 'a'.repeat(32);
process.env.GHARMONIZE_WEB_BINARIES = '0';
process.env.GHARMONIZE_WEB_BINARIES_IN_DOCKER = '0';
fs.mkdirSync(process.env.LOCAL_INPUT_DIR);
fs.writeFileSync(path.join(process.env.LOCAL_INPUT_DIR, 'private.mp3'), 'private fixture media');

const { hashPassword } = await import('../../modules/security.js');
process.env.ADMIN_PASSWORD_HASH = hashPassword('FixturePassword9');
const { default: express } = await import('express');
const { default: settings, appAccessMiddleware, requireLocalJobAuth } = await import('../../modules/settings.js');
const { default: jobsRouter } = await import('../../routes/jobs.js');
const { jobs } = await import('../../modules/store.js');
const app = express();
app.use(express.json());
app.use(appAccessMiddleware);
app.use(jobsRouter);
app.use('/api', settings);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function cookieFrom(response) {
  return response.headers.get('set-cookie').split(';')[0];
}
async function post(endpoint, body, cookie = '', multipart = false) {
  const headers = cookie ? { cookie } : {};
  let payload;
  if (multipart) {
    payload = new FormData();
    for (const [key, value] of Object.entries(body)) {
      payload.append(key, key === 'file' ? new Blob(['uploaded fixture media']) : String(value));
    }
  } else {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(`${base}${endpoint}`, { method: 'POST', headers, body: payload });
}
async function blocked(body, cookie = '', multipart = false) {
  const previousJobs = jobs.size;
  const queued = (globalThis.queuedLocalAccessJobs || []).length;
  const response = await post('/api/jobs', body, cookie, multipart);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
  assert.equal(jobs.size, previousJobs, 'unauthorized requests must not create jobs');
  assert.equal((globalThis.queuedLocalAccessJobs || []).length, queued, 'unauthorized requests must not queue work');
  assert.deepEqual(fs.readdirSync(path.join(root, 'outputs')), []);
}
async function allowed(body, cookie = '', multipart = false, source) {
  const response = await post('/api/jobs', body, cookie, multipart);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.source, source);
  assert.ok(jobs.has(result.id));
  assert.ok(globalThis.queuedLocalAccessJobs.includes(result.id));
}

try {
  // The middleware must verify credentials even for ordinary jobs, clear any
  // unverified request context, and never infer administrator status from input.
  for (const body of [
    undefined, {}, { url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    { localPath: '' }, { localPath: 'private.mp3' },
    { localPath: ['private.mp3'] }, { localPath: { path: 'private.mp3' } }
  ]) {
    let credentialReads = 0;
    let continued = false;
    let denied = false;
    const req = {
      body,
      adminAuth: { role: 'admin' },
      get() { credentialReads += 1; return ''; }
    };
    const res = {
      status(code) { assert.equal(code, 401); denied = true; return this; },
      json(payload) { assert.equal(payload.error.code, 'UNAUTHORIZED'); return this; }
    };
    requireLocalJobAuth(req, res, () => { continued = true; });
    assert.ok(credentialReads > 0, 'every job request must verify administrator credentials');
    assert.equal(req.adminAuth, null, 'unverified administrator context must be cleared');
    assert.equal(denied, Boolean(body?.localPath));
    assert.equal(continued, !denied);
  }

  const login = await post('/api/auth/login', { password: 'FixturePassword9' });
  assert.equal(login.status, 200);
  const admin = cookieFrom(login);
  if (mode === 'none') {
    await blocked({ localPath: 'private.mp3' });
    await blocked({ localPath: 'not-present.mp3' }); // No existence oracle before authorization.
    await blocked({ localPath: 'private.mp3', file: true }, '', true);
    await blocked({ localPath: 'private.mp3', adminAuth: { role: 'admin' }, finalUploadPath: path.join(root, 'uploads', 'missing.mp3') });
    await blocked({ localPath: 'private.mp3' }, 'gharmonize_admin_session=invalid.token');
    await allowed({ url: 'https://www.youtube.com/watch?v=abcdefghijk' }, '', false, 'youtube');
    await allowed({ file: true }, '', true, 'file');
    await allowed({ localPath: 'private.mp3' }, admin, false, 'local');
    assert.equal((await post('/api/jobs', { localPath: '../outside.mp3' }, admin)).status, 400);
    assert.equal((await post('/api/jobs', { localPath: 'not-present.mp3' }, admin)).status, 404);
  } else {
    const anonymous = await post('/api/jobs', { localPath: 'private.mp3' });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).error.code, 'APP_ACCESS_REQUIRED');
    await allowed({ localPath: 'private.mp3' }, admin, false, 'local');
    await allowed({ localPath: 'private.mp3' }, admin, true, 'local');

    // Obtain a real approved temporary session via the production request flow.
    const request = await post('/api/access/request', {});
    assert.equal(request.status, 202);
    const requesterCookie = cookieFrom(request);
    const { id } = await request.json();
    const decision = await post(`/api/access/requests/${id}/decision`, { decision: 'approve' }, admin);
    assert.equal(decision.status, 200);
    const approval = await fetch(`${base}/api/access/request/${id}`, { headers: { cookie: requesterCookie } });
    assert.equal(approval.status, 200);
    const temporary = cookieFrom(approval);
    const access = await (await fetch(`${base}/api/access/status`, { headers: { cookie: temporary } })).json();
    assert.equal(access.authorized, true);
    assert.equal(access.role, 'temporary');

    await blocked({ localPath: 'private.mp3' }, temporary);
    await blocked({ localPath: 'private.mp3' }, temporary, true);
    await blocked({ localPath: 'private.mp3', file: true }, temporary, true);
    await blocked({ localPath: 'not-present.mp3' }, temporary);
    await blocked({ localPath: 'private.mp3', adminAuth: { role: 'admin' } }, temporary);
    await allowed({ url: 'https://www.youtube.com/watch?v=abcdefghijk' }, temporary, false, 'youtube');
    await allowed({ file: true }, temporary, true, 'file');
  }
  assert.equal(fs.readFileSync(path.join(process.env.LOCAL_INPUT_DIR, 'private.mp3'), 'utf8'), 'private fixture media');
  console.log('LOCAL_JOB_ACCESS_OK');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
// The real job store has long-lived maintenance timers; all HTTP connections
// are closed and the stub queue never executes a worker.
process.exit(0);
