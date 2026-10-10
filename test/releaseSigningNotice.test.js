import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('current release versions agree and release notes disclose unsigned Windows artifacts', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const tag = `v${pkg.version}`;
  const notes = fs.readFileSync(`docs/releases/${tag}.md`, 'utf8');
  assert.ok(notes.includes(tag));
  for (const text of [
    'do not carry a trusted Authenticode signature',
    'Self-signed test certificates are not used',
    'Setup installer', 'Portable EXE', 'Portable Folder ZIP',
    'not** a Windows Authenticode signature'
  ]) assert.ok(notes.includes(text), text);
  for (const file of ['README.md', 'CODE_SIGNING_POLICY.md']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(tag));
    assert.ok(source.includes('trusted Authenticode signature'));
  }
});

test('automatic release publishing includes version-specific notes and keeps test signing separate', () => {
  const release = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  assert.ok(release.includes('VERSION_NOTES_FILE="docs/releases/${GITHUB_REF_NAME}.md"'));
  assert.ok(release.includes('--notes "$RELEASE_NOTES"'));
  assert.ok(release.includes('--verify-tag'));
  assert.ok(release.includes('refusing to overwrite published assets'));
  assert.ok(!release.includes('signing-policy-slug: test-signing'));
  const signingTest = fs.readFileSync('.github/workflows/signpath-test.yml', 'utf8');
  assert.ok(signingTest.includes('workflow_dispatch:'));
  assert.ok(!signingTest.includes('gh release create'));
});
