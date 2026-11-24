// Each user's search history, kept on the server so every device (web,
// Android, TV) shows the same list: the words they searched for and the
// results they picked from a search (songs, albums, artists, online items).
// Library results are stored by id and read fresh (a removed or hidden song
// disappears); online results are stored as a small copy of the item.

const MAX_QUERIES = 20
const MAX_ITEMS = 20
const MAX_QUERY_LENGTH = 200
const LIBRARY_KINDS = new Set(['track', 'album', 'artist'])
const ONLINE_KINDS = new Set(['track', 'album', 'artist', 'playlist'])
// Fields the clients set themselves on an online item; never stored.
const ONLINE_SKIP = new Set(['library', 'download'])

export class SearchHistoryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function cleanQuery(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
}

const primitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)
const clip = (v) => (typeof v === 'string' ? v.slice(0, 2000) : typeof v === 'number' && !Number.isFinite(v) ? null : v)

// A copy of an online item with plain values only (and one level of plain
// objects such as providerIds), so a client cannot store anything large.
export function onlineSnapshot(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const kind = String(item.kind || '')
  const provider = String(item.provider || '').slice(0, 40)
  if (!ONLINE_KINDS.has(kind) || !provider || provider === 'library') return null
  const out = {}
  let fields = 0
  for (const [key, value] of Object.entries(item)) {
    if (ONLINE_SKIP.has(key) || fields >= 40 || key.length > 40) continue
    if (primitive(value)) out[key] = clip(value)
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = {}
      for (const [k, v] of Object.entries(value).slice(0, 10)) if (primitive(v) && k.length <= 40) inner[k] = clip(v)
      out[key] = inner
    } else continue
    fields++
  }
  if (!out.title || !(out.id || out.url)) return null
  return out
}

function itemKey(entry) {
  if (entry.source === 'library') return `${entry.kind}:${entry.id}`
  const o = entry.online
  return `o:${o.provider}:${o.kind}:${String(o.mix ? `mix-${o.mixId || o.id}` : o.id || o.url).slice(0, 300)}`
}

export function createSearchHistory(db, { catalog, annotator = null, now = () => Date.now() } = {}) {
  const q = (sql) => db.prepare(sql)

  function prune(userId, type, max) {
    q(`DELETE FROM search_history WHERE user_id = ? AND type = ? AND id NOT IN
      (SELECT id FROM search_history WHERE user_id = ? AND type = ? ORDER BY updated_at DESC, id DESC LIMIT ?)`)
      .run(userId, type, userId, type, max)
  }

  function upsert(userId, type, key, value) {
    q(`INSERT INTO search_history (user_id, type, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, type, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(userId, type, key, value, now())
  }

  function addQuery(userId, text) {
    const query = cleanQuery(text)
    if (!query) throw new SearchHistoryError('BAD_REQUEST', 'Search text is required.')
    // One entry per text, whatever the letter case: the latest spelling wins.
    upsert(userId, 'query', query.toLocaleLowerCase('tr'), query)
    prune(userId, 'query', MAX_QUERIES)
  }

  function addItem(userId, raw) {
    let entry = null
    if (raw?.source === 'library' || (raw && !raw.online && raw.id != null)) {
      const kind = String(raw.kind || '')
      const id = Number.parseInt(raw.id, 10)
      if (LIBRARY_KINDS.has(kind) && id > 0) entry = { source: 'library', kind, id }
    } else {
      const online = onlineSnapshot(raw?.online)
      if (online) entry = { source: 'online', online }
    }
    if (!entry) throw new SearchHistoryError('BAD_REQUEST', 'Unknown search result.')
    upsert(userId, 'item', itemKey(entry), JSON.stringify(entry))
    prune(userId, 'item', MAX_ITEMS)
  }

  // Library results are looked up again: only songs the user may still see.
  function resolve(userId, entry) {
    if (entry.source === 'online') return { source: 'online', kind: entry.online.kind, item: entry.online }
    if (entry.kind === 'track') {
      const track = catalog.getTracksByIds([entry.id], userId)[0]
      return track ? { source: 'library', kind: 'track', track } : null
    }
    if (entry.kind === 'album') {
      const album = catalog.albumSummary(entry.id, userId)
      return album ? { source: 'library', kind: 'album', album } : null
    }
    const artist = catalog.artistSummary(entry.id, userId)
    return artist && artist.trackCount > 0 ? { source: 'library', kind: 'artist', artist } : null
  }

  function list(userId) {
    const rows = q(`SELECT type, key, value, updated_at FROM search_history WHERE user_id = ? ORDER BY updated_at DESC, id DESC`).all(userId)
    const queries = rows.filter((r) => r.type === 'query').map((r) => ({ q: r.value, at: r.updated_at }))
    const items = []
    for (const row of rows) {
      if (row.type !== 'item') continue
      let entry = null
      try { entry = JSON.parse(row.value) } catch {}
      const resolved = entry ? resolve(userId, entry) : null
      if (resolved) items.push({ key: row.key, at: row.updated_at, ...resolved })
    }
    // Whether an online result is in the library (or downloading) now.
    const online = items.filter((i) => i.source === 'online')
    if (annotator && online.length) {
      try {
        const marked = annotator.items(online.map((i) => i.item), userId)
        online.forEach((i, n) => { i.item = marked[n] || i.item })
      } catch {}
    }
    return { queries, items }
  }

  function remove(userId, { query = null, key = null } = {}) {
    if (query != null) q(`DELETE FROM search_history WHERE user_id = ? AND type = 'query' AND key = ?`).run(userId, cleanQuery(query).toLocaleLowerCase('tr'))
    else if (key != null) q(`DELETE FROM search_history WHERE user_id = ? AND type = 'item' AND key = ?`).run(userId, String(key).slice(0, 400))
    else q('DELETE FROM search_history WHERE user_id = ?').run(userId)
  }

  return { list, addQuery, addItem, remove }
}
