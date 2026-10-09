import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { cleanupStaleBinaryTemp, createBinaryTempManager, readBinaryTempOwner } from "../modules/binaryTemp.js";
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-mei-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "binary-tmp");
  const procRoot = path.join(dir, "proc");
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(procRoot);
  const options = { platform: "linux", docker: false, procRoot, now: Date.now(), minAgeMs: 1000 };
  const mei = (name = "_MEIabc123", parent = root, old = true) => {
    const target = path.join(parent, name);
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, "library.so"), "test");
    if (old) fs.utimesSync(target, new Date(0), new Date(0));
    return target;
  };
  const proc = (env = "", maps = "") => {
    const target = path.join(procRoot, "12345"); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "environ"), env);
    fs.writeFileSync(path.join(target, "maps"), maps);
  };
  return { dir, root, options, mei, proc };
}

test("only old, inactive, strictly named PyInstaller directories are collected", async (t) => {
  const { root, options, mei } = fixture(t);
  const old = mei(); const recent = mei("_MEIdef456", root, false);
  const other = mei("downloads"); const malformed = mei("_MEI..");
  const result = await cleanupStaleBinaryTemp(root, options);
  assert.deepEqual(result.removed, [old]);
  assert.ok(fs.existsSync(recent)); assert.ok(fs.existsSync(other)); assert.ok(fs.existsSync(malformed));
});

test("an active legacy yt-dlp temp environment protects the entire shared root", async (t) => {
  const { root, options, mei, proc } = fixture(t);
  const target = mei(); proc(`TMPDIR=${root}\0`);
  assert.equal((await cleanupStaleBinaryTemp(root, options)).removed.length, 0);
  assert.ok(fs.existsSync(target));
});

test("PyInstaller worker environment and loaded library maps both protect an extraction", async (t) => {
  for (const mode of ["env", "maps"]) {
    const { root, options, mei, proc } = fixture(t);
    const target = mei(); const stale = mei("_MEIdef456");
    proc(mode === "env" ? `_PYI_APPLICATION_HOME_DIR=${target}\0` : "",
      mode === "maps" ? `address rw-p 0 0 0 ${target}/library.so\n` : "");
    assert.deepEqual((await cleanupStaleBinaryTemp(root, options)).removed, [stale]);
    assert.ok(fs.existsSync(target));
  }
});

test("cleanup fails closed if same-user process inspection is unavailable", async (t) => {
  const { root, options, mei, proc } = fixture(t);
  const target = mei(); proc();
  fs.rmSync(path.join(options.procRoot, "12345", "environ"));
  fs.mkdirSync(path.join(options.procRoot, "12345", "environ"));
  const result = await cleanupStaleBinaryTemp(root, options);
  assert.equal(result.unavailable, true); assert.ok(fs.existsSync(target));
});

