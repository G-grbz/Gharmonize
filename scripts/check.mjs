import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['app.js','bootstrap.mjs','config.js','electron','modules','routes','scripts','public/ui','public/i18n.js'];
const files = [];
function walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isFile()) { if (/\.(?:js|mjs|cjs)$/.test(p)) files.push(p); return; }
  for (const name of fs.readdirSync(p)) {
    if (['node_modules','dist','.git'].includes(name)) continue;
    walk(path.join(p,name));
  }
}
roots.forEach(walk);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`Syntax check failed: ${file}\n${result.stderr || result.stdout}`);
  }
}
if (failed) process.exit(1);
console.log(`Syntax check passed (${files.length} files).`);
