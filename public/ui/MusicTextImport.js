const DASH_SEPARATOR_RE = /\s+[–—-]\s+/;
const COMMENT_SEPARATOR_RE = /\s+—\s+/;
const MATCH_POLL_INTERVAL_MS = 650;

function cleanMarkdown(value = '') {
  return String(value || '')
    .replace(/^\s*(?:[-*•]+\s+|\d{1,5}\s*[.)]\s*)/, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^\s*[`*_~]+|[`*_~]+\s*$/g, '')
    .trim();
}

export function parseMusicTextLine(rawLine = '', index = 0) {
  let line = cleanMarkdown(rawLine);
  if (!line) return null;

  const separator = line.match(DASH_SEPARATOR_RE);
  let artist = '';
  let title = line;

  if (separator && Number.isFinite(separator.index)) {
    artist = line.slice(0, separator.index).trim();
    title = line.slice(separator.index + separator[0].length).trim();

    // Once the artist/title delimiter is consumed, a later spaced em dash is
    // treated as prose commentary (common in copied ChatGPT lists). This also
    // keeps `Artist — Song` valid when the em dash itself is the delimiter.
    const commentSplit = title.split(COMMENT_SEPARATOR_RE);
    if (commentSplit.length > 1) title = commentSplit[0].trim();
  }

  artist = cleanMarkdown(artist);
  title = cleanMarkdown(title);
  if (!title) return null;

  const query = [artist, title].filter(Boolean).join(' - ');
  const key = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();

  return {
    id: `text-${index + 1}`,
    artist,
    title,
    query,
    key,
    raw: String(rawLine || '').trim()
  };
}

export function parseMusicTextList(rawText = '') {
  const seen = new Set();
  const items = [];
  const lines = String(rawText || '').replace(/\r/g, '').split('\n');

  lines.forEach((line, index) => {
    const parsed = parseMusicTextLine(line, index);
    if (!parsed || seen.has(parsed.key)) return;
    seen.add(parsed.key);
    items.push(parsed);
  });

  return items;
}

function toMatchPayloadItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => ({
      id: String(item?.id || `text-${index + 1}`),
      artist: String(item?.artist || '').trim(),
      title: String(item?.title || '').trim(),
      query: String(item?.query || '').trim()
    }))
    .filter((item) => item.title || item.query);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || null;
    throw error;
  }
  return data;
}

export async function startMusicTextMatchOperation(items = [], { concurrency = 3, signal, fetchImpl = globalThis.fetch } = {}) {
  const payloadItems = toMatchPayloadItems(items);
  if (!payloadItems.length) return null;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available');

  const response = await fetchImpl('/api/music/text-match/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: payloadItems,
      concurrency: Math.max(1, Math.min(8, Number(concurrency) || 3))
    }),
    signal
  });
  const data = await parseApiResponse(response);
  return {
    ...data,
    id: String(data?.id || ''),
    itemIds: payloadItems.map((item) => String(item.id))
  };
}

