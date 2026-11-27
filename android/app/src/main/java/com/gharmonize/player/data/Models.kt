package com.gharmonize.player.data

import org.json.JSONArray
import org.json.JSONObject

data class Track(
  val id: Long,
  val title: String,
  val artist: String,
  val artistId: Long?,
  val album: String,
  val albumId: Long?,
  val trackNo: Int?,
  val duration: Double,
  val artwork: String?,
  val favorite: Boolean,
  val lossless: Boolean,
  val codec: String?,
  val bitrate: Int?,
  val playCount: Int?,
  val genre: String? = null,
  val year: Int? = null,
  /** Every artist of "A, B" (only when there are several). */
  val artists: List<ArtistRef> = emptyList(),
  /** This song's entry in a playlist (to remove just that copy). */
  val entryId: Long? = null,
)

/** An artist of a song or album by several artists. */
data class ArtistRef(val id: Long, val name: String)

fun parseArtistRefs(o: JSONObject): List<ArtistRef> =
  o.optJSONArray("artists").mapObjects { a -> a.longOrNull("id")?.let { id -> ArtistRef(id, a.optString("name")) } }

data class Album(
  val id: Long,
  val title: String,
  val artist: String,
  val artistId: Long?,
  val year: Int?,
  val trackCount: Int,
  val duration: Double,
  val artwork: String?,
  val favorite: Boolean,
  val tracks: List<Track> = emptyList(),
  val artists: List<ArtistRef> = emptyList(),
)

data class Artist(
  val id: Long,
  val name: String,
  val trackCount: Int,
  val albumCount: Int,
  val artwork: String?,
  val favorite: Boolean,
  val albums: List<Album> = emptyList(),
  val appearsOn: List<Album> = emptyList(),
  val topTracks: List<Track> = emptyList(),
  val singles: List<Track> = emptyList(),
  /** Followed from an online page, no songs in the library (yet). */
  val onlineOnly: Boolean = false,
)

data class Playlist(
  val id: Long,
  val name: String,
  val description: String,
  val trackCount: Int,
  val duration: Double,
  val artwork: String?,
  val editable: Boolean,
  val owner: String,
  val tracks: List<Track> = emptyList(),
)

/** A Deezer / YouTube Music / Spotify result, badged with library state. */
data class OnlineItem(
  val provider: String,
  val kind: String,
  val id: String,
  val title: String,
  val artist: String,
  val album: String,
  val duration: Double,
  val artworkUrl: String?,
  val url: String,
  val previewUrl: String?,
  val trackCount: Int?,
  val libraryTrackId: Long?,
  val libraryAlbumId: Long?,
  val libraryArtistId: Long?,
  val libraryComplete: Boolean,
  val downloadId: String?,
  val downloadStatus: String?,
  val downloadProgress: Int,
  val raw: JSONObject,
) {
  val libraryTrack: Track? get() = raw.optJSONObject("library")?.optJSONObject("track")?.let(::parseTrack)
  val owned: Boolean get() = libraryTrackId != null || libraryAlbumId != null || libraryArtistId != null
  /** Mixes without a link the download pipeline can read (Deezer artist mixes): songs are downloaded one by one. */
  val downloadable: Boolean get() = raw.optBoolean("downloadable", true)
  val isMix: Boolean get() = !raw.isNull("mix") && raw.optString("mix").isNotBlank()
  /** Stable key for caches: mixes may have no url. */
  val key: String get() = url.ifBlank { "$provider:$kind:$id" }
}

/** Home shelf: either library items or online items. */
data class Shelf(
  val id: String,
  val title: String,
  val kind: String,
  val tracks: List<Track> = emptyList(),
  val albums: List<Album> = emptyList(),
  val artists: List<Artist> = emptyList(),
  val genres: List<String> = emptyList(),
  val online: List<OnlineItem> = emptyList(),
  val vars: JSONObject? = null,
)

data class LyricLine(val timeMs: Long, val text: String)
data class Lyrics(val synced: Boolean, val lines: List<LyricLine>, val plain: String)

data class DownloadRow(
  val id: String,
  val kind: String,
  val title: String,
  val artist: String,
  val artworkUrl: String?,
  val status: String,
  val progress: Int,
  val error: String?,
  val trackIds: List<Long>,
  val phase: String? = null,
  /** The download group (songs picked together) this song belongs to. */
  val groupId: String? = null,
  /** Album / playlist jobs: how many of their songs are done. */
  val steps: DownloadSteps? = null,
  /** Source and requested links (to find the row of an item). */
  val urls: List<String> = emptyList(),
  val createdAt: Long = 0,
) {
  val active: Boolean get() = status in setOf("queued", "resolving", "downloading", "indexing")
  /** A song still waiting in its group (over the queue limit), not requested yet. */
  val waiting: Boolean get() = id.startsWith(WAITING_PREFIX)

  companion object {
    const val WAITING_PREFIX = "waiting:"
    fun waitingIn(groupId: String, url: String) =
      DownloadRow("$WAITING_PREFIX$groupId", "track", "", "", null, "queued", 0, null, emptyList(), phase = "waiting", groupId = groupId, urls = listOf(url))
  }
}

