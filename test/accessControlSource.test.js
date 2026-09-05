import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('application access gate is server-side and temporary authorization stays non-admin', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  const settings = fs.readFileSync('modules/settings.js', 'utf8');
  const client = fs.readFileSync('public/ui/AccessManager.js', 'utf8');
  const jobsPanel = fs.readFileSync('public/ui/JobsPanelManager.js', 'utf8');
  const ytliveInbox = fs.readFileSync('public/ui/AccessInboxManager.js', 'utf8');
  const ytliveHtml = fs.readFileSync('public/ytlive.html', 'utf8');

  assert.ok(app.includes('app.use(appAccessMiddleware)'));
  assert.ok(app.indexOf('app.use(express.static(PUBLIC_DIR))') < app.indexOf('app.use(appAccessMiddleware)'));
  assert.ok(app.indexOf('app.use(appAccessMiddleware)') < app.indexOf('app.use(formatsRoute)'));

  assert.ok(settings.includes("const TEMP_ACCESS_COOKIE = 'gharmonize_temp_access'"));
  assert.ok(settings.includes("role: 'temporary'"));
  assert.ok(settings.includes('httpOnly: true'));
  assert.ok(settings.includes("sameSite: 'strict'"));
  assert.ok(settings.includes('ip: hashClientIp(normalizeClientIp(req))'));
  assert.ok(settings.includes('ar: getAccessRevision()'));
  assert.ok(settings.includes('obj.ar !== getAccessRevision()'));
  assert.ok(settings.includes('const temporary = config.tempEnabled ? verifyTemporaryAccess(req) : null'));
  assert.ok(settings.includes("router.post('/access/request', rateLimit(6, 60_000)"));
  assert.ok(settings.includes("crypto.randomBytes(24).toString('base64url')"));
  assert.ok(settings.includes("router.get('/access/requests', authMiddleware"));
  assert.ok(settings.includes("router.post('/access/requests/:id/decision', authMiddleware"));
  assert.ok(settings.includes('ACCESS_REJECTION_COOLDOWN_MS'));
  assert.ok(settings.includes("const ACCESS_REQUEST_CLIENT_COOKIE = 'gharmonize_access_client'"));
  assert.ok(settings.includes('httpOnly: true'));
  assert.ok(settings.includes("code: 'ACCESS_REQUEST_COOLDOWN'"));
  assert.ok(settings.includes("row.status === 'pending' && hashClientIp(row.ip) === ipKey"));
  assert.ok(settings.includes("code: 'ACCESS_REQUEST_IP_PENDING'"));
  assert.ok(settings.includes("code: 'ACCESS_IP_ALREADY_AUTHORIZED'"));
  assert.ok(settings.includes("router.post('/access/grants/:id/revoke', authMiddleware"));
  assert.ok(settings.includes('activeAccessGrants.get(obj.gid)'));
  assert.ok(settings.includes('persistActiveAccessGrants()'));
  assert.equal(settings.includes("req.get('x-forwarded-for')"), false);

  assert.ok(client.includes('sessionStorage.setItem(REQUEST_STORAGE_KEY, body.id)'));
  assert.ok(client.includes("body?.error?.code === 'ACCESS_REQUEST_COOLDOWN'"));
  assert.equal(client.includes('modalManager.showConfirm'), false);

  assert.ok(jobsPanel.includes("document.getElementById('jobsFilterAccess')"));
  assert.ok(jobsPanel.includes("fetch('/api/access/requests'"));
  assert.ok(jobsPanel.includes("data-access-decision"));
  assert.ok(jobsPanel.includes("body: JSON.stringify({ decision })"));
  assert.ok(jobsPanel.includes('activeAccessGrants'));
  assert.ok(jobsPanel.includes('data-access-revoke-id'));
  assert.ok(ytliveHtml.includes('id="ytliveAccessBell"'));
  assert.ok(ytliveHtml.includes('id="ytliveAccessPanel"'));
  assert.ok(ytliveInbox.includes("fetch('/api/access/requests'"));
  assert.ok(ytliveInbox.includes("fetch('/api/access/status'"));
  assert.ok(ytliveInbox.includes("status?.role === 'admin'"));
  assert.ok(ytliveInbox.includes('data-ytlive-access-revoke'));
});


test('loopback reverse proxies are trusted without trusting direct LAN spoofed forwarded headers', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  assert.ok(app.includes("createTrustedProxyPredicate('127.0.0.0/8,::1/128')"));
  assert.ok(app.includes("loopbackPredicate(ip) || (enabled && configuredPredicate(ip))"));
  assert.ok(app.includes("app.set('trust proxy', predicate)"));
});

test('temporary authorization settings are documented and present in both env templates', () => {
  for (const file of ['.env.default', 'env(example)']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('GHARMONIZE_ACCESS_MODE=none'));
    assert.ok(text.includes('GHARMONIZE_TEMP_ACCESS_ENABLED=0'));
    assert.ok(text.includes('GHARMONIZE_TEMP_ACCESS_HOURS=1'));
  }
  assert.ok(fs.readFileSync('docs/CONFIGURATION.md', 'utf8').includes('### Application access modes'));
  assert.ok(fs.readFileSync('SECURITY.md', 'utf8').includes('### Application access boundary'));
});
