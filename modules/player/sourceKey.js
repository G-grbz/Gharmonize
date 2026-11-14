export function youtubeSourceKey(value) {
  try {
    const u = new URL(String(value || ''))
    const host = u.hostname.toLowerCase()
    let id = null
    if (host === 'youtu.be') id = u.pathname.split('/')[1]
    else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1]
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? `youtube:${id}` : null
  } catch { return null }
}

export function metadataSourceKey(meta) {
  const website = meta?.common?.website
  const values = Array.isArray(website) ? [...website] : [website]
  for (const tags of Object.values(meta?.native || {})) {
    for (const tag of tags || []) {
      if (/^(?:WXXX(?::SOURCE_URL)?|WOAS|(?:TXXX:|----:com\.apple\.iTunes:)?(?:URL|SOURCE_URL)|WEBSITE)$/i.test(tag.id)) {
        values.push(typeof tag.value === 'object' ? tag.value?.url : tag.value)
      }
    }
  }
  return values.map(youtubeSourceKey).find(Boolean) || null
}
