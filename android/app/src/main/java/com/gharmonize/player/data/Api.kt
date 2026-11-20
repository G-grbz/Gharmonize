package com.gharmonize.player.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class ApiException(val status: Int, val code: String, message: String) : Exception(message)

/** Gharmonize Player API client (device token, automatic server choice). */
class Api(private val servers: ServerManager, private val prefs: Prefs, private val onUnauthorized: () -> Unit) {

  // ---- low level ------------------------------------------------------------------

  suspend fun request(method: String, path: String, body: JSONObject? = null, auth: Boolean = true): JSONObject =
    withContext(Dispatchers.IO) {
      var last: Exception? = null
      repeat(2) {
        val base = servers.current() ?: throw ApiException(0, "SERVER_UNREACHABLE", "Server unreachable")
        try {
          return@withContext send(base, method, path, body, auth)
        } catch (e: IOException) {
          // Network changed (home ↔ away): pick another address and retry once.
          last = e
          servers.invalidate()
        }
      }
      throw ApiException(0, "SERVER_UNREACHABLE", last?.message ?: "Server unreachable")
    }

  /** Talks to one specific address (used while pairing, before it is saved). */
  fun send(base: String, method: String, path: String, body: JSONObject?, auth: Boolean = true): JSONObject {
    val conn = URL("$base/api/player$path").openConnection() as HttpURLConnection
    try {
      conn.requestMethod = method
      conn.connectTimeout = 8000
      conn.readTimeout = 30000
      conn.setRequestProperty("Accept", "application/json")
      if (auth) prefs.token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
      if (body != null) {
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
      }
      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
      val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
      if (code >= 400) {
        val err = json.optJSONObject("error")
        val errCode = err?.optString("code") ?: "HTTP_$code"
        if (code == 401 && auth && errCode == "PLAYER_AUTH_REQUIRED") onUnauthorized()
        throw ApiException(code, errCode, err?.optString("message") ?: "HTTP $code")
      }
      return json
    } finally {
      conn.disconnect()
    }
  }

  private suspend fun get(path: String) = request("GET", path)
  private suspend fun post(path: String, body: JSONObject = JSONObject()) = request("POST", path, body)

  private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")

  // ---- auth -----------------------------------------------------------------------

  fun pair(base: String, code: String, deviceName: String, platform: String = "android"): JSONObject =
    send(base, "POST", "/pair", JSONObject().put("code", code).put("deviceName", deviceName).put("platform", platform), auth = false)

  /** One-time code that lets another device (a TV) sign in to this account. */
  suspend fun createPairingCode(): String = post("/me/pairing-code").getString("code")

  fun login(base: String, username: String, password: String, deviceName: String): JSONObject =
    send(base, "POST", "/auth/login", JSONObject()
      .put("username", username).put("password", password)
      .put("client", "device").put("deviceName", deviceName).put("platform", "android"), auth = false)

  suspend fun logout() = runCatching { post("/auth/logout") }

  /** Addresses this server can currently be reached at (home network, tunnel…). */
  suspend fun reachableAddresses(): List<String> =
    get("/connect").optJSONArray("addresses").mapObjects { o -> if (o.optBoolean("blocked")) null else o.optString("url").takeIf { it.startsWith("http") } }

  suspend fun me(): Me {
    val o = get("/me")
    val u = o.getJSONObject("user")
    return Me(u.optString("username"), u.optString("displayName"), u.optString("role"), o.optJSONObject("permissions")?.optBoolean("canDownload") ?: false)
  }

  // ---- library --------------------------------------------------------------------

