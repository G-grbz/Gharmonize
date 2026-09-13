import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMusicTextLine,
  parseMusicTextList,
  matchMusicTextItems,
  buildMusicTextJobPayload,
  MUSIC_TEXT_QUEUE_STORAGE_KEY,
  loadMusicTextQueue,
  loadMusicTextQueueState,
  saveMusicTextQueue,
  saveMusicTextQueueState,
  applyMusicTextMatchProgress,
  reconcileMusicTextQueuedItems,
  resetMusicTextJob,
  pruneMusicTextTerminalItems,
  MUSIC_TEXT_DONE_PROGRESS_TTL_MS,
  shouldShowMusicTextOperationProgress
} from '../public/ui/MusicTextImport.js';

test('music text parser accepts numbered Markdown rows and removes trailing commentary', () => {
  const item = parseMusicTextLine(
    '21. **Loreena McKennitt – Marco Polo** — doğu-batı karışımı, yolculuk hissi.',
    20
  );

  assert.equal(item.artist, 'Loreena McKennitt');
  assert.equal(item.title, 'Marco Polo');
  assert.equal(item.query, 'Loreena McKennitt - Marco Polo');
});

test('music text parser accepts em dash itself as artist/title delimiter', () => {
  const item = parseMusicTextLine('Enigma — Return to Innocence');
  assert.equal(item.artist, 'Enigma');
  assert.equal(item.title, 'Return to Innocence');
});

test('music text parser accepts plain hyphen, bullets and deduplicates repeated rows', () => {
  const items = parseMusicTextList(`
- Enigma - Sadeness (Part I)
2. **Enigma – Sadeness (Part I)** — tekrar satırı
• Vangelis – Conquest of Paradise
`);

  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map(({ artist, title }) => ({ artist, title })),
    [
      { artist: 'Enigma', title: 'Sadeness (Part I)' },
      { artist: 'Vangelis', title: 'Conquest of Paradise' }
    ]
  );
});


test('music text parser handles 100 copied rows in one paste', () => {
  const text = Array.from({ length: 100 }, (_, index) => `${index + 1}. **Artist ${index + 1} – Song ${index + 1}** — açıklama`).join('\n');
  const items = parseMusicTextList(text);
  assert.equal(items.length, 100);
  assert.equal(items[0].query, 'Artist 1 - Song 1');
  assert.equal(items[99].query, 'Artist 100 - Song 100');
});

test('music text job payload creates one playlist-like job containing every matched id', () => {
  const payload = buildMusicTextJobPayload([
    {
      id: 'row-1',
      artist: 'Enigma',
      title: 'Return to Innocence',
      query: 'Enigma - Return to Innocence',
      match: {
        id: 'abc123',
        title: 'Enigma - Return To Innocence',
        uploader: 'Enigma',
        webpage_url: 'https://www.youtube.com/watch?v=abc123',
        thumbnail: 'https://img.example/abc.jpg',
        duration: 250
      }
    },
    {
      id: 'row-2',
      artist: 'Vangelis',
      title: 'Conquest of Paradise',
      query: 'Vangelis - Conquest of Paradise',
      match: {
        id: 'def456',
        title: 'Vangelis - Conquest of Paradise',
        uploader: 'Vangelis',
        webpage_url: 'https://music.youtube.com/watch?v=def456'
      }
    }
  ], { format: 'flac', sampleRate: 48000 }, { title: 'Yapıştırılan müzik listesi' });

  assert.equal(payload.isPlaylist, true);
  assert.equal(payload.plTitle, 'Yapıştırılan müzik listesi');
  assert.equal(payload.format, 'flac');
  assert.equal(payload.sampleRate, 48000);
  assert.deepEqual(payload.selectedIds, ['abc123', 'def456']);
  assert.equal(payload.frozenEntries.length, 2);
  assert.equal(payload.url, 'https://www.youtube.com/watch?v=abc123');
});