test("symlink roots/entries are not followed, and nested symlinks cannot delete outside files", async (t) => {
  const { root, options, mei, dir } = fixture(t);
  const outside = path.join(dir, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(outside, path.join(root, "_MEIlink12"), "dir");
  const stale = mei(); fs.symlinkSync(outside, path.join(stale, "nested"), "dir");
  fs.utimesSync(stale, new Date(0), new Date(0));
  assert.deepEqual((await cleanupStaleBinaryTemp(root, options)).removed, [stale]);
  assert.ok(fs.existsSync(path.join(outside, "keep")));
  const linkedRoot = path.join(dir, "linked-root"); fs.symlinkSync(root, linkedRoot, "dir");
  assert.equal((await cleanupStaleBinaryTemp(linkedRoot, options)).unavailable, true);
});

test("non-private roots, unsupported process inspection and Docker namespaces are not guessed safe", async (t) => {
  const { root, options, mei } = fixture(t); const target = mei();
  for (const override of [{ platform: "win32" }, { platform: "darwin" }, { docker: true }]) {
    assert.equal((await cleanupStaleBinaryTemp(root, { ...options, ...override })).unavailable, true);
  }
  fs.chmodSync(root, 0o755);
  assert.equal((await cleanupStaleBinaryTemp(root, options)).unavailable, true);
  assert.ok(fs.existsSync(target));
});

test("live application sessions are preserved; dead leases are inspected for orphan workers", async (t) => {
  const { root, options, mei, proc } = fixture(t);
  const make = (pid, suffix) => {
    const session = path.join(root, `gharmonize-runtime-${pid}-${suffix}`); fs.mkdirSync(session, { mode: 0o700 });
    fs.writeFileSync(path.join(session, ".gharmonize-owner.json"), JSON.stringify({ version: 1, pid }));
    return { session, target: mei("_MEIabc123", session) };
  };
  const live = make(process.pid, "1111111111111111");
  const dead = make(1073741823, "2222222222222222");
  const orphan = make(1073741822, "3333333333333333");
  proc(`TMPDIR=${orphan.session}\0`);
  assert.deepEqual((await cleanupStaleBinaryTemp(root, options)).removed, [dead.target]);
  assert.ok(fs.existsSync(live.target)); assert.ok(fs.existsSync(orphan.target));
});

test("current session can reclaim old remnants only when no worker uses them", async (t) => {
  const { root, options, mei, proc } = fixture(t);
  const manager = createBinaryTempManager(root); t.after(() => manager.close());
  await manager.cleanup(); // let the startup inspection finish before adding test data
  // Simulate an older untracked session: it must rely on /proc, not lease proof.
  fs.writeFileSync(path.join(manager.directory, ".gharmonize-owner.json"), JSON.stringify({ version: 1, pid: process.pid }));
  const stale = mei("_MEIabc123", manager.directory);
  const active = mei("_MEIdef456", manager.directory);
  proc(`_PYI_APPLICATION_HOME_DIR=${active}\0`);
  assert.deepEqual((await cleanupStaleBinaryTemp(root, { ...options, currentSession: manager.directory })).removed, []);
  // A child referencing the session protects all of its extraction siblings.
  assert.ok(fs.existsSync(stale)); assert.ok(fs.existsSync(active));
  fs.writeFileSync(path.join(options.procRoot, "12345", "environ"), "");
  const result = await cleanupStaleBinaryTemp(root, { ...options, currentSession: manager.directory });
  assert.equal(result.removed.length, 2);
  assert.equal(fs.statSync(manager.directory).mode & 0o777, 0o700);
});

test("dead complete leases clean up without /proc access; pending and foreign namespace leases do not", async (t) => {
  const { root, options, mei } = fixture(t);
  const ns = fs.readlinkSync("/proc/self/ns/pid");
  const make = (suffix, override = {}) => {
    const session = path.join(root, `gharmonize-runtime-1073741823-${suffix}`); fs.mkdirSync(session, { mode: 0o700 });
    fs.writeFileSync(path.join(session, ".gharmonize-owner.json"), JSON.stringify({
      version: 1, pid: 1073741823, namespace: ns, pending: 0, groups: [1073741822], ...override
    }));
    return mei("_MEIabc123", session);
  };
  const safe = make("1111111111111111"); const pending = make("2222222222222222", { pending: 1 });
  const foreign = make("3333333333333333", { namespace: "pid:[foreign]" });
  const unknown = make("4444444444444444", { groups: [-1] });
  const result = await cleanupStaleBinaryTemp(root, { ...options, docker: true });
  assert.deepEqual(result.removed, [safe]);
  for (const target of [pending, foreign, unknown]) assert.ok(fs.existsSync(target));
});

test("owner reads inspect and read one descriptor even if its pathname is replaced", async (t) => {
  const { dir } = fixture(t);
  const ownerPath = path.join(dir, ".gharmonize-owner.json");
  const outside = path.join(dir, "outside.json");
  const original = { version: 1, pid: process.pid, pending: 1 };
  fs.writeFileSync(ownerPath, JSON.stringify(original));
  fs.writeFileSync(outside, JSON.stringify({ version: 1, pid: 1073741823, pending: 0 }));
  const open = fs.promises.open.bind(fs.promises);
  let closed = 0;
  t.mock.method(fs.promises, "open", async (file, flags) => {
    assert.ok(flags & fs.constants.O_NOFOLLOW);
    assert.ok(flags & fs.constants.O_NONBLOCK);
    const handle = await open(file, flags);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed++; return close(); };
    fs.renameSync(ownerPath, path.join(dir, "original-owner.json"));
    fs.symlinkSync(outside, ownerPath);
    return handle;
  });
  assert.deepEqual(await readBinaryTempOwner(ownerPath), original);
  assert.equal(closed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(outside, "utf8")), { version: 1, pid: 1073741823, pending: 0 });
});

