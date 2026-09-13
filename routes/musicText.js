import crypto from 'crypto';
import express from 'express';
import { searchYtmBestMatch } from '../modules/sp.js';
import { rateLimit, concurrencyLimit } from '../modules/rateLimit.js';
import { sendOk, sendError } from '../modules/utils.js';

const router = express.Router();
const DEFAULT_MAX_ITEMS = 500;
const MATCH_OPERATION_TTL_MS = Math.max(5 * 60_000, Number(process.env.MUSIC_TEXT_MATCH_OPERATION_TTL_MS || 60 * 60_000));
const matchOperations = new Map();

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanText(value, max = 300) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function splitQuery(value = '') {
  const query = cleanText(value);
  const match = query.match(/^(.*?)\s+[–—-]\s+(.+)$/);
  if (!match) return { artist: '', title: query, query };
  return {
    artist: cleanText(match[1], 180),
    title: cleanText(match[2], 220),
    query
  };
}

function prepareItems(rawItems = []) {
  return rawItems.map((item, index) => {
    const parsed = splitQuery(item?.query || '');
    const artist = cleanText(item?.artist || parsed.artist, 180);
    const title = cleanText(item?.title || parsed.title, 220);
    const query = cleanText(item?.query || [artist, title].filter(Boolean).join(' - '), 300);
    return {
      id: cleanText(item?.id || `text-${index + 1}`, 100),
      artist,
      title,
      query
    };
  }).filter((item) => item.title || item.query);
}

async function mapConcurrent(items, limit, mapper, onSettled = null) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
      onSettled?.(results[index], index, results);
    }
  });
  await Promise.all(workers);
  return results;
}

async function matchOne(item) {
  try {
    const match = await searchYtmBestMatch(item.artist, item.title || item.query, { provider: 'text' });
    if (!match?.id) {
      return { ...item, matched: false, match: null, error: 'No safe YouTube match found' };
    }
    return { ...item, matched: true, match, error: null };
  } catch (error) {
    return {
      ...item,
      matched: false,
      match: null,
      error: cleanText(error?.message || 'Matching failed', 500)
    };
  }
}

async function matchBatch(items, workerCount, onSettled = null) {
  const results = await mapConcurrent(items, workerCount, matchOne, onSettled);
  const matched = results.filter((item) => item?.matched).length;
  return {
    items: results,
    matched,
    failed: results.length - matched,
    total: results.length
  };
}

function cleanupMatchOperations() {
  const cutoff = Date.now() - MATCH_OPERATION_TTL_MS;
  for (const [id, operation] of matchOperations.entries()) {
    if (Number(operation?.updatedAt || operation?.createdAt || 0) < cutoff) matchOperations.delete(id);
  }
}

function publicOperation(operation) {
  if (!operation) return null;
  return {
    id: operation.id,
    status: operation.status,
    total: operation.total,
    completed: operation.completed,
    matched: operation.matched,
    failed: operation.failed,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    error: operation.error || null,
    items: operation.items.map((item) => item || null)
  };
}

function createMatchOperation(items, workerCount) {
  cleanupMatchOperations();
  const now = Date.now();
  const operation = {
    id: crypto.randomUUID(),
    status: 'matching',
    total: items.length,
    completed: 0,
    matched: 0,
    failed: 0,
    createdAt: now,
    updatedAt: now,
    error: null,
    items: new Array(items.length).fill(null)
  };
  matchOperations.set(operation.id, operation);

  // Deliberately detach the matching work from the HTTP request. Closing the
  // modal, navigating between Classic/YTLive, or losing the initiating fetch
  // does not terminate the server-side operation. A later client can resume it
  // by operation id and reconstruct the exact per-row state.
  void matchBatch(items, workerCount, (result, index) => {
    operation.items[index] = result;
    operation.completed += 1;
    if (result?.matched) operation.matched += 1;
    else operation.failed += 1;
    operation.updatedAt = Date.now();
  }).then((result) => {
    operation.items = result.items;
    operation.matched = result.matched;
    operation.failed = result.failed;
    operation.completed = result.total;
    operation.total = result.total;
    operation.status = 'completed';
    operation.updatedAt = Date.now();
  }).catch((error) => {
    operation.status = 'error';
    operation.error = cleanText(error?.message || 'Music text matching failed', 500);
    operation.updatedAt = Date.now();
  });

  return operation;
}

function validateRequestItems(req, res) {
  const maxItems = clampInt(process.env.MUSIC_TEXT_MATCH_MAX_ITEMS, 1, 2000, DEFAULT_MAX_ITEMS);
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rawItems.length) {
    sendError(res, 'MUSIC_TEXT_LIST_EMPTY', 'No music names were provided', 400);
    return null;
  }
  if (rawItems.length > maxItems) {
    sendError(res, 'MUSIC_TEXT_LIST_TOO_LARGE', `A maximum of ${maxItems} items can be matched at once`, 400);
    return null;
  }
  const items = prepareItems(rawItems);
  if (!items.length) {
    sendError(res, 'MUSIC_TEXT_LIST_EMPTY', 'No valid music names were provided', 400);
    return null;
  }
  return items;
}

router.post('/api/music/text-match/operations', rateLimit(10, 60_000), concurrencyLimit(2), async (req, res) => {
  try {
    const items = validateRequestItems(req, res);
    if (!items) return;
    const workerCount = clampInt(req.body?.concurrency, 1, 8, 3);
    const operation = createMatchOperation(items, workerCount);
    return sendOk(res, publicOperation(operation));
  } catch (error) {
    return sendError(res, 'MUSIC_TEXT_MATCH_START_FAILED', error?.message || 'Music text matching could not be started', 500);
  }
});

router.get('/api/music/text-match/operations/:id', rateLimit(120, 60_000), async (req, res) => {
  cleanupMatchOperations();
  const id = cleanText(req.params?.id, 100);
  const operation = matchOperations.get(id);
  if (!operation) return sendError(res, 'MUSIC_TEXT_MATCH_NOT_FOUND', 'Music text matching operation was not found', 404);
  return sendOk(res, publicOperation(operation));
});

// Backward-compatible synchronous endpoint. Existing clients/tests keep working,
// while the UI uses the resumable operation endpoints above.
router.post('/api/music/text-match', rateLimit(10, 60_000), concurrencyLimit(2), async (req, res) => {
  try {
    const items = validateRequestItems(req, res);
    if (!items) return;
    const workerCount = clampInt(req.body?.concurrency, 1, 8, 3);
    const result = await matchBatch(items, workerCount);
    return sendOk(res, result);
  } catch (error) {
    return sendError(res, 'MUSIC_TEXT_MATCH_FAILED', error?.message || 'Music text matching failed', 500);
  }
});

export default router;