  suspend fun home(): JSONObject = get("/home")
  /** round: bumped by the refresh button for another pick of artists today. */
  suspend fun discover(lang: String, round: Int = 0): JSONObject = get("/discover?lang=${enc(lang)}&round=$round")
  suspend fun search(q: String): SearchResult {
    val o = get("/search?q=${enc(q)}&limit=30")
    return SearchResult(o.optJSONArray("tracks").mapObjects(::parseTrack), o.optJSONArray("albums").mapObjects(::parseAlbum), o.optJSONArray("artists").mapObjects(::parseArtist))
  }
  suspend fun onlineSearch(q: String): OnlineSearchResult {
    val o = get("/online/search?q=${enc(q)}&kinds=track,album,artist&limit=20")
    return OnlineSearchResult(o.optJSONArray("tracks").mapObjects(::parseOnline), o.optJSONArray("albums").mapObjects(::parseOnline), o.optJSONArray("artists").mapObjects(::parseOnline))
  }
  /** Asked after the main results so playlists never hold them back. */
  suspend fun onlinePlaylists(q: String): List<OnlineItem> =
    get("/online/search?q=${enc(q)}&kinds=playlist&limit=20").optJSONArray("playlists").mapObjects(::parseOnline)
  suspend fun artistMixes(name: String, lang: String): ArtistMixes {
    val o = get("/online/artist-mixes?name=${enc(name)}&lang=${enc(lang)}")
    return ArtistMixes(o.optString("artist", name), o.optJSONArray("mixes").mapObjects(::parseOnline), o.optJSONArray("playlists").mapObjects(::parseOnline))
  }
  suspend fun albums(sort: String = "recent", offset: Int = 0) = get("/albums?sort=$sort&limit=60&offset=$offset").optJSONArray("items").mapObjects(::parseAlbum)
  suspend fun artists(offset: Int = 0, followed: Boolean = false) =
    get("/artists?sort=alpha&limit=${if (followed) 500 else 100}&offset=$offset" + if (followed) "&favorites=1" else "").optJSONArray("items").mapObjects(::parseArtist)
  suspend fun tracks(query: String) = get("/tracks?$query").optJSONArray("items").mapObjects(::parseTrack)
  suspend fun createPlaylist(name: String, trackIds: List<Long> = emptyList()) = parsePlaylist(post("/playlists", JSONObject().put("name", name).put("trackIds", JSONArray(trackIds))))
  suspend fun playlists() = get("/playlists").optJSONArray("items").mapObjects(::parsePlaylist)
  suspend fun album(id: Long) = parseAlbum(get("/albums/$id"))
  suspend fun artist(id: Long) = parseArtist(get("/artists/$id"))
  /** Every song of the artist in the library. sort: album | alpha | recent | plays */
  suspend fun artistTracks(id: Long, sort: String) = get("/artists/$id/tracks?sort=${enc(sort)}&limit=500").optJSONArray("items").mapObjects(::parseTrack)
  suspend fun playlist(id: Long) = parsePlaylist(get("/playlists/$id"))
  suspend fun recent() = get("/history/recent?limit=50").optJSONArray("items").mapObjects(::parseTrack)
  suspend fun mixes() = get("/mixes").optJSONArray("items").mapObjects(::parseMix)
  suspend fun mix(id: String): Pair<Mix, List<Track>> {
    val o = get("/mixes/${enc(id)}")
    return parseMix(o) to o.optJSONArray("tracks").mapObjects(::parseTrack)
  }
  suspend fun mixOnline(id: String) = get("/mixes/${enc(id)}/online").optJSONArray("items").mapObjects(::parseOnline)
  suspend fun stats(range: String) = parseStats(get("/stats/listening?range=${enc(range)}"))
  suspend fun statYears() = get("/stats/years").optJSONArray("items").let { a -> (0 until (a?.length() ?: 0)).map { a!!.optInt(it) } }
  suspend fun wrapped(year: Int) = parseStats(get("/stats/wrapped?year=$year"))
  suspend fun lyrics(trackId: Long): Lyrics? = try { parseLyrics(get("/tracks/$trackId/lyrics")) } catch (e: ApiException) { if (e.status == 404) null else throw e }

  /** Real waveform of a library track: 0..1 values (null when unavailable). */
  suspend fun waveform(trackId: Long): FloatArray? = try {
    val bins = get("/waveform/$trackId").optJSONArray("bins")
    bins?.takeIf { it.length() > 0 }?.let { arr -> FloatArray(arr.length()) { (arr.optDouble(it, 0.0) / 100.0).toFloat().coerceIn(0f, 1f) } }
  } catch (e: ApiException) { if (e.status in 400..499) null else throw e }

  /** Follow an artist (new releases are announced / downloaded for followed artists). */
  suspend fun setArtistFollowed(artistId: Long, value: Boolean) {
    request(if (value) "PUT" else "DELETE", "/favorites/artist/$artistId")
  }

  /** Follow an artist by name from an online page (also artists with no songs here yet). */
  suspend fun setOnlineArtistFollowed(name: String, deezerId: String?, value: Boolean): Boolean {
    val res = if (value) request("PUT", "/follows/artists", JSONObject().put("name", name).put("deezerId", deezerId ?: JSONObject.NULL))
      else request("DELETE", "/follows/artists?name=${enc(name)}")
    return res.optBoolean("favorite", value)
  }

  suspend fun setFavorite(trackId: Long, value: Boolean) {
    request(if (value) "PUT" else "DELETE", "/favorites/track/$trackId")
  }

  suspend fun addToPlaylist(playlistId: Long, trackIds: List<Long>) {
    post("/playlists/$playlistId/tracks", JSONObject().put("trackIds", JSONArray(trackIds)))
  }

  suspend fun recordPlay(trackId: Long, playedMs: Long, completed: Boolean) {
    post("/history", JSONObject().put("trackId", trackId).put("playedMs", playedMs).put("completed", completed).put("context", "android"))
  }

  // ---- online detail & downloads --------------------------------------------------

  suspend fun onlineAlbum(item: OnlineItem): JSONObject = when (item.provider) {
    "youtube" -> get("/online/album?provider=youtube&url=${enc(item.url)}&artist=${enc(item.artist)}")
    else -> get("/online/album?provider=${item.provider}&id=${enc(item.id)}")
  }