export async function getMusicTextMatchOperation(operationId, { signal, fetchImpl = globalThis.fetch } = {}) {
  const id = String(operationId || '').trim();
  if (!id) return null;
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is not available');
  const response = await fetchImpl(`/api/music/text-match/operations/${encodeURIComponent(id)}`, {
    cache: 'no-store',
    signal
  });
  const data = await parseApiResponse(response);
  return { ...data, id: String(data?.id || id) };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export async function waitForMusicTextMatchOperation(operationId, {
  signal,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = MATCH_POLL_INTERVAL_MS,
  onProgress
} = {}) {
  const id = String(operationId || '').trim();
  if (!id) throw new Error('Music text matching operation id is missing');

  while (true) {
    const operation = await getMusicTextMatchOperation(id, { signal, fetchImpl });
    onProgress?.(operation);
    const status = String(operation?.status || '').toLowerCase();
    if (status === 'completed') {
      return {
        items: (operation.items || []).filter(Boolean),
        matched: Number(operation.matched || 0),
        failed: Number(operation.failed || 0),
        total: Number(operation.total || 0),
        operationId: id,
        operation
      };
    }
    if (status === 'error') throw new Error(operation?.error || 'Music text matching failed');
    await sleep(Math.max(200, Number(pollIntervalMs) || MATCH_POLL_INTERVAL_MS), signal);
  }
}

// Resumable matcher. The matching itself lives on the server, so modal closure
// or navigation between Classic/YTLive does not terminate the batch. The UI can
// persist operationId and resume polling later.
export async function matchMusicTextItems(items = [], {
  concurrency = 3,
  signal,
  operationId = '',
  onOperation,
  onProgress,
  fetchImpl = globalThis.fetch
} = {}) {
  const payloadItems = toMatchPayloadItems(items);
  if (!payloadItems.length && !operationId) return { items: [], matched: 0, failed: 0, total: 0 };

  const itemIds = payloadItems.map((item) => String(item.id));
  let operation = null;
  if (operationId) {
    operation = await getMusicTextMatchOperation(operationId, { signal, fetchImpl });
    operation = { ...operation, itemIds };
  } else {
    operation = await startMusicTextMatchOperation(payloadItems, { concurrency, signal, fetchImpl });
    operation = { ...operation, itemIds: operation?.itemIds?.length ? operation.itemIds : itemIds };
  }
  if (!operation?.id) throw new Error('Music text matching could not be started');
  onOperation?.(operation);
  onProgress?.(operation);

  if (String(operation.status || '').toLowerCase() === 'completed') {
    return {
      items: (operation.items || []).filter(Boolean),
      matched: Number(operation.matched || 0),
      failed: Number(operation.failed || 0),
      total: Number(operation.total || 0),
      operationId: operation.id,
      operation
    };
  }

  return waitForMusicTextMatchOperation(operation.id, {
    signal,
    fetchImpl,
    onProgress: (progress) => onProgress?.({ ...progress, itemIds })
  });
}

export function buildMusicTextJobPayload(matches = [], outputPayload = {}, { title = 'Imported music list' } = {}) {
  const valid = (Array.isArray(matches) ? matches : []).filter((entry) => entry?.match?.id);
  if (!valid.length) return null;

  const frozenEntries = valid.map((entry, index) => ({
    index: index + 1,
    id: entry.match.id,
    title: entry.match.title || entry.title || entry.query || `Track ${index + 1}`,
    uploader: entry.match.uploader || entry.artist || '',
    artist: entry.artist || entry.match.uploader || '',
    webpage_url: entry.match.webpage_url || `https://www.youtube.com/watch?v=${entry.match.id}`,
    thumbnail: entry.match.thumbnail || '',
    thumbnails: entry.match.thumbnail ? [{ url: entry.match.thumbnail }] : [],
    duration: entry.match.duration || null,
    source_query: entry.query || ''
  }));

  return {
    ...outputPayload,
    url: frozenEntries[0].webpage_url,
    isPlaylist: true,
    plTitle: title,
    selectedIndices: 'all',
    selectedIds: frozenEntries.map((entry) => entry.id),
    frozenEntries
  };
}

export const MUSIC_TEXT_QUEUE_STORAGE_KEY = 'gharmonize_music_text_import_v2';
const MUSIC_TEXT_QUEUE_LEGACY_KEYS = [
  'gharmonize_ytlive_music_text_import_v1',
  'gharmonize_music_url_queue_v2',
  'gharmonize_music_url_queue_v1'
];
const MUSIC_TEXT_STATUSES = new Set(['pending', 'running', 'matched', 'queued', 'completed', 'not-found', 'error']);
const MUSIC_TEXT_OPERATION_PHASES = new Set(['matching', 'queueing', 'done', 'error']);
const MUSIC_TEXT_TERMINAL_AUTO_REMOVE_STATUSES = new Set(['completed', 'not-found']);

export function normalizeMusicTextPreferences(preferences = null) {
  return {
    autoRemoveTerminal: preferences?.autoRemoveTerminal === true
  };
}

export function pruneMusicTextTerminalItems(items = [], { autoRemoveTerminal = false } = {}) {
  const normalized = normalizeMusicTextQueueItems(items);
  if (!autoRemoveTerminal) return normalized;
  return normalized.filter((item) => !MUSIC_TEXT_TERMINAL_AUTO_REMOVE_STATUSES.has(item.status));
}


export const MUSIC_TEXT_DONE_PROGRESS_TTL_MS = 3000;

export function shouldShowMusicTextOperationProgress(operation = null, now = Date.now(), doneTtlMs = MUSIC_TEXT_DONE_PROGRESS_TTL_MS) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.phase !== 'done') return true;
  const updatedAt = Number(operation.updatedAt || 0);
  if (!updatedAt) return false;
  return Math.max(0, Number(now) - updatedAt) < Math.max(0, Number(doneTtlMs || 0));
}

