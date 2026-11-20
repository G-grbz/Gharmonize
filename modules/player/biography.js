// Artist biographies from Wikipedia, found through Wikidata.
//
// Which artist: Wikidata knows Deezer artist ids (P2722), so a Deezer id gives
// an exact match. Without one (or no hit) the name is searched and only an
// item with the same name that is clearly a musician / band is accepted, so a
// namesake never lends their life story.
//
// Which language: SPOTIFY_MARKET first, then SPOTIFY_FALLBACK_MARKETS in order
// (country codes are mapped to their Wikipedia language: US → en, TR → tr,
// AT → de …). With neither set, the Gharmonize language is used.
//
// Cheap: asked only when an artist page is opened; the artist → Wikidata item
// is cached for 30 days, each text for 7 days, "nothing found" for 3 days.
import { normalizeKey } from './scanner.js'

const DAY = 24 * 60 * 60 * 1000
const TTL = { entity: 30 * DAY, missing: 3 * DAY, text: 7 * DAY }
const USER_AGENT = 'Gharmonize-Player/1.0 (self-hosted music player)'
const MAX_TEXT = 4000
const BACKOFF_MS = 15 * 60 * 1000

// Country (market) → Wikipedia language. Codes not listed that are already a
// language ("EN", "TR") are used as they are.
const COUNTRY_LANG = {
  US: 'en', GB: 'en', UK: 'en', IE: 'en', AU: 'en', NZ: 'en', CA: 'en', ZA: 'en', IN: 'en', SG: 'en', PH: 'en',
  TR: 'tr', CY: 'tr', AZ: 'az',
  DE: 'de', AT: 'de', CH: 'de', LI: 'de', LU: 'de',
  FR: 'fr', BE: 'fr', MC: 'fr',
  ES: 'es', MX: 'es', AR: 'es', CO: 'es', CL: 'es', PE: 'es', VE: 'es', UY: 'es', EC: 'es', BO: 'es', PY: 'es', CR: 'es', DO: 'es', GT: 'es', HN: 'es', NI: 'es', PA: 'es', SV: 'es',
  IT: 'it', SM: 'it', PT: 'pt', BR: 'pt', NL: 'nl', SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', IS: 'is', PL: 'pl', CZ: 'cs',
  SK: 'sk', HU: 'hu', RO: 'ro', MD: 'ro', BG: 'bg', GR: 'el', RS: 'sr', HR: 'hr', SI: 'sl', BA: 'bs', MK: 'mk', AL: 'sq',
  UA: 'uk', RU: 'ru', BY: 'be', KZ: 'kk', GE: 'ka', AM: 'hy', IL: 'he', SA: 'ar', AE: 'ar', EG: 'ar', MA: 'ar', DZ: 'ar',
  TN: 'ar', JO: 'ar', LB: 'ar', IQ: 'ar', KW: 'ar', QA: 'ar', IR: 'fa', JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh',
  TH: 'th', VN: 'vi', ID: 'id', MY: 'ms', EE: 'et', LV: 'lv', LT: 'lt'
}
const LANG_RE = /^[a-z]{2,3}$/

// Items that are clearly about music: occupations and band-like classes.
const MUSIC_OCCUPATIONS = new Set(['Q177220', 'Q639669', 'Q36834', 'Q488205', 'Q753110', 'Q2252262', 'Q130857', 'Q855091', 'Q386854', 'Q1259917', 'Q158852', 'Q1075651', 'Q183945', 'Q2643890', 'Q1198887', 'Q806349', 'Q486748', 'Q12800682'])
const MUSIC_CLASSES = new Set(['Q215380', 'Q5741069', 'Q2088357', 'Q281643', 'Q9212979', 'Q1062083', 'Q19849', 'Q56816954'])
// MusicBrainz artist, Spotify artist, Deezer artist, Discogs artist, Apple Music artist.
const MUSIC_IDS = ['P434', 'P1902', 'P2722', 'P1953', 'P2850']

export function marketLanguages(env = process.env, fallbackLang = 'en') {
  const out = []
  const push = (code) => {
    const raw = String(code || '').trim()
    if (!raw) return
    const lang = COUNTRY_LANG[raw.toUpperCase()] || raw.toLowerCase()
    if (LANG_RE.test(lang) && !out.includes(lang)) out.push(lang)
  }
  push(env.SPOTIFY_MARKET)
  for (const part of String(env.SPOTIFY_FALLBACK_MARKETS || '').split(',')) push(part)
  if (!out.length) push(String(fallbackLang || 'en').slice(0, 2))
  return out.length ? out : ['en']
}

function claimIds(entity, prop) {
  return (entity?.claims?.[prop] || []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean)
}

export function isMusicEntity(entity) {
  if (!entity?.claims) return false
  if (MUSIC_IDS.some((p) => entity.claims[p]?.length)) return true
  if (claimIds(entity, 'P106').some((id) => MUSIC_OCCUPATIONS.has(id))) return true
  return claimIds(entity, 'P31').some((id) => MUSIC_CLASSES.has(id))
}