  /** Songs of a library album that are not in the library yet (Deezer). */
  suspend fun albumMissing(id: Long): AlbumMissing {
    val o = get("/albums/$id/missing")
    val arr = o.optJSONArray("missing")
    val missing = if (arr == null) emptyList() else (0 until arr.length()).mapNotNull { arr.optJSONObject(it)?.let(::parseOnline) }
    return AlbumMissing(o.optBoolean("found"), o.optInt("total"), missing, o.optJSONObject("album")?.let(::parseOnline))
  }

  suspend fun onlinePlaylist(item: OnlineItem): JSONObject = when {
    item.raw.optString("mix") == "deezer" -> get("/online/playlist?provider=deezer&mix=artist&id=${enc(item.raw.optString("mixId"))}")
    item.provider == "youtube" || item.provider == "apple" -> get("/online/playlist?provider=${item.provider}&url=${enc(item.url)}")
    else -> get("/online/playlist?provider=${item.provider}&id=${enc(item.id)}")
  }

  suspend fun notifications(): JSONObject = get("/notifications?limit=50")
  suspend fun markNotificationsRead() { post("/notifications/read") }
  suspend fun releaseSettings(): JSONObject = get("/releases/settings")
  suspend fun setReleaseAutoDownload(value: Boolean) { request("PUT", "/releases/settings", JSONObject().put("autoDownload", value)) }

  /** Ties an online playlist to a player playlist that is kept in sync daily. */
  suspend fun followPlaylist(item: OnlineItem): JSONObject {
    val body = JSONObject().put("provider", item.provider).put("id", item.id).put("url", item.url).put("title", item.title)
      .put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
    if (!item.raw.isNull("mix") && item.raw.optString("mix").isNotBlank()) body.put("mix", item.raw.optString("mix"))
    return post("/follows/playlists", body)
  }

  /** Artist biography (Wikipedia, language order chosen on the server); null when none. */
  suspend fun artistBio(name: String, deezerId: String?, lang: String): JSONObject? =
    get("/online/artist-bio?name=${enc(name)}&lang=${enc(lang)}" + (deezerId?.let { "&deezerId=${enc(it)}" } ?: "")).optJSONObject("bio")

  /** A mood's playlists / albums and songs (YouTube Music). */
  suspend fun mood(preset: String, lang: String): JSONObject = get("/discover/mood/${enc(preset)}?lang=${enc(lang)}")

  suspend fun onlineArtist(id: String?, name: String?): JSONObject =
    if (!id.isNullOrBlank()) get("/online/artist?id=${enc(id)}") else get("/online/artist?name=${enc(name ?: "")}")

  /** Songs that fit a playlist: library songs and new ones in one list. */
  suspend fun playlistSuggestions(id: Long, round: Int = 0) = get("/playlists/$id/suggestions?round=$round").optJSONArray("items").mapObjects(::parseOnline)

  /** Library songs like the given ones, to keep playing at the end of the queue. */
  suspend fun autoplay(seed: Long?, exclude: List<Long>, artist: String, genre: String): List<Track> =
    get("/autoplay?seed=${seed ?: ""}&artist=${enc(artist)}&genre=${enc(genre)}&exclude=${exclude.takeLast(200).joinToString(",")}&limit=15").optJSONArray("items").mapObjects(::parseTrack)

  suspend fun autoplayGenreTracks(genre: String): List<Track> =
    tracks("genre=${enc(genre)}&limit=30")

  suspend fun autoplayOnlineTracks(artist: String): List<OnlineItem> =
    get("/online/search?q=${enc(artist)}&kinds=track&limit=20").optJSONArray("tracks").mapObjects(::parseOnline)

  suspend fun requestDownload(item: OnlineItem, playlistId: Long? = null): DownloadRow {
    val payload = JSONObject()
      .put("kind", if (item.kind == "album" || item.kind == "playlist") item.kind else "track")
      .put("url", item.url).put("title", item.title).put("artist", item.artist).put("album", item.album)
      .put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
      .put("isrc", item.raw.optString("isrc", ""))
      .put("duration", item.duration)
      .put("trackCount", item.trackCount ?: JSONObject.NULL)
    val body = JSONObject().put("item", payload)
    if (playlistId != null) body.put("playlistId", playlistId)
    return parseDownload(post("/downloads", body))
  }

  suspend fun downloads() = get("/downloads?limit=100").optJSONArray("items").mapObjects(::parseDownload)
  suspend fun cancelDownload(id: String) = parseDownload(post("/downloads/${enc(id)}/cancel"))
  suspend fun retryDownload(id: String) = parseDownload(post("/downloads/${enc(id)}/retry"))
  suspend fun tracksByIds(ids: List<Long>) = post("/tracks/batch", JSONObject().put("ids", JSONArray(ids))).optJSONArray("items").mapObjects(::parseTrack)
}
