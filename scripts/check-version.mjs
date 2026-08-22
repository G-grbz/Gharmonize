import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
const tag = String(process.env.GITHUB_REF_NAME || process.argv[2] || '').trim();
if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package.json version ${version} (expected v${version}).`);
console.log(`Version consistency OK: ${version}${tag ? ` / ${tag}` : ''}`);