test("replacement by a symlink immediately before open cannot authorize cleanup", async (t) => {
  const { root, options, mei, dir } = fixture(t);
  const session = path.join(root, "gharmonize-runtime-1073741823-1111111111111111");
  fs.mkdirSync(session, { mode: 0o700 });
  const ownerPath = path.join(session, ".gharmonize-owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({ version: 1, pid: process.pid }));
  const outside = path.join(dir, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ version: 1, pid: 1073741823 }));
  const target = mei("_MEIabc123", session);
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, "open", async (file, flags) => {
    if (file === ownerPath) {
      fs.renameSync(ownerPath, path.join(session, "original-owner.json"));
      fs.symlinkSync(outside, ownerPath);
    }
    return open(file, flags);
  });
  const result = await cleanupStaleBinaryTemp(root, options);
  assert.deepEqual(result.removed, []);
  assert.ok(result.skipped > 0);
  assert.ok(fs.existsSync(target)); assert.ok(fs.existsSync(outside));
});

test("invalid owner files close their descriptors and never read oversized payloads", async (t) => {
  const { dir } = fixture(t);
  const open = fs.promises.open.bind(fs.promises);
  let closed = 0, reads = 0;
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args);
    const close = handle.close.bind(handle); const read = handle.read.bind(handle);
    handle.close = async () => { closed++; return close(); };
    handle.read = async (...params) => { reads++; return read(...params); };
    return handle;
  });
  const oversized = path.join(dir, "oversized.json"); fs.writeFileSync(oversized, "x".repeat(4097));
  await assert.rejects(readBinaryTempOwner(oversized), /Invalid binary/);
  assert.equal(reads, 0); assert.equal(closed, 1);
  await assert.rejects(readBinaryTempOwner(dir), /Invalid binary/);
  assert.equal(reads, 0); assert.equal(closed, 2);
  const corrupt = path.join(dir, "corrupt.json"); fs.writeFileSync(corrupt, "{not json");
  await assert.rejects(readBinaryTempOwner(corrupt), SyntaxError);
  assert.equal(closed, 3);
});

test("an owner file growing after fstat is bounded and rejected", async (t) => {
  const { dir } = fixture(t);
  const ownerPath = path.join(dir, ".gharmonize-owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({ version: 1, pid: process.pid }));
  const open = fs.promises.open.bind(fs.promises);
  let closed = 0, largestRead = 0;
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle); const read = handle.read.bind(handle); const close = handle.close.bind(handle);
    let first = true;
    handle.stat = async () => {
      const value = await stat();
      if (first) { first = false; fs.appendFileSync(ownerPath, " ".repeat(8192)); }
      return value;
    };
    handle.read = async (...params) => { largestRead = Math.max(largestRead, params[2]); return read(...params); };
    handle.close = async () => { closed++; return close(); };
    return handle;
  });
  await assert.rejects(readBinaryTempOwner(ownerPath), /changed while reading/);
  assert.equal(largestRead, 4097); assert.equal(closed, 1);
});
