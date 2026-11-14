import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const UI_DIR = 'public/player/js'
const LOCALES = ['en', 'tr', 'de', 'fr', 'es']

function uiFiles(dir = UI_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return uiFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(`public/lang/${l}.json`, 'utf8'))]))
const placeholders = (text) => [...new Set(String(text).match(/\{\w+\}/g) || [])].sort()

test('every static player.* key used by the web player exists in all locales', () => {
  const used = new Set()
  for (const file of uiFiles()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/'(player\.[A-Za-z0-9_.-]+)'/g)) used.add(m[1])
  }
  // Shelf titles produced by the server-side discovery layer.
  for (const m of fs.readFileSync('modules/player/discovery.js', 'utf8').matchAll(/'(player\.discover\.[A-Za-z]+)'/g)) used.add(m[1])
  assert.ok(used.size > 300)
  for (const locale of LOCALES) {
    const missing = [...used].filter((key) => typeof messages[locale][key] !== 'string')
    assert.deepEqual(missing, [], `${locale} is missing player keys`)
  }
})

test('player translations have the same keys and placeholders in every locale', () => {
  const enKeys = Object.keys(messages.en).filter((k) => k.startsWith('player.'))
  for (const locale of LOCALES.slice(1)) {
    const keys = Object.keys(messages[locale]).filter((k) => k.startsWith('player.'))
    assert.deepEqual(keys.slice().sort(), enKeys.slice().sort(), `${locale} player keys differ from en`)
    for (const key of enKeys) assert.deepEqual(placeholders(messages[locale][key]), placeholders(messages.en[key]), `${locale}:${key}`)
  }
})

test('dynamic player keys (statuses, moods, qualities, tabs) are translated', () => {
  const dynamic = [
    ...['queued', 'resolving', 'downloading', 'indexing', 'completed', 'exists', 'failed', 'canceled'].map((s) => `player.downloads.status.${s}`),
    ...['energizing', 'workout', 'feel-good', 'relax', 'sad', 'romance', 'commute', 'party', 'focus', 'sleep'].map((m) => `player.mood.${m}`),
    ...['original', 'high', 'normal', 'low', 'saver'].map((q) => `player.quality.${q}`),
    ...['high', 'normal', 'low', 'saver'].map((q) => `player.quality.short.${q}`),
    ...['server', 'remote', 'libraries', 'users', 'downloads'].map((x) => `player.admin.tab.${x}`),
    ...['current', 'lan', 'tailscale', 'tailscale-dns', 'tailscale-https', 'custom'].map((x) => `player.remote.kind.${x}`),
    ...['LOCAL_ONLY', 'LISTENER_FAILED', 'TAILSCALE_UNREACHABLE', 'FUNNEL_BLOCKED', 'REMOTE_OFF'].map((x) => `player.remote.warn.${x}`),
    ...['off', 'tailscale', 'any'].map((x) => `player.admin.remote_${x}`),
    ...['loopback', 'lan', 'tailscale', 'public'].map((x) => `player.admin.net_${x}`),
    ...['idle', 'starting', 'walking', 'reading', 'cleanup', 'done', 'aborted'].map((x) => `player.admin.phase_${x}`),
    ...['off', 'all', 'one'].map((x) => `player.controls.repeat_${x}`),
    ...['file', 'embedded', 'lrclib'].map((x) => `player.lyrics.src.${x}`),
    ...['queue', 'lyrics', 'info'].map((x) => `player.panel.${x}`),
    ...['recentlyPlayed', 'jumpBackIn', 'recentlyAdded', 'newTracks', 'onRepeat', 'allTimeTop', 'topArtists', 'likedTracks', 'forgottenFavorites', 'neverPlayed', 'randomAlbums', 'yourArtists'].map((x) => `player.home.${x}`)
  ]
  for (const locale of LOCALES) {
    for (const key of dynamic) assert.equal(typeof messages[locale][key], 'string', `${locale}:${key}`)
  }
})

test('web player modules only import names their dependencies export', () => {
  const files = uiFiles()
  const exportsOf = new Map()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const names = new Set()
    for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)) names.add(m[1])
    for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((x) => names.add(x.trim().split(/\s+as\s+/).pop()))
    exportsOf.set(path.resolve(file), names)
  }
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
      const target = path.resolve(path.dirname(file), m[2])
      assert.ok(exportsOf.has(target), `${file} imports missing module ${m[2]}`)
      for (const name of m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        assert.ok(exportsOf.get(target).has(name), `${file} imports ${name} which ${m[2]} does not export`)
      }
    }
    for (const m of source.matchAll(/import\('([^']+)'\)/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${file} lazy-loads missing ${m[1]}`)
    }
  }
})

test('the player page is CSP-safe and the entry points are hidden until enabled', () => {
  const html = fs.readFileSync('public/player/index.html', 'utf8')
  // script-src 'self' only: no inline scripts or inline handlers.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/)
  assert.doesNotMatch(html, /\son[a-z]+=/i)
  for (const file of uiFiles()) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\binnerHTML\b|\beval\(|new Function\(/, file)

  for (const page of ['public/index.html', 'public/ytlive.html']) {
    const source = fs.readFileSync(page, 'utf8')
    assert.match(source, /<script src="\/ui\/player-link\.js" defer><\/script>/, page)
    assert.match(source, /href="\/player\/"[^>]*data-player-link[^>]*style="display:none"|data-player-link[^>]*style="display:none"/s, page)
  }
  const link = fs.readFileSync('public/ui/player-link.js', 'utf8')
  assert.match(link, /\/api\/player\/status/)
  assert.match(link, /status && status\.enabled/)
})
