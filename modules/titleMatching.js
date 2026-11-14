// Small, dependency-free helpers for picking and matching song titles.

// Words that describe a recording (genre, format, version, promo) rather than
// name a song. Compared after folding (lowercase, no diacritics, ı→i).
const DESCRIPTOR_WORDS = new Set([
  'cover', 'covers', 'remix', 'remixes', 'version', 'versiyon', 'official', 'video', 'audio', 'lyric', 'lyrics',
  'sozleri', 'sozler', 'klip', 'clip', 'music', 'muzik', 'live', 'canli', 'akustik', 'acoustic', 'instrumental',
  'enstrumantal', 'karaoke', 'slowed', 'sped', 'reverb', 'nightcore', 'rock', 'pop', 'jazz', 'rap', 'hiphop',
  'arabesk', 'halk', 'turku', 'turkuler', 'anatolian', 'anadolu', 'psychedelic', 'psych', 'lofi', 'edm',
  'remaster', 'remastered', 'hd', 'hq', '4k', 'mv', 'visualizer', 'teaser', 'trailer', 'full', 'album',
  'playlist', 'mix', 'edit', 'extended', 'mashup', '8d', 'bass', 'boosted', 'tiktok', 'ai', 'prod', 'by',
  'feat', 'ft', 'and', 've', 'the', 'new', 'yeni', 'cover'
])

function fold(value = '') {
  return String(value || '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

// True when a title fragment only describes the recording, e.g.
// "Psychedelic Anatolian Rock Cover", "Official Video", "Canlı 2019".
export function isDescriptorPart(part = '') {
  const tokens = fold(part).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (!tokens.length) return true
  const hits = tokens.filter((t) => DESCRIPTOR_WORDS.has(t) || /^(19|20)\d{2}$/.test(t)).length
  return hits / tokens.length >= 0.6
}

// "A | B | C" titles: the song is usually the last part ("Channel | Song"),
// but not when that part only describes the recording
// ("Song | Psychedelic Anatolian Rock Cover"). Returns the last part that
// names something; falls back to the last part.
export function pickPipeTitlePart(title = '') {
  const parts = String(title || '').split('|').map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? String(title || '')
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isDescriptorPart(parts[i])) return parts[i]
  }
  return parts[parts.length - 1]
}

// The song name before annotations: "Song (Remastered)" → "Song",
// "Song - Live" → "Song".
export function baseSongTitle(title = '') {
  return String(title || '').split(/\s*[([{]|\s+[-–—]\s+/)[0].trim()
}

// A catalog "title contains" match is only plausible when the shorter title
// is (part of) the other one's actual song name, not just its annotation:
// "Song" ↔ "Song (Remastered 2011)" is fine, but "Psychedelic Anatolian Rock"
// ↔ "Esmerin Adı Oya (Psychedelic Anatolian Rock)" is a different song.
// `norm` is the caller's own normaliser so behaviour stays consistent.
export function isPlausibleContainsMatch(queryTitle, resultTitle, norm) {
  const q = norm(queryTitle)
  const r = norm(resultTitle)
  if (!q || !r) return false
  if (r.includes(q)) {
    const rb = norm(baseSongTitle(resultTitle))
    return Boolean(rb) && (rb.includes(q) || q.includes(rb))
  }
  if (q.includes(r)) {
    const qb = norm(baseSongTitle(queryTitle))
    return Boolean(qb) && (qb.includes(r) || r.includes(qb))
  }
  return false
}