export function createBiography({ cache, fetchImpl = fetch, env = process.env, logger = console, now = () => Date.now() }) {
  // Wikimedia asks clients to go easy: one request at a time, and a quiet
  // quarter of an hour after a "too many requests" answer.
  let blockedUntil = 0
  let chain = Promise.resolve()
  const serial = (fn) => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }
  async function getJson(url) {
    if (now() < blockedUntil) throw new Error('rate limited')
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (res.status === 404) return null
    if (res.status === 429 || res.status === 503) { blockedUntil = now() + BACKOFF_MS; throw new Error(`HTTP ${res.status}`) }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    try { return JSON.parse(text) } catch {
      if (/too many requests/i.test(text)) blockedUntil = now() + BACKOFF_MS
      throw new Error('not JSON')
    }
  }
  const wd = (params) => getJson(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`)

  async function entitiesWithLinks(ids) {
    if (!ids.length) return []
    const body = await wd({ action: 'wbgetentities', ids: ids.join('|'), props: 'claims|sitelinks|labels|aliases' })
    return ids.map((id) => body?.entities?.[id]).filter((e) => e && !e.missing)
  }

  const slim = (entity) => ({
    id: entity.id,
    links: Object.fromEntries(Object.entries(entity.sitelinks || {})
      .filter(([site]) => /^[a-z]{2,3}wiki$/.test(site))
      .map(([site, v]) => [site.slice(0, -4), v.title]))
  })

  const deezerIds = (entity) => (entity?.claims?.P2722 || []).map((c) => String(c?.mainsnak?.datavalue?.value || ''))

  // → { id, links: { tr: 'Sezen Aksu', en: … } } or null
  // Cheap name lookup first; the Deezer id then picks the right item. The
  // heavier statement search is only used when the name finds nothing.
  async function findEntity(name, deezerId, langs) {
    const dz = /^\d+$/.test(String(deezerId || '')) ? String(deezerId) : null
    const want = normalizeKey(name)
    const ids = []
    if (want) {
      for (const language of [...new Set([...langs.slice(0, 2), 'en'])]) {
        const found = await wd({ action: 'wbsearchentities', search: String(name).slice(0, 200), language, uselang: language, type: 'item', limit: '7' })
        for (const s of found?.search || []) if (normalizeKey(s.match?.text || s.label) === want && !ids.includes(s.id)) ids.push(s.id)
        if (ids.length) break
      }
    }
    const entities = await entitiesWithLinks(ids.slice(0, 7))
    if (dz) {
      const exact = entities.find((e) => deezerIds(e).includes(dz))
      if (exact) return slim(exact)
    }
    // Same name, a musician, and not tied to another Deezer artist.
    const byName = entities.find((e) => isMusicEntity(e) && !(dz && deezerIds(e).length && !deezerIds(e).includes(dz)))
    if (byName) return slim(byName)
    if (dz) {
      const hit = await wd({ action: 'query', list: 'search', srsearch: `haswbstatement:P2722=${dz}`, srlimit: '1' })
      const id = hit?.query?.search?.[0]?.title
      if (/^Q\d+$/.test(String(id || ''))) {
        const [entity] = await entitiesWithLinks([id])
        if (entity) return slim(entity)
      }
    }
    return null
  }

  // The whole lead section of the article as plain text (one request).
  async function summary(lang, title) {
    const params = new URLSearchParams({ action: 'query', prop: 'extracts|info', exintro: '1', explaintext: '1', redirects: '1', inprop: 'url', titles: title, format: 'json' })
    const body = await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`)
    const page = Object.values(body?.query?.pages || {})[0]
    const text = String(page?.extract || '').replace(/\n{3,}/g, '\n\n').trim()
    if (!page || page.missing !== undefined || !text) return null
    return {
      lang,
      title: page.title || title,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT).replace(/\s+\S*$/, '')}…` : text,
      url: page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      source: 'Wikipedia'
    }
  }

  /** Biography of an artist in the first language of the market order that has one, or null. */
  async function get({ name, deezerId = null, lang = 'en' } = {}) {
    const clean = String(name || '').trim().slice(0, 200)
    if (!clean) return null
    const langs = marketLanguages(env, lang)
    const entityKey = `bio:entity:${/^\d+$/.test(String(deezerId || '')) ? `dz${deezerId}` : normalizeKey(clean)}`
    let entity
    try {
      entity = await cache.wrap(entityKey, TTL.entity, () => serial(() => findEntity(clean, deezerId, langs)), { ttlFor: (v) => (v ? TTL.entity : TTL.missing) })
    } catch (error) {
      logger.debug?.(`[player] biography lookup for ${clean} failed: ${error?.message || error}`)
      return null
    }
    if (!entity) return null
    for (const l of langs) {
      const title = entity.links?.[l]
      if (!title) continue
      try {
        const text = await cache.wrap(`bio:lead:${entity.id}:${l}`, TTL.text, () => serial(() => summary(l, title)), { ttlFor: (v) => (v ? TTL.text : TTL.missing) })
        if (text) return { ...text, wikidata: entity.id, languages: langs }
      } catch (error) {
        logger.debug?.(`[player] biography text ${entity.id}/${l} failed: ${error?.message || error}`)
      }
    }
    return null
  }

  return { get, languages: (lang) => marketLanguages(env, lang) }
}
