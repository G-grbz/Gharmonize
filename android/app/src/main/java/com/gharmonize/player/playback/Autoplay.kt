package com.gharmonize.player.playback

import androidx.media3.common.MediaItem
import com.gharmonize.player.data.Api
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseOnline
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.text.Normalizer
import java.util.Locale

private val marks = Regex("\\p{M}+")
private val separators = Regex("[^\\p{L}\\p{N}]+")

private fun musicName(value: String): String =
  Normalizer.normalize(value.lowercase(Locale.ROOT).replace('ı', 'i'), Normalizer.Form.NFD)
    .replace(marks, "").replace(separators, " ").trim()

private fun songKey(artist: String, title: String) = musicName(artist) to musicName(title)

private val creditSplit = Regex(
  "\\s*(?:,|&|;|/|\\sx\\s|\\sve\\s|\\sand\\s|\\svs\\.?\\s|\\swith\\s|\\sfeat\\.?\\s|\\sft\\.?\\s|\\sfeaturing\\s)\\s*",
  RegexOption.IGNORE_CASE
)
private val bylineSuffix = Regex("\\s[-•·]\\s.*$")

/** Every name of an artist credit, folded: "A, B feat. C" → {a, b, c}. */
private fun credits(artist: String): List<String> =
  artist.replace(bylineSuffix, "").split(creditSplit).map { it.trim() }.filter { it.isNotEmpty() }

private fun creditKeys(artist: String): Set<String> = credits(artist).map(::musicName).filter { it.isNotEmpty() }.toSet()

private suspend fun <T> optionalAutoplayLookup(block: suspend () -> T): T? = try {
  block()
} catch (cancelled: CancellationException) {
  throw cancelled
} catch (_: Exception) {
  null
}

internal suspend fun autoplayItems(api: Api, current: MediaItem, queue: List<MediaItem>): List<MediaItem> {
  val artist = current.mediaMetadata.artist?.toString().orEmpty()
  val genre = current.mediaMetadata.genre?.toString().orEmpty()
    .takeUnless { musicName(it) in setOf("music", "muzik", "other", "unknown") }.orEmpty()
  val artistKey = musicName(artist)
  val artistCredits = creditKeys(artist)
  val genreKey = musicName(genre)
  val seedId = current.mediaId.takeIf { it.startsWith("t:") }?.removePrefix("t:")?.toLongOrNull()
  if (seedId == null && artistKey.isEmpty() && genreKey.isEmpty()) return emptyList()

  val ids = queue.map { it.mediaId }.toMutableSet()
  val songs = queue.map {
    songKey(it.mediaMetadata.artist?.toString().orEmpty(), it.mediaMetadata.title?.toString().orEmpty())
  }.toMutableSet()
  val libraryIds = ids.mapNotNull { id -> id.takeIf { it.startsWith("t:") }?.removePrefix("t:")?.toLongOrNull() }
  // Same artist also inside collaborations ("A, B" ↔ "A"), or same genre.
  fun related(track: Track) =
    (artistCredits.isNotEmpty() && creditKeys(track.artist).any { it in artistCredits }) ||
      (genreKey.isNotEmpty() && musicName(track.genre.orEmpty()) == genreKey)
  fun libraryItems(tracks: List<Track>): List<MediaItem> = tracks.asSequence()
    .filter { it.id > 0 && "t:${it.id}" !in ids && songs.add(songKey(it.artist, it.title)) }
    .distinctBy { it.id }
    .take(15)
    .map { PlayerController.trackItem(it, auto = true) }
    .toList()

  // The server ranks the continuation itself (same artist incl.
  // collaborations, related artists, genre, listened songs first) and tops
  // it up from the library, so its order is kept as it is.
  val fromServer = optionalAutoplayLookup { api.autoplay(seedId, libraryIds, artist, genre) }.orEmpty()
  val continuation = libraryItems(fromServer)
  if (continuation.isNotEmpty()) return continuation
  val recent = libraryItems(optionalAutoplayLookup { api.recent() }.orEmpty().filter(::related))
  if (recent.isNotEmpty()) return recent

  // Older servers require a library seed for /autoplay. Search their normal
  // library endpoints and rank already played songs first.
  val library = coroutineScope {
    val byArtist = async {
      if (artistKey.isEmpty()) emptyList() else optionalAutoplayLookup { api.search(artist).tracks }.orEmpty()
    }
    val byGenre = async {
      if (genreKey.isEmpty()) emptyList() else optionalAutoplayLookup { api.autoplayGenreTracks(genre) }.orEmpty()
    }
    (byArtist.await() + byGenre.await()).sortedByDescending { it.playCount ?: 0 }
  }
  val fallback = libraryItems(library.filter(::related))
  if (fallback.isNotEmpty() || artistKey.isEmpty()) return fallback

  // When the library has no match, continue with playable tracks from the
  // artist's catalogue. Unowned entries stay previews.
  fun playable(entries: List<OnlineItem>): List<MediaItem> = entries.mapNotNull { entry ->
    val media = PlayerController.onlineItem(entry, auto = true) ?: return@mapNotNull null
    media.takeIf { ids.add(media.mediaId) && songs.add(songKey(entry.artist, entry.title)) }
  }
  // A collaboration may be unknown online as a whole: try its first name too.
  val detail = optionalAutoplayLookup { api.onlineArtist(id = null, name = artist) }
    ?: credits(artist).firstOrNull()?.takeIf { musicName(it) != artistKey }
      ?.let { lead -> optionalAutoplayLookup { api.onlineArtist(id = null, name = lead) } }
  val top = detail?.optJSONArray("topTracks").mapObjects(::parseOnline)
  val sameArtist = playable(top.filter { creditKeys(it.artist).any { key -> key in artistCredits } })
  if (sameArtist.size >= 5) return sameArtist.take(15)
  val relatedArtists = detail?.optJSONArray("related").mapObjects(::parseOnline)
    .filter { it.id.isNotBlank() }.take(2)
  val extra = if (relatedArtists.isNotEmpty()) coroutineScope {
    relatedArtists.map { entry ->
      async { optionalAutoplayLookup { api.onlineArtist(id = entry.id, name = null) }
        ?.optJSONArray("topTracks").mapObjects(::parseOnline).take(5) }
    }.awaitAll().flatten()
  } else {
    optionalAutoplayLookup { api.autoplayOnlineTracks(artist) }.orEmpty()
      .filter { creditKeys(it.artist).any { key -> key in artistCredits } }
  }
  return (sameArtist + playable(extra)).take(15)
}
