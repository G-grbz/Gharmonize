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

  fun pair(base: String, code: String, deviceName: String): JSONObject =
    send(base, "POST", "/pair", JSONObject().put("code", code).put("deviceName", deviceName).put("platform", "android"), auth = false)

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
  suspend fun discover(lang: String): JSONObject = get("/discover?lang=${enc(lang)}")
  suspend fun search(q: String): SearchResult {
    val o = get("/search?q=${enc(q)}&limit=30")
    return SearchResult(o.optJSONArray("tracks").mapObjects(::parseTrack), o.optJSONArray("albums").mapObjects(::parseAlbum), o.optJSONArray("artists").mapObjects(::parseArtist))
  }
  suspend fun onlineSearch(q: String): OnlineSearchResult {
    val o = get("/online/search?q=${enc(q)}&kinds=track,album,artist&limit=20")
    return OnlineSearchResult(o.optJSONArray("tracks").mapObjects(::parseOnline), o.optJSONArray("albums").mapObjects(::parseOnline), o.optJSONArray("artists").mapObjects(::parseOnline))
  }
  suspend fun albums(sort: String = "recent", offset: Int = 0) = get("/albums?sort=$sort&limit=60&offset=$offset").optJSONArray("items").mapObjects(::parseAlbum)
  suspend fun artists(offset: Int = 0) = get("/artists?sort=alpha&limit=100&offset=$offset").optJSONArray("items").mapObjects(::parseArtist)
  suspend fun tracks(query: String) = get("/tracks?$query").optJSONArray("items").mapObjects(::parseTrack)
  suspend fun createPlaylist(name: String, trackIds: List<Long> = emptyList()) = parsePlaylist(post("/playlists", JSONObject().put("name", name).put("trackIds", JSONArray(trackIds))))
  suspend fun playlists() = get("/playlists").optJSONArray("items").mapObjects(::parsePlaylist)
  suspend fun album(id: Long) = parseAlbum(get("/albums/$id"))
  suspend fun artist(id: Long) = parseArtist(get("/artists/$id"))
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

  suspend fun onlinePlaylist(item: OnlineItem): JSONObject = when (item.provider) {
    "youtube" -> get("/online/playlist?provider=youtube&url=${enc(item.url)}")
    else -> get("/online/playlist?provider=${item.provider}&id=${enc(item.id)}")
  }

  suspend fun onlineArtist(id: String?, name: String?): JSONObject =
    if (!id.isNullOrBlank()) get("/online/artist?id=${enc(id)}") else get("/online/artist?name=${enc(name ?: "")}")

  suspend fun requestDownload(item: OnlineItem): DownloadRow {
    val payload = JSONObject()
      .put("kind", if (item.kind == "album" || item.kind == "playlist") item.kind else "track")
      .put("url", item.url).put("title", item.title).put("artist", item.artist).put("album", item.album)
      .put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
      .put("isrc", item.raw.optString("isrc", ""))
      .put("duration", item.duration)
      .put("trackCount", item.trackCount ?: JSONObject.NULL)
    return parseDownload(post("/downloads", JSONObject().put("item", payload)))
  }

  suspend fun downloads() = get("/downloads?limit=100").optJSONArray("items").mapObjects(::parseDownload)
  suspend fun cancelDownload(id: String) = parseDownload(post("/downloads/${enc(id)}/cancel"))
  suspend fun retryDownload(id: String) = parseDownload(post("/downloads/${enc(id)}/retry"))
  suspend fun tracksByIds(ids: List<Long>) = post("/tracks/batch", JSONObject().put("ids", JSONArray(ids))).optJSONArray("items").mapObjects(::parseTrack)
}