test('Classic and YTLive migrate into one shared music-text queue', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value))
  };
  map.set('gharmonize_ytlive_music_text_import_v1', JSON.stringify({
    items: [{ id: 8, artist: 'Enigma', title: 'Sadeness', query: 'Enigma - Sadeness', status: 'pending' }]
  }));
  map.set('gharmonize_music_url_queue_v2', JSON.stringify({
    textItems: [{ id: 2, artist: 'Vangelis', title: 'Conquest of Paradise', query: 'Vangelis - Conquest of Paradise', status: 'matched', match: { id: 'v1' } }]
  }));

  const first = loadMusicTextQueue(storage);
  assert.deepEqual(first.map((item) => item.query), ['Enigma - Sadeness', 'Vangelis - Conquest of Paradise']);
  assert.ok(map.has(MUSIC_TEXT_QUEUE_STORAGE_KEY));

  saveMusicTextQueue(first.slice(0, 1), storage);
  const second = loadMusicTextQueue(storage);
  assert.deepEqual(second.map((item) => item.query), ['Enigma - Sadeness']);
});

test('canceled shared batch becomes runnable again while keeping resolved matches', () => {
  const source = [{
    id: 1,
    artist: 'Enigma',
    title: 'Return to Innocence',
    query: 'Enigma - Return to Innocence',
    status: 'queued',
    jobId: 'job-1',
    match: { id: 'abc', title: 'Enigma - Return To Innocence' }
  }];
  const result = resetMusicTextJob(source, 'job-1', 'canceled');
  assert.equal(result.changed, true);
  assert.equal(result.items[0].status, 'matched');
  assert.equal(result.items[0].jobId, null);
  assert.equal(result.items[0].match.id, 'abc');
});

test('queued batch reconciliation revives a canceled job and marks completed jobs finished', async () => {
  const items = [
    { id: 1, artist: 'A', title: 'One', query: 'A - One', status: 'queued', jobId: 'cancel-me', match: { id: 'a1' } },
    { id: 2, artist: 'B', title: 'Two', query: 'B - Two', status: 'queued', jobId: 'done', match: { id: 'b2' } }
  ];
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, status: String(url).includes('cancel-me') ? 'canceled' : 'completed' })
  });
  const result = await reconcileMusicTextQueuedItems(items, { fetchImpl });
  assert.equal(result.changed, true);
  assert.equal(result.items[0].status, 'matched');
  assert.equal(result.items[0].jobId, null);
  assert.equal(result.items[1].status, 'completed');
});


test('active shared matching operation preserves running rows across modal reopen', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value))
  };
  saveMusicTextQueueState({
    items: [
      { id: 1, artist: 'Bulutsuzluk Özlemi', title: 'Bağdat Cafe', query: 'Bulutsuzluk Özlemi - Bağdat Cafe', status: 'running' },
      { id: 2, artist: 'Enigma', title: 'Sadeness', query: 'Enigma - Sadeness', status: 'matched', match: { id: 'enigma1' } }
    ],
    operation: {
      id: 'op-1',
      phase: 'matching',
      itemIds: ['1'],
      queueItemIds: ['1', '2'],
      baseMatched: 1,
      total: 2,
      completed: 1,
      matched: 1,
      failed: 0,
      outputPayload: { format: 'flac' }
    }
  }, storage);

  const state = loadMusicTextQueueState(storage);
  assert.equal(state.items[0].status, 'running');
  assert.equal(state.operation.id, 'op-1');
  assert.equal(state.operation.outputPayload.format, 'flac');
  assert.deepEqual(state.operation.queueItemIds, ['1', '2']);
});

test('server operation progress reconstructs matched, missing and running rows', () => {
  const items = [
    { id: 1, artist: 'A', title: 'One', query: 'A - One', status: 'running' },
    { id: 2, artist: 'B', title: 'Two', query: 'B - Two', status: 'running' },
    { id: 3, artist: 'C', title: 'Three', query: 'C - Three', status: 'running' }
  ];
  const next = applyMusicTextMatchProgress(items, {
    status: 'matching',
    itemIds: ['1', '2', '3'],
    items: [
      { id: '1', matched: true, match: { id: 'yt1', title: 'One' } },
      { id: '2', matched: false, match: null, error: 'No safe YouTube match found' },
      null
    ]
  });
  assert.equal(next[0].status, 'matched');
  assert.equal(next[0].match.id, 'yt1');
  assert.equal(next[1].status, 'not-found');
  assert.match(next[1].error, /No safe YouTube match/);
  assert.equal(next[2].status, 'running');
});


