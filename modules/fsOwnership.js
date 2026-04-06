import fs from "fs";
import path from "path";

const parsedUid = Number(process.env.PUID);
const parsedGid = Number(process.env.PGID);
const currentUid =
  typeof process.getuid === "function" ? Number(process.getuid()) : null;

const ownershipTarget =
  process.platform !== "win32" &&
  Number.isInteger(parsedUid) &&
  parsedUid >= 0 &&
  Number.isInteger(parsedGid) &&
  parsedGid >= 0 &&
  currentUid === 0
    ? { uid: parsedUid, gid: parsedGid }
    : null;

const warnedKeys = new Set();
const pendingJobs = new Map();

function warnOnce(key, message) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

function normalizeTargetPath(targetPath) {
  if (!targetPath) return null;
  return path.resolve(String(targetPath));
}

function canSkipChown(stat) {
  return !stat || typeof stat.isSymbolicLink !== "function" || stat.isSymbolicLink();
}

export function getOwnershipTarget() {
  return ownershipTarget ? { ...ownershipTarget } : null;
}

export async function ensureOwnership(targetPath, { recursive = false } = {}) {
  if (!ownershipTarget) return false;

  const absPath = normalizeTargetPath(targetPath);
  if (!absPath) return false;

  const stack = [absPath];

  while (stack.length) {
    const currentPath = stack.pop();
    let stat;

    try {
      stat = await fs.promises.lstat(currentPath);
    } catch (err) {
      if (err?.code !== "ENOENT") {
        warnOnce(
          `lstat:${currentPath}`,
          `[ownership] Failed to stat ${currentPath}: ${err?.message || err}`
        );
      }
      continue;
    }

    if (canSkipChown(stat)) continue;

    if (
      Number(stat.uid) !== ownershipTarget.uid ||
      Number(stat.gid) !== ownershipTarget.gid
    ) {
      try {
        await fs.promises.chown(
          currentPath,
          ownershipTarget.uid,
          ownershipTarget.gid
        );
      } catch (err) {
        warnOnce(
          `chown:${currentPath}`,
          `[ownership] Failed to chown ${currentPath} -> ${ownershipTarget.uid}:${ownershipTarget.gid}: ${err?.message || err}`
        );
      }
    }

    if (!recursive || !stat.isDirectory()) continue;

    let entries = [];
    try {
      entries = await fs.promises.readdir(currentPath);
    } catch (err) {
      warnOnce(
        `readdir:${currentPath}`,
        `[ownership] Failed to read ${currentPath}: ${err?.message || err}`
      );
      continue;
    }

    for (const entry of entries) {
      stack.push(path.join(currentPath, entry));
    }
  }

  return true;
}

export function queueOwnershipFix(targetPath, { recursive = false } = {}) {
  if (!ownershipTarget) return null;

  const absPath = normalizeTargetPath(targetPath);
  if (!absPath) return null;

  const key = `${absPath}::${recursive ? "recursive" : "single"}`;
  if (pendingJobs.has(key)) return pendingJobs.get(key);

  const job = ensureOwnership(absPath, { recursive })
    .catch((err) => {
      warnOnce(
        `queue:${key}`,
        `[ownership] Failed to adjust ${absPath}: ${err?.message || err}`
      );
    })
    .finally(() => {
      pendingJobs.delete(key);
    });

  pendingJobs.set(key, job);
  return job;
}
