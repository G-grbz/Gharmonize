// Shared identity rules for classic previews, YT Live conversion and Player.
// Keep artist/title information together before cleaning release annotations.

export function cleanUploader(uploader = '') {
  let s = String(uploader).trim().replace(/\s+/g, ' ')
  s = s.replace(/\s*-\s*(topic)\s*$/i, '')
  s = s.replace(/\s*-\s*(official)(?:\s+(channel))?\s*$/i, '')
  s = s.replace(/\s+(official|topic)\s*$/i, '')
  s = s.replace(/\s*\((official)\)\s*$/i, '')
  s = s.replace(/\s+(?:and|&)\s+/gi, ', ')
  s = s.replace(/\s*,\s*/g, ', ')
  return s.trim()
}

function normalizeArtistTokens(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[&+]/g, ' and ')
    .replace(/[,/]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t !== 'and')
}

function looksLikeArtist(candidate = '', uploader = '') {
  const a = normalizeArtistTokens(candidate)
  const b = normalizeArtistTokens(uploader)
  if (!a.length || !b.length) return false
  const aSet = new Set(a)
  const bSet = new Set(b)
  let overlap = 0
  aSet.forEach((t) => { if (bSet.has(t)) overlap += 1 })
  return overlap >= Math.max(1, Math.ceil(Math.min(aSet.size, bSet.size) * 0.6))
}

export function parseTitleArtistPair(title = '', uploader = '') {
  const raw = String(title || '').trim()
  if (!raw) return null
  const extractPrimary = (value = '') =>
    String(value || '')
      .split(/\s*(?:[-–—|｜·•])\s*|\s+\bl\b\s+/gi)
      .map((p) => p.trim())
      .filter(Boolean)[0] || ''

  // Label uploads often use Song [Album © Label] - Artist, or
  // Song I Album © Label - Artist. Strip the release details after choosing
  // the order, otherwise the label becomes the artist.
  const releasePair = raw.match(/^(.+?)\s+[-–—]\s+([^–—]+)$/)
  if (releasePair && /[©]|\[[^\]]*(?:müzik|music|\d{4})|\s+[Iİ]\s+/.test(releasePair[1])) {
    const track = releasePair[1].split(/\s+[Iİ]\s+|\s*\[/)[0].trim()
    return { artist: cleanUploader(releasePair[2]), track }
  }
  const slashPair = raw.match(/^(.+?)\s+[/／_]\s+(.+)$/)
  if (slashPair) return { artist: cleanUploader(slashPair[1]), track: slashPair[2].trim() }

  const lParts = raw.split(/\s+\bl\b\s+/i).map((p) => p.trim()).filter(Boolean)
  if (lParts.length >= 2) {
    const left = (lParts[0] || '').trim()
    const right = cleanUploader((lParts[1] || '').trim())
    if (!left || !right) return null
    return { artist: left, track: right }
  }

  const m = raw.match(/^(.+?)\s*[-–—_]\s+(.+)$/)
  if (!m) return null
  const left = (m[1] || '').trim()
  const right = (m[2] || '').trim()
  if (!left || !right) return null
  const rightHasExtraParts = !/[([]/.test(right) && /(?:\s+[-–—|｜·•]\s+|\s+\bl\b\s+)/i.test(right)
  if (rightHasExtraParts) {
    const rightPrimary = extractPrimary(right)
    return { artist: left, track: rightPrimary || right }
  }

  const cleanedUploader = cleanUploader(uploader || '')
  if (cleanedUploader && !/(?:müzik|muzik|music|records?|label|productions?|yapım|yapim)/i.test(cleanedUploader)) {
    const leftLooksArtist = looksLikeArtist(left, cleanedUploader)
    const rightLooksArtist = looksLikeArtist(right, cleanedUploader)
    if (leftLooksArtist && !rightLooksArtist) return { artist: left, track: right }
    if (rightLooksArtist && !leftLooksArtist) return { artist: right, track: left }
  }
  return { artist: left, track: right }
}

function cleanReleaseTitle(value) {
  return String(value || '').replace(/\s*\[[^\]]*©[^\]]*\].*$/, '').replace(/\s+[Iİ]\s+[^]*©[^]*$/, '').trim()
}

export function pickTrackTitle(item) {
  const rawTitle = (item?.title || '').toString().trim()
  if (!rawTitle) return ''

  const uploader = cleanUploader(item?.uploader || item?.channel || '')
  const pair = parseTitleArtistPair(rawTitle, uploader)
  if (pair?.track) return cleanReleaseTitle(pair.track)

  const parts = rawTitle
    .split(/\s*(?:[-–—|｜·•])\s*|\s+\bl\b\s+/gi)
    .map((p) => p.trim())
    .filter(Boolean)

  if (parts.length >= 3) return parts.slice(0, -1).join(' - ')
  if (parts.length < 2) return rawTitle

  const uploaderIdx = parts.findIndex((p) => looksLikeArtist(p, uploader))
  if (uploaderIdx >= 0) {
    const candidates = parts.filter((_, i) => i !== uploaderIdx)
    if (!candidates.length) return rawTitle
    return candidates.sort((a, b) => b.length - a.length)[0]
  }
  if (looksLikeArtist(parts[0], uploader)) return parts[parts.length - 1]
  if (looksLikeArtist(parts[parts.length - 1], uploader)) return parts[0]
  return parts[0]
}

export function pickTrackArtist(item) {
  if (item?.artist && item?.track) return cleanUploader(item.artist)
  const pair = parseTitleArtistPair(item?.title, item?.uploader)
  return cleanUploader(pair?.artist || item?.artist || item?.uploader || item?.channel || '')
}

// Same shape the classic "download all" button sends (PreviewManager).
export function toFrozenEntries(items = []) {
  return items.map((item, i) => ({
    ...item,
    index: item.index || i + 1,
    id: item.id || null,
    title: item.track || pickTrackTitle(item),
    uploader: pickTrackArtist(item),
    artist: pickTrackArtist(item),
    duration: item.duration || null,
    webpage_url: item.webpage_url || ''
  }))
}