data class DownloadSteps(val total: Int, val downloaded: Int, val converted: Int)

data class DownloadGroupCounts(
  val total: Int, val done: Int, val running: Int, val queued: Int, val waiting: Int,
  val failed: Int, val canceled: Int, val skipped: Int,
)

data class DownloadGroupCurrent(val title: String, val artist: String, val status: String, val phase: String?, val progress: Int)

/** Songs picked together: one entry with its progress. */
data class DownloadGroup(
  val id: String,
  val title: String?,
  val artworkUrl: String?,
  /** active | done | canceled */
  val status: String,
  val active: Boolean,
  val progress: Float,
  val counts: DownloadGroupCounts,
  val current: DownloadGroupCurrent?,
  val errors: List<String>,
  val pendingUrls: List<String>?,
  val createdAt: Long,
)

data class AlbumMissing(val found: Boolean, val total: Int, val missing: List<OnlineItem>, val onlineAlbum: OnlineItem?)

data class SearchResult(val tracks: List<Track>, val albums: List<Album>, val artists: List<Artist>)

/** A result picked from an earlier search: exactly one of the four is set. */
data class SearchPick(val key: String, val track: Track? = null, val album: Album? = null, val artist: Artist? = null, val online: OnlineItem? = null)

/** The user's own search history (same on every device). */
data class SearchHistory(val queries: List<String>, val items: List<SearchPick>)

fun parseSearchHistory(o: JSONObject): SearchHistory = SearchHistory(
  queries = o.optJSONArray("queries").mapObjects { it.optString("q").takeIf { q -> q.isNotBlank() } },
  items = o.optJSONArray("items").mapObjects { i ->
    val key = i.optString("key")
    when {
      i.optString("source") == "online" -> i.optJSONObject("item")?.let { SearchPick(key, online = parseOnline(it)) }
      i.optString("kind") == "track" -> i.optJSONObject("track")?.let { SearchPick(key, track = parseTrack(it)) }
      i.optString("kind") == "album" -> i.optJSONObject("album")?.let { SearchPick(key, album = parseAlbum(it)) }
      i.optString("kind") == "artist" -> i.optJSONObject("artist")?.let { SearchPick(key, artist = parseArtist(it)) }
      else -> null
    }
  },
)
data class OnlineSearchResult(val tracks: List<OnlineItem>, val albums: List<OnlineItem>, val artists: List<OnlineItem>, val playlists: List<OnlineItem> = emptyList())

/** Mixes (artist radios) and playlists made around one artist. */
data class ArtistMixes(val artist: String, val mixes: List<OnlineItem>, val playlists: List<OnlineItem>)

data class Me(val username: String, val displayName: String, val role: String, val canDownload: Boolean)

// ---- JSON parsing ------------------------------------------------------------------

private fun JSONObject.str(key: String): String = if (isNull(key)) "" else optString(key, "")
private fun JSONObject.strOrNull(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
private fun JSONObject.longOrNull(key: String): Long? = if (isNull(key) || !has(key)) null else optLong(key).takeIf { it > 0 }
private fun JSONObject.intOrNull(key: String): Int? = if (isNull(key) || !has(key)) null else optInt(key)

fun <T> JSONArray?.mapObjects(fn: (JSONObject) -> T?): List<T> {
  if (this == null) return emptyList()
  val out = ArrayList<T>(length())
  for (i in 0 until length()) optJSONObject(i)?.let { fn(it)?.let(out::add) }
  return out
}

fun parseTrack(o: JSONObject): Track = Track(
  id = o.optLong("id"),
  title = o.str("title"),
  artist = o.str("artist"),
  artistId = o.longOrNull("artistId"),
  album = o.str("album"),
  albumId = o.longOrNull("albumId"),
  trackNo = o.intOrNull("trackNo"),
  duration = o.optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it },
  artwork = o.strOrNull("artwork"),
  favorite = o.optBoolean("favorite"),
  lossless = o.optBoolean("lossless"),
  codec = o.strOrNull("codec"),
  bitrate = o.intOrNull("bitrate"),
  playCount = o.intOrNull("playCount"),
  genre = o.strOrNull("genre"),
  year = o.intOrNull("year")?.takeIf { it > 0 },
  artists = parseArtistRefs(o),
  entryId = o.longOrNull("entryId"),
)