export function normalizeMusicTextOperation(operation = null) {
  if (!operation || typeof operation !== 'object') return null;
  const id = String(operation.id || operation.operationId || '').trim();
  const phase = MUSIC_TEXT_OPERATION_PHASES.has(operation.phase)
    ? operation.phase
    : (String(operation.status || '').toLowerCase() === 'completed' ? 'queueing' : 'matching');
  if (!id && phase === 'matching') return null;
  return {
    id,
    phase,
    itemIds: Array.isArray(operation.itemIds) ? operation.itemIds.map((value) => String(value)) : [],
    queueItemIds: Array.isArray(operation.queueItemIds) ? operation.queueItemIds.map((value) => String(value)) : [],
    total: Math.max(0, Number(operation.total || 0)),
    baseMatched: Math.max(0, Number(operation.baseMatched || 0)),
    completed: Math.max(0, Number(operation.completed || 0)),
    matched: Math.max(0, Number(operation.matched || 0)),
    failed: Math.max(0, Number(operation.failed || 0)),
    message: operation.message ? String(operation.message) : null,
    outputPayload: operation.outputPayload && typeof operation.outputPayload === 'object' ? operation.outputPayload : null,
    playlistTitle: operation.playlistTitle ? String(operation.playlistTitle) : null,
    updatedAt: Number(operation.updatedAt || Date.now())
  };
}

export function normalizeMusicTextQueueItems(rows = [], { preserveRunning = false } = {}) {
  const items = [];
  const seen = new Set();

  (Array.isArray(rows) ? rows : []).forEach((entry, index) => {
    const artist = String(entry?.artist || '').trim();
    const title = String(entry?.title || entry?.query || '').trim();
    const query = String(entry?.query || [artist, title].filter(Boolean).join(' - ')).trim();
    if (!title && !query) return;
    const key = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);

    const rawStatus = MUSIC_TEXT_STATUSES.has(entry?.status) ? entry.status : 'pending';
    const hasMatch = !!entry?.match?.id;
    let status = rawStatus;
    if (status === 'running' && !preserveRunning) status = hasMatch ? 'matched' : 'pending';
    let jobId = entry?.jobId ? String(entry.jobId) : null;
    if (status === 'queued' && !jobId) status = hasMatch ? 'matched' : 'pending';
    if (status !== 'queued' && status !== 'completed') jobId = null;

    items.push({
      id: Number.isFinite(Number(entry?.id)) ? Number(entry.id) : index + 1,
      artist,
      title,
      query,
      status,
      error: status === 'running' ? null : (entry?.error ? String(entry.error) : null),
      match: hasMatch ? entry.match : null,
      jobId
    });
  });

  // Legacy stores can contain duplicate numeric ids even when their queries differ.
  // Re-number once here so both UIs operate on the exact same stable queue.
  return items.map((item, index) => ({ ...item, id: index + 1 }));
}

function readStoredRows(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (key.startsWith('gharmonize_music_url_queue_')) {
      return Array.isArray(parsed?.textItems) ? parsed.textItems : [];
    }
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}


function readLegacyTextAutoRemove(storage) {
  for (const key of ['gharmonize_music_url_queue_v2', 'gharmonize_music_url_queue_v1']) {
    try {
      const raw = storage?.getItem?.(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed?.autoRemoveSuccessful === true) return true;
      if (parsed?.autoRemoveSuccessful === false) return false;
    } catch {}
  }
  return false;
}

