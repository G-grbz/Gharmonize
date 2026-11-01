import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('current release versions agree and the public policy discloses unsigned Windows artifacts', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const tag = `v${pkg.version}`;
  const notes = fs.readFileSync('CODE_SIGNING_POLICY.md', 'utf8');
  assert.ok(notes.includes(tag));
  for (const text of [
    'do not carry a trusted Authenticode signature',
    'Self-signed test certificates are never used for public releases',
    'NSIS installer', 'standalone portable executable', 'portable-folder ZIP',
    'do not provide Windows Authenticode trust'
  ]) assert.ok(notes.includes(text), text);
  for (const file of ['README.md', 'SECURITY.md', 'CODE_SIGNING_POLICY.md']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(tag));
    assert.ok(source.includes('trusted Authenticode signature'));
  }
});

test('public documentation makes no signing-provider claims while Windows artifacts remain unsigned', () => {
  const files = ['README.md', 'SECURITY.md', 'CODE_SIGNING_POLICY.md', 'PRIVACY.md', '.github/workflows/release.yml',
  ];
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /signpath/i, file);
  }
});

test('automatic release publishing generates notes, includes the signing notice and keeps test signing separate', () => {
  const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  assert.ok(release.includes('--generate-notes'));
  assert.ok(release.includes('RELEASE_NOTES="$SIGNING_NOTICE"'));
  assert.ok(release.includes('Windows downloads do not carry a trusted Authenticode signature'));
  assert.ok(!release.includes('docs/releases/'));
  assert.ok(release.includes('--notes "$RELEASE_NOTES"'));
  assert.ok(release.includes('--verify-tag'));
  assert.ok(release.includes('refusing to overwrite published assets'));
  assert.ok(!release.includes('signing-policy-slug: test-signing'));
  const signingTest = fs.readFileSync('.github/workflows/signpath-test.yml', 'utf8');
  assert.ok(signingTest.includes('workflow_dispatch:'));
  assert.ok(!signingTest.includes('gh release create'));
});

test('local security investigations and release drafts are excluded from Git and Docker contexts', () => {
  const ignored = fs.readFileSync('.gitignore', 'utf8').split(/\r?\n/);
  const dockerIgnored = fs.readFileSync('.dockerignore', 'utf8').split(/\r?\n/);
  for (const folder of ['docs/security/', 'docs/releases/']) {
    assert.ok(ignored.includes(`/${folder}`), folder);
    assert.ok(dockerIgnored.includes(folder), folder);
  }
});
