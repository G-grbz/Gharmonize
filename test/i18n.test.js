import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const SOURCE = fs.readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8')
const DICTS = { en: { hello: 'Hello' }, tr: { hello: 'Merhaba' } }

// A tiny browser: one page load of i18n.js with the given saved language
// and a fetch that can fail.
function page({ stored = null, cookie = '', failures = {} } = {}) {
  const storage = new Map(stored ? [['lang', stored]] : [])
  const html = { style: { visibility: '' }, lang: 'en', getAttribute: (k) => (k === 'lang' ? 'en' : null), removeAttribute() {} }
  const jar = { value: cookie }
  const document = {
    documentElement: html,
    querySelectorAll: () => [],
    getElementById: () => null,
    dispatchEvent() {},
    get cookie() { return jar.value },
    set cookie(v) { jar.value = String(v).split(';')[0] }
  }
  const left = { ...failures }
  const fetch = async (url) => {
    const lang = /\/lang\/(\w+)\.json/.exec(url)[1]
    if (left[lang] > 0) { left[lang]--; throw new TypeError('Failed to fetch') }
    return { ok: true, json: async () => DICTS[lang] }
  }
  const window = { location: { href: 'https://gh.example/player/' } }
  const context = vm.createContext({
    window, document, fetch, URL, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    navigator: { language: 'en-US' },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    setTimeout: (fn) => { fn(); return 0 }, clearTimeout() {}
  })
  vm.runInContext(SOURCE, context)
  return { init: () => window.i18nInit(), storage, jar, html }
}

test('a dictionary that fails to load never changes the saved language', async () => {
  const p = page({ stored: 'tr', failures: { tr: 5 } })
  const api = await p.init()
  assert.equal(api.lang, 'en', 'English for this page view')
  assert.equal(p.storage.get('lang'), 'tr', 'saved choice kept')
  assert.ok(!/lang=en/.test(p.jar.value), 'no "en" cookie written')
  // Next load (network fine again): Turkish.
  const next = page({ stored: 'tr', cookie: p.jar.value })
  assert.equal((await next.init()).lang, 'tr')
})

test('one failed request is retried', async () => {
  const api = await page({ stored: 'tr', failures: { tr: 1 } }).init()
  assert.equal(api.lang, 'tr')
  assert.equal(api.t('hello'), 'Merhaba')
})

test('choosing a language saves it; a failed switch keeps the current one', async () => {
  const p = page({ stored: 'tr' })
  const api = await p.init()
  await api.setLang('en')
  assert.equal(p.storage.get('lang'), 'en')
  assert.equal(api.lang, 'en')
  const q = page({ stored: 'en', failures: { tr: 5 } })
  const api2 = await q.init()
  await api2.setLang('tr')
  assert.equal(api2.lang, 'en')
  assert.equal(q.storage.get('lang'), 'en')
})