test('resumable matcher starts a server operation and returns its completed snapshot', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (String(url).endsWith('/operations')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          id: 'op-77',
          status: 'matching',
          total: 1,
          completed: 0,
          matched: 0,
          failed: 0,
          items: [null]
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        id: 'op-77',
        status: 'completed',
        total: 1,
        completed: 1,
        matched: 1,
        failed: 0,
        items: [{ id: '1', artist: 'A', title: 'One', query: 'A - One', matched: true, match: { id: 'yt-one' } }]
      })
    };
  };
  let operationId = '';
  const result = await matchMusicTextItems(
    [{ id: 1, artist: 'A', title: 'One', query: 'A - One' }],
    {
      fetchImpl,
      pollIntervalMs: 1,
      onOperation: (operation) => { operationId = operation.id; }
    }
  );
  assert.equal(operationId, 'op-77');
  assert.equal(result.matched, 1);
  assert.equal(result.items[0].match.id, 'yt-one');
  assert.deepEqual(calls.map((call) => call.method), ['POST', 'GET']);
});


test('shared text auto-remove preference migrates from the existing Classic checkbox', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value))
  };
  map.set('gharmonize_music_url_queue_v2', JSON.stringify({
    autoRemoveSuccessful: true,
    textItems: [{ id: 1, artist: 'A', title: 'One', query: 'A - One', status: 'completed' }]
  }));

  const state = loadMusicTextQueueState(storage);
  assert.equal(state.preferences.autoRemoveTerminal, true);
});

test('text auto-remove removes completed and unmatched rows but keeps retryable errors and matched rows', () => {
  const items = [
    { id: 1, artist: 'A', title: 'Done', query: 'A - Done', status: 'completed', match: { id: 'a1' }, jobId: 'job-1' },
    { id: 2, artist: 'B', title: 'Missing', query: 'B - Missing', status: 'not-found', error: 'No safe YouTube match found' },
    { id: 3, artist: 'C', title: 'Retry', query: 'C - Retry', status: 'error', error: 'Temporary failure' },
    { id: 4, artist: 'D', title: 'Matched', query: 'D - Matched', status: 'matched', match: { id: 'd4' } }
  ];

  const next = pruneMusicTextTerminalItems(items, { autoRemoveTerminal: true });
  assert.deepEqual(next.map((item) => item.title), ['Retry', 'Matched']);
  assert.deepEqual(next.map((item) => item.status), ['error', 'matched']);
});

test('text auto-remove disabled leaves completed and unmatched rows intact', () => {
  const items = [
    { id: 1, artist: 'A', title: 'Done', query: 'A - Done', status: 'completed' },
    { id: 2, artist: 'B', title: 'Missing', query: 'B - Missing', status: 'not-found' }
  ];
  const next = pruneMusicTextTerminalItems(items, { autoRemoveTerminal: false });
  assert.deepEqual(next.map((item) => item.status), ['completed', 'not-found']);
});


test('completed text-operation progress expires instead of reappearing forever', () => {
  const now = Date.now();
  const fresh = {
    id: 'done-fresh',
    phase: 'done',
    matched: 1,
    failed: 0,
    updatedAt: now - 500
  };
  const stale = {
    ...fresh,
    id: 'done-stale',
    updatedAt: now - MUSIC_TEXT_DONE_PROGRESS_TTL_MS - 50
  };

  assert.equal(shouldShowMusicTextOperationProgress(fresh, now), true);
  assert.equal(shouldShowMusicTextOperationProgress(stale, now), false);
  assert.equal(shouldShowMusicTextOperationProgress({ phase: 'matching', updatedAt: now - 999999 }, now), true);
  assert.equal(shouldShowMusicTextOperationProgress({ phase: 'error', updatedAt: now - 999999 }, now), true);
});
