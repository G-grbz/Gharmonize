import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { terminateProcess, PROCESS_TERMINATION_GRACE_MS } from "../modules/processTermination.js";
import { execFileSafe } from "../modules/safeProcess.js";
import { createBinaryTempManager } from "../modules/binaryTemp.js";

function fake() {
  const child = new EventEmitter(); child.pid = 12345; child.exitCode = null; child.signalCode = null;
  child.signals = []; child.kill = (signal) => { child.signals.push(signal); child.killed = true; return true; };
  return child;
}

test("termination gives five seconds by default and repeated cancellation does not escalate early", async () => {
  assert.equal(PROCESS_TERMINATION_GRACE_MS, 5000);
  const child = fake();
  terminateProcess(child, { graceMs: 30, platform: "linux" });
  terminateProcess(child, { graceMs: 1, platform: "linux" });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await delay(60); assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.emit("close");
});

test("exit cancels delayed force-kill, including repeated calls after the PID has gone", async () => {
  const child = fake();
  terminateProcess(child, { graceMs: 20, platform: "linux" }); child.emit("exit");
  assert.equal(terminateProcess(child), false);
  await delay(40); assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("only explicitly detached children are signalled as a POSIX process group", () => {
  const child = fake(); child.gharmonizeDetached = true;
  const calls = [];
  terminateProcess(child, { platform: "linux", kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[-12345, "SIGTERM"]]); assert.deepEqual(child.signals, []);
  child.emit("exit");
  assert.equal(terminateProcess({ pid: -1 }), false);
  assert.equal(terminateProcess({ pid: 0 }), false);
  assert.equal(terminateProcess({ pid: 1, exitCode: 0 }), false);
});

test("Windows tree termination tries without force, then /F only after the grace period", async () => {
  const child = fake(); const calls = [];
  terminateProcess(child, { platform: "win32", graceMs: 20, taskkill: (...args) => calls.push(args.slice(0, 2)) });
  assert.deepEqual(calls, [["taskkill", ["/pid", "12345", "/T"]]]);
  await delay(40);
  assert.deepEqual(calls[1], ["taskkill", ["/pid", "12345", "/T", "/F"]]);
  child.emit("exit");
});

test("a real stubborn process is force-killed after grace, not left running", { skip: process.platform === "win32" }, async (t) => {
  const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);']);
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  terminateProcess(child, { graceMs: 50 });
  assert.equal((await closed).signal, "SIGKILL");
});

test("real execFileSafe yt-dlp timeout allows an extraction to clean up and still rejects as timeout", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-termination-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "yt-dlp");
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nconst dir = path.join(process.env.TMPDIR, '_MEIfake12');\nfs.mkdirSync(dir);\nprocess.on('SIGTERM', () => { fs.rmSync(dir, {recursive:true}); process.exit(0); });\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const result = await new Promise((resolve) => execFileSafe(executable, [], {
    env: { TMPDIR: root }, timeout: 500, detached: true
  }, (error, stdout) => resolve({ error, stdout })));
  assert.equal(result.error.code, "ETIMEDOUT"); assert.match(result.stdout, /ready/);
  assert.equal(fs.existsSync(path.join(root, "_MEIfake12")), false);
});

test("yt-dlp metadata, download watchdogs and cancellation share graceful termination", () => {
  for (const name of ["yt", "sp", "store"]) {
    const source = fs.readFileSync(new URL(`../modules/${name}.js`, import.meta.url), "utf8");
    assert.ok(source.includes("terminateProcess("), name);
    assert.equal(/\.kill\(["']SIGKILL["']\)/.test(source), false, name);
  }
});

test("managed runtime retains active extractions and collects remnants after a real forced group exit", { skip: process.platform !== "linux" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-managed-mei-test-"));
  const manager = createBinaryTempManager(root);
  t.after(() => { manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const executable = path.join(root, "yt-dlp");
  fs.writeFileSync(executable, `#!${process.execPath}\nimport fs from 'node:fs';\nimport path from 'node:path';\nfs.mkdirSync(path.join(process.env.TMPDIR, '_MEIfake12'));\nprocess.on('SIGTERM', () => {});\nconsole.log('ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  let child;
  const closed = new Promise((resolve) => {
    child = execFileSafe(executable, [], { env: { TMPDIR: manager.directory } }, (error) => resolve(error));
  });
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  const target = path.join(manager.directory, "_MEIfake12");
  await manager.cleanup({ minAgeMs: 0, leasedOnly: true }); assert.ok(fs.existsSync(target));
  terminateProcess(child, { graceMs: 40 });
  assert.equal((await closed).signal, "SIGKILL");
  await manager.cleanup({ minAgeMs: 0, leasedOnly: true });
  assert.equal(fs.existsSync(target), false);
});

test("buffered yt-dlp execution preserves JSON, buffers, promisify errors and maxBuffer protection", { skip: process.platform === "win32" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-buffered-ytdlp-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "yt-dlp");
  fs.writeFileSync(executable, `#!${process.execPath}\nconst mode=process.argv[2];\nif(mode==='fail'){console.error('stderr detail');process.exit(7);}\nconsole.log(mode==='large'?'x'.repeat(1024):JSON.stringify({title:'Unicode şarkı',items:[1,2]}));\n`, { mode: 0o700 });
  const run = promisify(execFileSafe);
  const { stdout } = await run(executable, [], {});
  assert.deepEqual(JSON.parse(stdout), { title: "Unicode şarkı", items: [1, 2] });
  assert.ok(Buffer.isBuffer((await run(executable, [], { encoding: null })).stdout));
  await assert.rejects(run(executable, ["fail"], {}), (error) => error.code === 7 && /stderr detail/.test(error.stderr));
  await assert.rejects(run(executable, ["large"], { maxBuffer: 16 }), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  await assert.rejects(run(path.join(root, "missing", "yt-dlp"), [], { env: { PATH: "" } }), { code: "ENOENT" });
});
