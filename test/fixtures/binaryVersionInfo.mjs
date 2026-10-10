import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.argv[2];
process.env.GHARMONIZE_WEB_CACHE_DIR = root;
const versions = { ffmpeg: 'n8.1.3-16-ge0a878dd70-20261009', ffprobe: 'N-127259-gb91a82d6dd-20261009' };
for (const [tool, version] of Object.entries(versions)) {
  const executable = path.join(root, tool);
  fs.writeFileSync(executable, `#!${process.execPath}\nconsole.log('${tool} version ${version} Copyright');\n`, { mode: 0o700 });
  process.env[`${tool.toUpperCase()}_BIN`] = executable;
}
for (const tool of ['YTDLP', 'DENO', 'MKVMERGE', 'MKVPROPEDIT']) process.env[`${tool}_BIN`] = path.join(root, 'missing', tool.toLowerCase());
fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify(Object.fromEntries(Object.keys(versions).map((tool) => [tool, { tag: 'latest', path: path.join(root, tool) }]))));
const { getBinariesInfo } = await import('../../modules/binariesInfo.js');
const info = await getBinariesInfo();
for (const [tool, version] of Object.entries(versions)) assert.equal(info[tool].version, version);
console.log('BINARY_VERSION_INFO_OK');