fun parseAlbum(o: JSONObject): Album = Album(
  id = o.optLong("id"),
  title = o.str("title"),
  artist = o.str("artist"),
  artistId = o.longOrNull("artistId"),
  year = o.intOrNull("year")?.takeIf { it > 0 },
  trackCount = o.optInt("trackCount"),
  duration = o.optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it },
  artwork = o.strOrNull("artwork"),
  favorite = o.optBoolean("favorite"),
  tracks = o.optJSONArray("tracks").mapObjects(::parseTrack),
  artists = parseArtistRefs(o),
)

fun parseArtist(o: JSONObject): Artist = Artist(
  id = o.optLong("id"),
  name = o.str("name"),
  trackCount = o.optInt("trackCount"),
  albumCount = o.optInt("albumCount"),
  artwork = o.strOrNull("artwork"),
  favorite = o.optBoolean("favorite"),
  albums = o.optJSONArray("albums").mapObjects(::parseAlbum),
  appearsOn = o.optJSONArray("appearsOn").mapObjects(::parseAlbum),
  topTracks = o.optJSONArray("topTracks").mapObjects(::parseTrack),
  singles = o.optJSONArray("singles").mapObjects(::parseTrack),
  onlineOnly = o.has("trackCount") && o.optInt("trackCount") == 0,
)

fun parsePlaylist(o: JSONObject): Playlist = Playlist(
  id = o.optLong("id"),
  name = o.str("name"),
  description = o.str("description"),
  trackCount = o.optInt("trackCount"),
  duration = o.optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it },
  artwork = o.strOrNull("artwork"),
  editable = o.optBoolean("editable"),
  owner = o.optJSONObject("owner")?.str("displayName") ?: "",
  tracks = o.optJSONArray("tracks").mapObjects(::parseTrack),
)

fun parseOnline(o: JSONObject): OnlineItem {
  val lib = o.optJSONObject("library")
  val dl = o.optJSONObject("download")
  return OnlineItem(
    provider = o.str("provider"),
    kind = o.str("kind"),
    id = o.str("id"),
    title = o.str("title"),
    artist = o.str("artist"),
    album = o.str("album"),
    duration = o.optDouble("duration", 0.0).let { if (it.isNaN()) 0.0 else it },
    // Library songs among suggestions carry an artwork ref ("album/5") instead of a URL.
    artworkUrl = o.strOrNull("artworkUrl") ?: o.strOrNull("artwork"),
    url = o.str("url"),
    previewUrl = o.strOrNull("previewUrl"),
    trackCount = o.intOrNull("trackCount"),
    libraryTrackId = lib?.longOrNull("trackId"),
    libraryAlbumId = lib?.longOrNull("albumId"),
    libraryArtistId = lib?.longOrNull("artistId"),
    libraryComplete = lib?.optBoolean("complete") ?: false,
    downloadId = dl?.strOrNull("id"),
    downloadStatus = dl?.strOrNull("status"),
    downloadProgress = dl?.optInt("progress") ?: 0,
    raw = o,
  )
}

fun parseDownload(o: JSONObject): DownloadRow = DownloadRow(
  id = o.str("id"),
  kind = o.str("kind"),
  title = o.strOrNull("title") ?: o.str("sourceUrl"),
  artist = o.str("artist"),
  artworkUrl = o.strOrNull("artworkUrl"),
  status = o.str("status"),
  progress = o.optInt("progress"),
  error = o.optJSONObject("error")?.let { it.strOrNull("message") ?: it.strOrNull("code") },
  trackIds = o.optJSONArray("trackIds")?.let { arr -> (0 until arr.length()).map { arr.optLong(it) } } ?: emptyList(),
  phase = o.strOrNull("phase"),
  groupId = o.strOrNull("groupId"),
  steps = o.optJSONObject("steps")?.let { DownloadSteps(it.optInt("total"), it.optInt("downloaded"), it.optInt("converted")) }?.takeIf { it.total > 0 },
  urls = listOfNotNull(o.strOrNull("sourceUrl"), o.strOrNull("requestedUrl")),
  createdAt = o.optLong("createdAt"),
)

fun parseDownloadGroup(o: JSONObject): DownloadGroup {
  val c = o.optJSONObject("counts") ?: JSONObject()
  return DownloadGroup(
    id = o.str("id"),
    title = o.strOrNull("title"),
    artworkUrl = o.strOrNull("artworkUrl"),
    status = o.str("status"),
    active = o.optBoolean("active"),
    progress = o.optDouble("progress", 0.0).toFloat(),
    counts = DownloadGroupCounts(
      c.optInt("total"), c.optInt("done"), c.optInt("running"), c.optInt("queued"), c.optInt("waiting"),
      c.optInt("failed"), c.optInt("canceled"), c.optInt("skipped"),
    ),
    current = o.optJSONObject("current")?.let { DownloadGroupCurrent(it.str("title"), it.str("artist"), it.str("status"), it.strOrNull("phase"), it.optInt("progress")) },
    errors = o.optJSONArray("errors")?.let { arr ->
      (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let { e -> listOfNotNull(e.strOrNull("title"), e.strOrNull("message") ?: e.strOrNull("code")).joinToString(": ") } }
    } ?: emptyList(),
    pendingUrls = o.optJSONArray("pendingUrls")?.let { arr -> (0 until arr.length()).map { arr.optString(it) } },
    createdAt = o.optLong("createdAt"),
  )
}

