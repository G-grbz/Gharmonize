import test from 'node:test'
import assert from 'node:assert/strict'
import { createBiography, marketLanguages, isMusicEntity } from '../modules/player/biography.js'

function memoryCache() {
  const map = new Map()
  return {
    async wrap(key, ttl, loader) {
      if (map.has(key)) return map.get(key)
      const value = await loader()
      map.set(key, value)
      return value
    },
    map
  }
}

const singer = { P106: [{ mainsnak: { datavalue: { value: { id: 'Q177220' } } } }] }
const deezer = (id) => ({ P2722: [{ mainsnak: { datavalue: { value: String(id) } } }] })
const links = (...langs) => Object.fromEntries(langs.map((l) => [`${l}wiki`, { title: `Page ${l}` }]))

// A tiny Wikidata + Wikipedia stand-in.
function fakeWeb({ search = [], entities = {}, statement = {}, pages = {}, status = 200 } = {}) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const u = new URL(url)
    const json = (body, code = status) => ({ ok: code >= 200 && code < 300, status: code, text: async () => JSON.stringify(body) })
    if (u.hostname === 'www.wikidata.org') {
      const p = u.searchParams
      if (p.get('action') === 'wbsearchentities') return json({ search })
      if (p.get('action') === 'wbgetentities') return json({ entities: Object.fromEntries(p.get('ids').split('|').map((id) => [id, entities[id] || { missing: '' }])) })
      if (p.get('action') === 'query') {
        const id = statement[p.get('srsearch')]
        return json({ query: { search: id ? [{ title: id }] : [] } })
      }
    }
    const lang = u.hostname.split('.')[0]
    const page = pages[lang]
    if (!page) return { ok: false, status: 404, text: async () => '' }
    return json({ query: { pages: { 1: { title: `Page ${lang}`, extract: page, fullurl: `https://${lang}.wikipedia.org/wiki/x` } } } })
  }
  return { fetchImpl, calls }
}

test('market codes become Wikipedia languages in SPOTIFY_MARKET → fallback order', () => {
  assert.deepEqual(marketLanguages({ SPOTIFY_MARKET: 'EN', SPOTIFY_FALLBACK_MARKETS: 'tr,de' }), ['en', 'tr', 'de'])
  assert.deepEqual(marketLanguages({ SPOTIFY_MARKET: 'US', SPOTIFY_FALLBACK_MARKETS: 'GB, DE ,FR' }), ['en', 'de', 'fr'])
  assert.deepEqual(marketLanguages({ SPOTIFY_MARKET: 'AT', SPOTIFY_FALLBACK_MARKETS: 'TR' }), ['de', 'tr'])
  assert.deepEqual(marketLanguages({}, 'tr'), ['tr'])
  assert.deepEqual(marketLanguages({ SPOTIFY_MARKET: '???' }, 'de-DE'), ['de'])
})

test('music items are recognised by occupation, band class or music ids', () => {
  assert.equal(isMusicEntity({ claims: singer }), true)
  assert.equal(isMusicEntity({ claims: { P31: [{ mainsnak: { datavalue: { value: { id: 'Q215380' } } } }] } }), true)
  assert.equal(isMusicEntity({ claims: { P434: [{}] } }), true)
  assert.equal(isMusicEntity({ claims: { P106: [{ mainsnak: { datavalue: { value: { id: 'Q82955' } } } }] } }), false) // politician
})

test('the first language of the order that has a page wins', async () => {
  const web = fakeWeb({
    search: [{ id: 'Q1', label: 'Ali Baran', match: { text: 'Ali Baran' } }],
    entities: { Q1: { id: 'Q1', claims: singer, sitelinks: links('de', 'ku') } },
    pages: { de: 'Ali Baran ist ein kurdischer Sänger.' }
  })
  const bio = createBiography({ cache: memoryCache(), fetchImpl: web.fetchImpl, env: { SPOTIFY_MARKET: 'EN', SPOTIFY_FALLBACK_MARKETS: 'tr,de' }, logger: { debug() {} } })
  const res = await bio.get({ name: 'Ali Baran' })
  assert.equal(res.lang, 'de')
  assert.equal(res.text, 'Ali Baran ist ein kurdischer Sänger.')
  assert.equal(res.wikidata, 'Q1')
  // Cached: no more requests the second time.
  const before = web.calls.length
  await bio.get({ name: 'Ali Baran' })
  assert.equal(web.calls.length, before)
})

test('the Deezer id picks the right namesake, and a namesake of another artist is refused', async () => {
  const web = fakeWeb({
    search: [{ id: 'Q1', label: 'Baran', match: { text: 'Baran' } }, { id: 'Q2', label: 'Baran', match: { text: 'Baran' } }],
    entities: {
      Q1: { id: 'Q1', claims: { ...singer, ...deezer(555) }, sitelinks: links('en') },
      Q2: { id: 'Q2', claims: { ...singer, ...deezer(777) }, sitelinks: links('en') }
    },
    pages: { en: 'Right one.' }
  })
  const bio = createBiography({ cache: memoryCache(), fetchImpl: web.fetchImpl, env: { SPOTIFY_MARKET: 'US' }, logger: { debug() {} } })
  assert.equal((await bio.get({ name: 'Baran', deezerId: '777' })).wikidata, 'Q2')
  assert.equal(await bio.get({ name: 'Baran', deezerId: '999' }), null)
  assert.ok(web.calls.some((u) => u.includes('haswbstatement')))
})

test('a same-named non-musician never lends a biography', async () => {
  const web = fakeWeb({
    search: [{ id: 'Q9', label: 'Tarkan', match: { text: 'Tarkan' } }],
    entities: { Q9: { id: 'Q9', claims: { P106: [{ mainsnak: { datavalue: { value: { id: 'Q82955' } } } }] }, sitelinks: links('en') } },
    pages: { en: 'A politician.' }
  })
  const bio = createBiography({ cache: memoryCache(), fetchImpl: web.fetchImpl, env: { SPOTIFY_MARKET: 'US' }, logger: { debug() {} } })
  assert.equal(await bio.get({ name: 'Tarkan' }), null)
})

test('"too many requests" pauses every lookup and nothing wrong is cached', async () => {
  let t = 0
  const web = fakeWeb({ status: 429 })
  const cache = memoryCache()
  const bio = createBiography({ cache, fetchImpl: web.fetchImpl, env: { SPOTIFY_MARKET: 'US' }, logger: { debug() {} }, now: () => t })
  assert.equal(await bio.get({ name: 'Sezen Aksu' }), null)
  const after = web.calls.length
  assert.equal(await bio.get({ name: 'Tarkan' }), null)
  assert.equal(web.calls.length, after) // paused, no request
  assert.equal(cache.map.size, 0)
  t = 16 * 60 * 1000
  await bio.get({ name: 'Tarkan' })
  assert.ok(web.calls.length > after)
})
