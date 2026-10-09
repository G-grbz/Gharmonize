import { execFile } from "node:child_process";

export const PROCESS_TERMINATION_GRACE_MS = 5000;
const terminating = new WeakMap();
const finished = new WeakSet();

// child.killed only means a signal was sent, not that the process has exited.
// Cancel escalation on exit so a recycled PID cannot be killed later.
export function terminateProcess(child, {
  graceMs = PROCESS_TERMINATION_GRACE_MS,
  platform = process.platform,
  group = child?.gharmonizeDetached === true,
  kill = process.kill.bind(process),
  taskkill = execFile
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || finished.has(child)
    || child.exitCode != null || child.signalCode != null) return false;
  if (terminating.has(child)) return true;

  let timer;
  let exited = false;
  const cleanup = () => {
    exited = true;
    clearTimeout(timer);
    finished.add(child);
    terminating.delete(child);
    child.removeListener?.("exit", cleanup);
    child.removeListener?.("close", cleanup);
  };
  const signal = (force) => {
    if (exited) return false;
    if (platform === "win32") {
      try {
        taskkill("taskkill", ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])],
          { windowsHide: true }, () => {});
        return true;
      } catch {}
    }
    const name = force ? "SIGKILL" : "SIGTERM";
    if (platform !== "win32" && group) {
      try { kill(-pid, name); return true; } catch {}
    }
    try { return !!child.kill?.(name); } catch { return false; }
  };
  terminating.set(child, true);
  child.once?.("exit", cleanup);
  child.once?.("close", cleanup);
  const sent = signal(false);
  if (!exited) {
    timer = setTimeout(() => signal(true), Math.max(1, Number(graceMs) || PROCESS_TERMINATION_GRACE_MS));
    timer.unref?.();
  }
  return sent;
}