fun parseLyrics(o: JSONObject): Lyrics = Lyrics(
  synced = o.optBoolean("synced"),
  lines = o.optJSONArray("lines").mapObjects { LyricLine(it.optLong("timeMs"), it.str("text")) },
  plain = o.str("plain"),
)

// ---- mixes & stats -------------------------------------------------------------------

data class Mix(
  val id: String,
  val kind: String,
  val number: Int,
  val decade: Int,
  val genre: String?,
  val artists: List<String>,
  val covers: List<String>,
  val trackCount: Int,
  val duration: Double,
)

fun parseMix(o: JSONObject): Mix {
  val vars = o.optJSONObject("titleVars")
  val artists = o.optJSONArray("artists")
  val covers = o.optJSONArray("covers")
  return Mix(
    id = o.optString("id"),
    kind = o.optString("kind"),
    number = vars?.optInt("n", 1) ?: 1,
    decade = vars?.optInt("decade", 0) ?: 0,
    genre = o.optString("genre").takeIf { !o.isNull("genre") && it.isNotBlank() },
    artists = (0 until (artists?.length() ?: 0)).map { artists!!.optString(it) },
    covers = (0 until (covers?.length() ?: 0)).map { covers!!.optString(it) },
    trackCount = o.optInt("trackCount"),
    duration = o.optDouble("duration", 0.0),
  )
}

data class RankedArtist(val id: Long, val name: String, val plays: Int, val minutes: Int, val artwork: String?)

data class ListeningStats(
  val year: Int?,
  val minutes: Int,
  val plays: Int,
  val uniqueTracks: Int,
  val uniqueArtists: Int,
  val topTracks: List<Pair<Track, Int>>,
  val topArtists: List<RankedArtist>,
  val topAlbums: List<Album>,
  val topGenres: List<Pair<String, Int>>,
  val hours: List<Int>,
  val weekdays: List<Int>,
  val busiestDay: String?,
  val busiestMinutes: Int,
  val streakCurrent: Int,
  val streakLongest: Int,
  val activeDays: Int,
  val newArtists: Int,
  val newArtistNames: List<String>,
  val traits: List<String>,
  val firstTrack: Track?,
)

private fun JSONArray?.ints(size: Int): List<Int> = (0 until size).map { this?.optInt(it) ?: 0 }

fun parseStats(o: JSONObject): ListeningStats {
  val busiest = o.optJSONObject("busiestDay")
  val streak = o.optJSONObject("streak")
  val newArtists = o.optJSONObject("newArtists")
  val names = newArtists?.optJSONArray("names")
  val traits = o.optJSONArray("traits")
  return ListeningStats(
    year = if (o.isNull("year")) null else o.optInt("year"),
    minutes = o.optInt("minutes"),
    plays = o.optInt("plays"),
    uniqueTracks = o.optInt("uniqueTracks"),
    uniqueArtists = o.optInt("uniqueArtists"),
    topTracks = o.optJSONArray("topTracks").mapObjects { parseTrack(it) to it.optInt("plays") },
    topArtists = o.optJSONArray("topArtists").mapObjects { RankedArtist(it.optLong("id"), it.optString("name"), it.optInt("plays"), it.optInt("minutes"), it.optString("artwork").ifBlank { null }) },
    topAlbums = o.optJSONArray("topAlbums").mapObjects { a ->
      Album(a.optLong("id"), a.optString("title"), a.optString("artist"), null, null, a.optInt("plays"), 0.0, a.optString("artwork").ifBlank { null }, favorite = false)
    },
    topGenres = o.optJSONArray("topGenres").mapObjects { it.optString("name") to it.optInt("plays") },
    hours = o.optJSONArray("hours").ints(24),
    weekdays = o.optJSONArray("weekdays").ints(7),
    busiestDay = busiest?.optString("date"),
    busiestMinutes = busiest?.optInt("minutes") ?: 0,
    streakCurrent = streak?.optInt("current") ?: 0,
    streakLongest = streak?.optInt("longest") ?: 0,
    activeDays = o.optInt("activeDays"),
    newArtists = newArtists?.optInt("count") ?: 0,
    newArtistNames = (0 until (names?.length() ?: 0)).map { names!!.optString(it) },
    traits = (0 until (traits?.length() ?: 0)).map { traits!!.optString(it) },
    firstTrack = o.optJSONObject("firstTrack")?.let(::parseTrack),
  )
}
