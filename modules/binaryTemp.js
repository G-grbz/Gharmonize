import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MEI_NAME = /^_MEI[A-Za-z0-9_-]{6,64}$/;
const SESSION_NAME = /^gharmonize-runtime-[0-9]+-[a-f0-9]{16}$/;
const OWNER_FILE = ".gharmonize-owner.json";
const STALE_AGE_MS = 60 * 60 * 1000;
const managers = new Map();

function pidNamespace() {
  try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return ""; }
}

function groupGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

function within(parent, target) {
  return target === parent || target.startsWith(parent + path.sep);
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Fail closed: unreadable same-user processes may still have loaded _MEI files.
// Other users are excluded only after checking the kernel-provided UID.
async function activeTempPaths(root, procRoot) {
  const active = new Set();
  for (const entry of await fs.promises.readdir(procRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const base = path.join(procRoot, entry.name);
    try {
      const stat = await fs.promises.stat(base);
      if (stat.uid !== process.getuid()) continue;
      const env = await fs.promises.readFile(path.join(base, "environ"), "utf8");
      for (const variable of env.split("\0")) {
        const index = variable.indexOf("=");
        const name = variable.slice(0, index);
        if (!["TMPDIR", "TEMP", "TMP", "_PYI_APPLICATION_HOME_DIR", "PYINSTALLER_TEMP"].includes(name)) continue;
        const value = variable.slice(index + 1);
        if (path.isAbsolute(value) && within(root, path.resolve(value))) active.add(path.resolve(value));
      }
      const maps = await fs.promises.readFile(path.join(base, "maps"), "utf8");
      for (const line of maps.split("\n")) {
        const index = line.indexOf(root + path.sep);
        if (index >= 0) active.add(line.slice(index).replace(/ \(deleted\)$/, ""));
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      throw error;
    }
  }
  return active;
}

export async function cleanupStaleBinaryTemp(root, {
  now = Date.now(), minAgeMs = STALE_AGE_MS, procRoot = "/proc",
  platform = process.platform, currentSession = "", leasedOnly = false,
  // A container cannot inspect host/sibling PID namespaces sharing a volume.
  docker = fs.existsSync("/.dockerenv")
} = {}) {
  const result = { removed: [], skipped: 0, unavailable: false };
  // No /proc-equivalent proof is available here on Windows/macOS. Never guess
  // that an old extraction is inactive there, or across Docker namespaces.
  if (platform !== "linux") return { ...result, unavailable: true };
  try {
    root = path.resolve(root);
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid()
      || (rootStat.mode & 0o077) !== 0 || await fs.promises.realpath(root) !== root) {
      return { ...result, unavailable: true };
    }
    let active = null;
    if (docker && !leasedOnly) result.unavailable = true;
    if (!docker && !leasedOnly) {
      try { active = await activeTempPaths(root, procRoot); }
      catch { result.unavailable = true; }
    }
    const inUse = (target) => active && [...active].some((item) => within(target, item) || within(item, target));
    const dirs = await fs.promises.readdir(root, { withFileTypes: true });
    const containers = active ? [root] : [];
    for (const dir of dirs) {
      if (!dir.isDirectory() || !SESSION_NAME.test(dir.name)) continue;
      const session = path.join(root, dir.name);
      if (inUse(session)) { result.skipped++; continue; }
      try {
        const ownerPath = path.join(session, OWNER_FILE);
        const ownerStat = await fs.promises.lstat(ownerPath);
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) continue;
        const owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8"));
        if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
        if (!dir.name.startsWith(`gharmonize-runtime-${owner.pid}-`)) continue;
        const ours = session === currentSession && owner.pid === process.pid;
        if (!ours && alive(owner.pid)) { result.skipped++; continue; }
        // The launcher records pending starts BEFORE spawning and every process
        // group AFTER spawning. Missing/corrupt leases never prove inactivity.
        const proven = owner.namespace && owner.namespace === pidNamespace()
          && owner.pending === 0 && Array.isArray(owner.groups)
          && owner.groups.every(groupGone);
        if (proven || (active && !docker && !leasedOnly)) containers.push(session);
        else result.skipped++;
      } catch { result.skipped++; }
    }
    for (const parent of containers) {
      for (const entry of await fs.promises.readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || !MEI_NAME.test(entry.name)) continue;
        const target = path.join(parent, entry.name);
        const stat = await fs.promises.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || now - stat.mtimeMs < minAgeMs || inUse(target)) { result.skipped++; continue; }
        // Recheck the exact directory identity, and never follow a top-level link.
        const check = await fs.promises.lstat(target);
        if (!check.isDirectory() || check.isSymbolicLink() || check.ino !== stat.ino || check.dev !== stat.dev) continue;
        await fs.promises.rm(target, { recursive: true, force: false });
        result.removed.push(target);
      }
    }
  } catch { result.unavailable = true; }
  return result;
}

export function createBinaryTempManager(root) {
  // Keep the executable-capable configured/cache temp root: /tmp may be noexec.
  const session = path.join(root, `gharmonize-runtime-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(session, { mode: 0o700 });
  const ownerPath = path.join(session, OWNER_FILE);
  const owner = { version: 1, pid: process.pid, namespace: pidNamespace(), pending: 0, groups: [] };
  fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  let trustworthy = true;
  const persist = () => {
    try {
      const fd = fs.openSync(ownerPath, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
      try { fs.writeFileSync(fd, JSON.stringify(owner)); } finally { fs.closeSync(fd); }
      return true;
    } catch { trustworthy = false; return false; }
  };
  let cleaning = Promise.resolve();
  const cleanup = (options = {}) => {
    const next = cleaning.then(() => cleanupStaleBinaryTemp(root, { ...options, currentSession: session })).then((result) => {
      if (result.removed.length) console.info(`[binaries] Removed ${result.removed.length} inactive PyInstaller temp directories`);
      return result;
    });
    cleaning = next.catch(() => {});
    return next;
  };
  const prepare = () => {
    owner.pending++;
    if (!persist()) {
      owner.pending--;
      throw new Error("Cannot safely record the yt-dlp temporary process lease");
    }
    return {
      attach(child) {
        if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
          // spawn failures have no child PID and therefore no orphan worker.
          child.once("close", () => { owner.pending--; persist(); });
          return;
        }
        if (!child.gharmonizeDetached) {
          // Keep a pending lease when a spawned process cannot be tracked safely.
          return;
        }
        owner.groups.push(child.pid); owner.pending--; persist();
        child.once("close", () => {
          // A PyInstaller worker may outlive the bootloader: inspect the group,
          // not just child.exitCode. Retain any still-live/unknown group lease.
          owner.groups = owner.groups.filter((pid) => !groupGone(pid)); persist();
          if (trustworthy && owner.pending === 0 && owner.groups.length === 0) {
            void cleanup({ minAgeMs: 0, leasedOnly: true });
          }
        });
      },
      failed() { owner.pending--; persist(); }
    };
  };
  managers.set(session, { prepare });
  void cleanup();
  const timer = setInterval(() => { void cleanup(); }, STALE_AGE_MS);
  timer.unref?.();
  return { directory: session, cleanup, close: () => { clearInterval(timer); managers.delete(session); } };
}

export function prepareBinaryTempProcess(env) {
  return managers.get(env?.TMPDIR)?.prepare();
}