function readSharedState(storage) {
  try {
    const raw = storage?.getItem?.(MUSIC_TEXT_QUEUE_STORAGE_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function loadMusicTextQueueState(storage = globalThis.localStorage) {
  if (!storage?.getItem) return { items: [], operation: null, preferences: normalizeMusicTextPreferences() };
  const shared = readSharedState(storage);
  if (shared) {
    const operation = normalizeMusicTextOperation(shared.operation);
    const preserveRunning = operation?.phase === 'matching';
    return {
      items: normalizeMusicTextQueueItems(Array.isArray(shared?.items) ? shared.items : [], { preserveRunning }),
      operation,
      preferences: normalizeMusicTextPreferences(
        shared.preferences && Object.prototype.hasOwnProperty.call(shared.preferences, 'autoRemoveTerminal')
          ? shared.preferences
          : { autoRemoveTerminal: readLegacyTextAutoRemove(storage) }
      )
    };
  }

  const merged = [];
  for (const key of MUSIC_TEXT_QUEUE_LEGACY_KEYS) merged.push(...readStoredRows(storage, key));
  const items = normalizeMusicTextQueueItems(merged);
  const preferences = normalizeMusicTextPreferences({ autoRemoveTerminal: readLegacyTextAutoRemove(storage) });
  if (items.length) saveMusicTextQueueState({ items, operation: null, preferences }, storage);
  return { items, operation: null, preferences };
}

export function saveMusicTextQueueState({ items = [], operation = null, preferences } = {}, storage = globalThis.localStorage) {
  if (!storage?.setItem) return;
  const normalizedOperation = normalizeMusicTextOperation(operation);
  const normalizedItems = normalizeMusicTextQueueItems(items, { preserveRunning: normalizedOperation?.phase === 'matching' });
  const existing = readSharedState(storage);
  const normalizedPreferences = normalizeMusicTextPreferences(preferences ?? existing?.preferences);
  storage.setItem(MUSIC_TEXT_QUEUE_STORAGE_KEY, JSON.stringify({
    version: 4,
    updatedAt: Date.now(),
    operation: normalizedOperation,
    preferences: normalizedPreferences,
    items: normalizedItems
  }));
}

export function loadMusicTextQueue(storage = globalThis.localStorage) {
  return loadMusicTextQueueState(storage).items;
}

export function loadMusicTextOperation(storage = globalThis.localStorage) {
  return loadMusicTextQueueState(storage).operation;
}

export function loadMusicTextQueuePreferences(storage = globalThis.localStorage) {
  return loadMusicTextQueueState(storage).preferences;
}

export function saveMusicTextQueue(items = [], storage = globalThis.localStorage) {
  const current = loadMusicTextQueueState(storage);
  saveMusicTextQueueState({ items, operation: current.operation }, storage);
}

export function saveMusicTextOperation(operation = null, storage = globalThis.localStorage) {
  const current = loadMusicTextQueueState(storage);
  saveMusicTextQueueState({ items: current.items, operation, preferences: current.preferences }, storage);
}

export function saveMusicTextQueuePreferences(preferences = {}, storage = globalThis.localStorage) {
  const current = loadMusicTextQueueState(storage);
  saveMusicTextQueueState({ items: current.items, operation: current.operation, preferences }, storage);
}

export function applyMusicTextMatchProgress(items = [], operation = null) {
  const current = normalizeMusicTextQueueItems(items, { preserveRunning: true });
  if (!operation) return current;
  const itemIds = new Set((operation.itemIds || []).map((value) => String(value)));
  const results = new Map((operation.items || []).filter(Boolean).map((entry) => [String(entry.id), entry]));

  return current.map((item) => {
    const id = String(item.id);
    const resolved = results.get(id);
    if (resolved?.matched && resolved.match?.id) {
      return { ...item, status: 'matched', match: resolved.match, error: null, jobId: null };
    }
    if (resolved && resolved.matched === false) {
      return { ...item, status: 'not-found', match: null, error: resolved.error || 'No safe YouTube match found', jobId: null };
    }
    if (itemIds.has(id) && String(operation.status || '').toLowerCase() !== 'completed') {
      return { ...item, status: 'running', error: null, jobId: null };
    }
    return item;
  });
}

export async function reconcileMusicTextQueuedItems(items = [], { fetchImpl = globalThis.fetch } = {}) {
  const normalized = normalizeMusicTextQueueItems(items);
  if (typeof fetchImpl !== 'function') return { items: normalized, changed: false };

  const jobIds = [...new Set(normalized
    .filter((item) => item.status === 'queued' && item.jobId)
    .map((item) => String(item.jobId)))];
  if (!jobIds.length) return { items: normalized, changed: false };

  const statuses = new Map();
  await Promise.all(jobIds.map(async (jobId) => {
    try {
      const response = await fetchImpl(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
      if (response.status === 404) {
        statuses.set(jobId, 'missing');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok === false) return;
      const status = String(data?.status || '').toLowerCase();
      statuses.set(jobId, status === 'cancelled' ? 'canceled' : status);
    } catch {
      // A transient network failure must not mutate a usable shared queue.
    }
  }));

  let changed = false;
  const next = normalized.map((item) => {
    if (item.status !== 'queued' || !item.jobId) return item;
    const jobStatus = statuses.get(String(item.jobId));
    if (!jobStatus) return item;
    if (jobStatus === 'completed') {
      changed = true;
      return { ...item, status: 'completed', error: null };
    }
    if (jobStatus === 'canceled' || jobStatus === 'error' || jobStatus === 'missing') {
      changed = true;
      return {
        ...item,
        status: item.match?.id ? 'matched' : 'pending',
        jobId: null,
        error: null
      };
    }
    return item;
  });

  return { items: next, changed };
}

export function resetMusicTextJob(items = [], jobId, terminalStatus = '') {
  const id = String(jobId || '');
  const status = String(terminalStatus || '').toLowerCase() === 'cancelled'
    ? 'canceled'
    : String(terminalStatus || '').toLowerCase();
  if (!id || !['completed', 'error', 'canceled'].includes(status)) {
    return { items: normalizeMusicTextQueueItems(items), changed: false };
  }

  let changed = false;
  const next = normalizeMusicTextQueueItems(items).map((item) => {
    if (item.status !== 'queued' || String(item.jobId || '') !== id) return item;
    changed = true;
    if (status === 'completed') return { ...item, status: 'completed', error: null };
    return { ...item, status: item.match?.id ? 'matched' : 'pending', jobId: null, error: null };
  });
  return { items: next, changed };
}
