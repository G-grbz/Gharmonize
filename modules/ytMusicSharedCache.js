import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One server-owned snapshot, never a browser-local cache. Personal feed keys
// contain only session hashes; raw cookies/bootstrap credentials are not stored.
export function createYtMusicSharedCache({ file, now = Date.now, flushDelayMs = 1000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const maps = new Map();
  let saved = null, timer = null, dirty = false;
  // The snapshot is read on first use, not at start-up: while YouTube Music
  // features (YTLive, player discovery) are unused it costs no time or memory.
  const loadSaved = () => {
    if (saved) return saved;
    saved = Object.create(null);
    if (!file) return saved;
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const info = fs.fstatSync(fd);
      if (info.isFile() && info.size <= maxBytes) {
        const snapshot = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (snapshot.version === 1 && snapshot.namespaces && typeof snapshot.namespaces === 'object') {
          for (const [name, entries] of Object.entries(snapshot.namespaces)) saved[name] = entries;
        }
      }
    } catch { /* Missing/corrupt caches are disposable, not startup failures. */ }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
    return saved;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty || !file) return;
    let temporary = '';
    try {
      const namespaces = Object.create(null);
      let remaining = maxBytes - 64;
      // Retain cooldowns and personal checkpoints before disposable query data.
      const priority = (name) => name === 'request-state' ? 0 : name === 'home' ? 1 : 2;
      // Namespaces nobody touched yet keep their saved entries.
      const sources = [...maps].map(([name, cache]) => [name, cache.hydrated ? [...cache] : (saved?.[name] || [])]);
      for (const [name, list] of sources.sort(([a], [b]) => priority(a) - priority(b))) {
        const overhead = Buffer.byteLength(JSON.stringify(name)) + 4;
        if (remaining < overhead) continue;
        remaining -= overhead;
        const entries = [];
        for (const entry of (Array.isArray(list) ? list : []).slice(-128).reverse()) {
          if (!Array.isArray(entry)) continue;
          if (Number(entry[1]?.expiresAt) <= now()) continue;
          const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes > remaining) continue;
          entries.unshift(entry);
          remaining -= bytes;
        }
        namespaces[name] = entries;
      }
      const snapshot = JSON.stringify({ version: 1, namespaces });
      if (Buffer.byteLength(snapshot) > maxBytes) return;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temporary = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      temporary = '';
      dirty = false;
    } catch { /* A read-only data volume must still allow in-memory caching. */ }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  };
  const changed = () => {
    dirty = true;
    if (!file || timer) return;
    timer = setTimeout(flush, flushDelayMs);
    timer.unref?.();
  };
  // Entries are copied in from the snapshot the first time a map is used;
  // the copied part of the snapshot is then released.
  class SharedMap extends Map {
    constructor(name) { super(); this.name = name; this.hydrated = false; }
    hydrate() {
      if (this.hydrated) return this;
      this.hydrated = true;
      const store = loadSaved();
      const entries = Object.hasOwn(store, this.name) && Array.isArray(store[this.name]) ? store[this.name] : [];
      delete store[this.name];
      for (const entry of entries.slice(-128)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Number(entry[1]?.expiresAt) > now()) {
          Map.prototype.set.call(this, entry[0], entry[1]);
        }
      }
      return this;
    }
    get size() { this.hydrate(); return super.size; }
    get(key) { this.hydrate(); return super.get(key); }
    has(key) { this.hydrate(); return super.has(key); }
    set(key, value) { this.hydrate(); super.set(key, value); changed(); return this; }
    delete(key) { this.hydrate(); const removed = super.delete(key); if (removed) changed(); return removed; }
    clear() { this.hydrate(); if (super.size) { super.clear(); changed(); } }
    forEach(fn, thisArg) { this.hydrate(); return super.forEach(fn, thisArg); }
    entries() { this.hydrate(); return super.entries(); }
    keys() { this.hydrate(); return super.keys(); }
    values() { this.hydrate(); return super.values(); }
    [Symbol.iterator]() { this.hydrate(); return super[Symbol.iterator](); }
  }
  return {
    map(name) {
      if (maps.has(name)) return maps.get(name);
      const cache = new SharedMap(name);
      maps.set(name, cache);
      return cache;
    },
    flush,
    close() { flush(); clearTimeout(timer); timer = null; }
  };
}
