// Song identity helpers shared by matching, the catalog, mixes and stats.
// The same song often exists as several files (one per downloaded playlist);
// lists that show "songs" collapse those into one entry.

import { normalizeKey } from './scanner.js'

// Bracketed segments that describe a *version of the upload*, not the song.
const NOISE_RE = /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|hd|hq|4k|8k|mv|m\/v|clip|klip|sozleri|sarki sozleri|remaster(ed)?(\s+\d{4})?|\d{4}\s+remaster(ed)?|explicit|clean|topic|full song|music video|official music video|color coded)\b/
const VERSION_RE = /\b(live|canli|acoustic|akustik|remix|rmx|edit|instrumental|karaoke|cover|sped up|slowed|nightcore|version|demo|mix)\b/

// Folds a title for comparison: drops "(Official Video)" style noise and
// featuring credits but keeps meaningful version markers (live, remix...).
export function cleanTitleForMatch(title) {
  let text = String(title || '')
  text = text.replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner) => {
    const folded = normalizeKey(inner)
    if (/^(feat|ft|featuring|with)\b/.test(folded)) return ' '
    if (NOISE_RE.test(folded) && !VERSION_RE.test(folded)) return ' '
    return ` ${inner} `
  })
  text = normalizeKey(text)
  text = text.replace(/\s(feat|ft|featuring)\.?\s.*$/, '')
  text = text.replace(/\s[-–—|]\s*(official|lyrics?|audio|video|hd|4k).*$/, '')
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// "Sezen Aksu - Topic", "Sezen Aksu - 166M plays", "A, B & C" → "sezen aksu" / "a".
export function primaryArtistKey(artist) {
  let text = String(artist || '')
  text = text.replace(/\s[-•·]\s.*$/, '')
  text = text.split(/\s*(?:,|&|;|\/|\sx\s|\sve\s|\sand\s|\sfeat\.?\s|\sft\.?\s|\sfeaturing\s)\s*/i)[0]
  return normalizeKey(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** "title|artist" key that is equal for copies of the same recording. */
export function songKey(title, artist) {
  const t = cleanTitleForMatch(title)
  return t ? `${t}|${primaryArtistKey(artist)}` : ''
}

/** Keeps the first row of every song; `pick(row)` gives { title, artist }. */
export function uniqueSongs(rows, pick = (r) => ({ title: r.title, artist: r.artist_name ?? r.artist })) {
  const seen = new Set()
  return rows.filter((row) => {
    const { title, artist } = pick(row)
    const key = songKey(title, artist) || `id:${row.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
