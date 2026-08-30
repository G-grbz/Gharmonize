import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const binaries = fs.readFileSync("modules/binaries.js", "utf8");
const safeProcess = fs.readFileSync("modules/safeProcess.js", "utf8");

test("yt-dlp update staging verifies an allowlisted executable basename", () => {
  assert.ok(binaries.includes('path.join(verifyDir, pickExeName("yt-dlp"))'));
  assert.equal(binaries.includes('const tmpPath = `${finalPath}.download`;'), false);
  assert.ok(safeProcess.includes('case "yt-dlp": return execFile("yt-dlp"'));
});

test("Deno update staging verifies an allowlisted executable basename", () => {
  assert.ok(binaries.includes('path.join(verifyDir, pickExeName("deno"))'));
  assert.equal(binaries.includes('const tmpExecutablePath = `${finalPath}.download`;'), false);
  assert.ok(safeProcess.includes('case "deno": return execFile("deno"'));
});

test("download suffixes remain data/archive staging only, not executable dispatch tokens", () => {
  assert.equal(safeProcess.includes('yt-dlp.download'), false);
  assert.equal(safeProcess.includes('deno.download'), false);
});
