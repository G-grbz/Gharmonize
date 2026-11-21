import { songKey } from './songKey.js'

// The library song a mapped song was downloaded as: the core matched the
// album / playlist song to a YouTube video (`links`, its mapping cache) and
// the file remembers that video. Exact even when the store lists another
// length than the downloaded recording has.
export function linkedTrack(matcher, links, song, userId) {
  if (!links?.length || !song) return null
  const id = song.id != null ? String(song.id) : ''
  const key = songKey(song.title, song.artist)
  const entry = links.find((link) => (id && link.sourceItemId === id) || (song.url && link.sourceItemUrl === song.url)) ||
    (key ? links.find((link) => songKey(link.sourceTitle, link.sourceArtist) === key) : null)
  return entry?.youtubeId ? matcher.findTrack({ url: `https://www.youtube.com/watch?v=${entry.youtubeId}` }, userId) : null
}

// Adds "already in your library" and "downloading now" badges to online items,
// so every client can show play / download / progress consistently. Library
// matches are per user: a song in a library you cannot see is not "yours".
export function createAnnotator({ matcher, bridge, catalog, mappedLinks = async () => [] }) {
  function libraryOf(item, userId) {
    if (item.kind === 'track') {
      const id = matcher.findTrack(item, userId)
      return id ? { trackId: id } : null
    }
    if (item.kind === 'album') {
      const album = matcher.findAlbum(item, userId)
      return album ? { albumId: album.id, trackCount: album.trackCount, complete: !item.trackCount || album.trackCount >= item.trackCount } : null
    }
    if (item.kind === 'artist') {
      const id = matcher.findArtist(item.title || item.artist, userId)
      return id ? { artistId: id } : null
    }
    return null
  }

  // The mapping cache of an album or playlist link (see linkedTrack).
  async function links(url) {
    try { return (await mappedLinks(url)) || [] } catch { return [] }
  }

  // `links`: the mapping cache of the album / playlist these songs belong to.
  function items(list = [], userId, { links: mapped = null } = {}) {
    const urls = list.filter((i) => i.kind !== 'artist').map((i) => i.url)
    const active = bridge.activeBySources(urls)
    const done = bridge.libraryBySources ? bridge.libraryBySources(urls, userId) : new Map()
    const annotated = list.map((item) => {
      let library = libraryOf(item, userId)
      // Metadata can differ between the store and the downloaded files
      // ("Wake Up" vs "Wake Up - Single"); an earlier download of this exact
      // link that is still in the library counts too.
      const ids = !library && done.get(item.url)
      if (ids?.length) {
        const albumId = item.kind === 'album' ? matcher.albumOfTrack?.(ids[0]) : null
        library = item.kind === 'track' ? { trackId: ids[0] } : { ...(albumId ? { albumId } : {}), trackIds: ids, trackCount: ids.length, complete: true }
      }
      if (!library && item.kind === 'track') {
        const id = linkedTrack(matcher, mapped, item, userId)
        if (id) library = { trackId: id }
      }
      return { ...item, library, download: active.get(item.url) || null }
    })
    if (catalog) {
      const ids = annotated.map((item) => item.library?.trackId).filter(Boolean)
      const tracks = new Map(catalog.getTracksByIds(ids, userId).map((track) => [track.id, track]))
      for (const item of annotated) {
        const track = tracks.get(item.library?.trackId)
        if (track) item.library.track = track
      }
    }
    return annotated
  }

  function shelves(list = [], userId) {
    return list.map((shelf) => ({ ...shelf, items: items(shelf.items, userId) }))
  }

  return { items, shelves, links }
}
