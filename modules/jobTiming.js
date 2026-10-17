// Transition-driven timing: no polling, timers, filesystem writes or media reads.
// Keep detailed rows off the once-per-second SSE payload; fetch them on demand.
const states = new WeakMap();
const MAX_TRACKS = 1000;
const PHASES = new Set(['queued', 'preparing', 'matching', 'downloading', 'youtube_metadata',
  'provider_metadata', 'cover', 'converting', 'lyrics_search', 'lyrics_embed', 'retagging',
  'waiting', 'retrying', 'cached', 'ready', 'completed', 'not_found', 'skipped', 'error', 'canceled', 'interrupted']);
const TERMINAL = new Set(['completed', 'not_found', 'skipped', 'error', 'canceled', 'interrupted']);
const phaseName = value => value === 'mapping' ? 'matching' : PHASES.has(value) ? value : 'preparing';
const timestamp = (value, fallback) => {
  const n = value instanceof Date || typeof value === 'string' ? new Date(value).getTime() : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 250) : '';

function move(row, phase, now) {
  if (row.endedAt || row.phase === phase) return false;
  const at = Math.max(row.phaseStartedAt, now);
  row.stageMs[row.phase] = (row.stageMs[row.phase] || 0) + at - row.phaseStartedAt;
  row.phase = phase;
  row.phaseStartedAt = at;
  if (TERMINAL.has(phase)) row.endedAt = at;
  return true;
}

function copy(row) {
  return { ...row, stageMs: { ...row.stageMs } };
}

function publish(job, state) {
  const counts = {};
  const active = [];
  const queued = [];
  for (const row of state.tracks.values()) {
    counts[row.phase] = (counts[row.phase] || 0) + 1;
    if (!row.endedAt) {
      const target = row.phase === 'queued' || row.phase === 'ready' ? queued : active;
      if (target.length < 24) target.push(copy(row));
    }
  }
  job.timing = { version: 1, ...copy(state.job), trackCount: state.tracks.size,
    counts, tracks: active.concat(queued.slice(0, 24 - active.length)), truncated: state.truncated };
}

export function initializeJobTiming(job, saved = null, now = Date.now()) {
  if (!job || states.has(job)) return;
  const start = timestamp(job.createdAt, now);
  const row = { startedAt: start, endedAt: null, phase: phaseName(job.currentPhase || job.status),
    phaseStartedAt: now, stageMs: {} };
  const state = { job: row, tracks: new Map(), truncated: false };
  states.set(job, state);
  if (saved?.version === 1 && job.status === 'completed') {
    row.startedAt = timestamp(saved.startedAt, start);
    row.endedAt = Math.max(row.startedAt, timestamp(saved.endedAt, timestamp(job.completedAt, now)));
    row.phase = 'completed';
    row.phaseStartedAt = row.endedAt;
    for (const [key, ms] of Object.entries(saved.stageMs || {})) {
      if (PHASES.has(key) && Number.isFinite(ms) && ms >= 0) row.stageMs[key] = ms;
    }
    for (const raw of (Array.isArray(saved.tracks) ? saved.tracks : []).slice(0, MAX_TRACKS)) {
      if (typeof raw?.key !== 'string' || !TERMINAL.has(raw.phase)) continue;
      const startedAt = timestamp(raw.startedAt, row.startedAt);
      const endedAt = Math.max(startedAt, timestamp(raw.endedAt, row.endedAt));
      const stageMs = {};
      for (const [key, ms] of Object.entries(raw.stageMs || {})) {
        if (PHASES.has(key) && Number.isFinite(ms) && ms >= 0) stageMs[key] = ms;
      }
      const key = text(raw.key);
      state.tracks.set(key, { key, title: text(raw.title), artist: text(raw.artist),
        startedAt, endedAt, phase: raw.phase, phaseStartedAt: endedAt, stageMs });
    }
    state.truncated = saved.truncated === true;
  } else if (TERMINAL.has(job.status)) {
    // Legacy history has no measurements. Never invent timings for it.
    states.delete(job);
    return;
  }
  for (const field of ['currentPhase', 'status']) {
    let value = job[field];
    Object.defineProperty(job, field, { enumerable: true, configurable: true,
      get: () => value,
      set: next => {
        value = next;
        if (state.job.endedAt) return;
        const at = Date.now();
        if (field === 'status' && TERMINAL.has(next)) {
          for (const track of state.tracks.values()) {
            // Unfinished rows in a finished batch are not proven successes.
            move(track, next === 'completed' ? (track.phase === 'ready' ? 'completed' : 'interrupted') : next, at);
          }
          move(state.job, next, at);
          publish(job, state);
        } else if (field === 'currentPhase' && !TERMINAL.has(next) && move(state.job, phaseName(next), at)) publish(job, state);
      } });
  }
  publish(job, state);
}

export function setTrackStage(job, key, phase, details = {}, now = Date.now()) {
  if (!job || !PHASES.has(phase) || typeof key !== 'string' || key.length > 250) return;
  initializeJobTiming(job, null, now);
  const state = states.get(job);
  if (!state || state.job.endedAt) return;
  let row = state.tracks.get(key);
  if (!row) {
    if (state.tracks.size >= MAX_TRACKS) {
      if (!state.truncated) { state.truncated = true; publish(job, state); }
      return;
    }
    row = { key, title: text(details.title), artist: text(details.artist || details.uploader),
      startedAt: now, endedAt: null, phase, phaseStartedAt: now, stageMs: {} };
    if (TERMINAL.has(phase)) row.endedAt = now;
    state.tracks.set(key, row);
  } else {
    if (row.endedAt) return;
    const changed = move(row, phase, now);
    const title = text(details.title);
    const artist = text(details.artist || details.uploader);
    const renamed = (title && title !== row.title) || (artist && artist !== row.artist);
    if (title) row.title = title;
    if (artist) row.artist = artist;
    if (!changed && !renamed) return;
  }
  publish(job, state);
}

export function getJobTiming(job, offset = 0, limit = 50) {
  const state = states.get(job);
  if (!state) return null;
  const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset) || 0)) : 0;
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
  return { ...job.timing, serverNow: Date.now(), offset: start, limit: size,
    tracks: [...state.tracks.values()].slice(start, start + size).map(copy) };
}

export function serializeJobTiming(job) {
  const state = states.get(job);
  return state ? { version: 1, ...copy(state.job), truncated: state.truncated,
    tracks: [...state.tracks.values()].map(copy) } : null;
}

// Remove only explicit numeric/audio and vN/video suffixes from UUID job IDs.
export function resolveTimingTrack(jobs, jobId, metadata = {}) {
  const id = String(jobId || '');
  const match = id.match(/^(job_[0-9a-f-]{36})_(v?)(\d+)$/i);
  const job = jobs.get(id) || (match && jobs.get(match[1]));
  const key = match ? `${match[2] ? 'video' : 'track'}:${Number(match[3])}` : 'single';
  return phase => setTrackStage(job, key, phase, metadata);
}
