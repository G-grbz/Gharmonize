package com.gharmonize.player

import android.app.Application
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import com.gharmonize.player.data.Api
import com.gharmonize.player.data.Prefs
import com.gharmonize.player.data.ServerManager
import com.gharmonize.player.ui.ImageLoader
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.IOException

/**
 * App-wide services. Media URIs use a private "ghp://" scheme
 * (ghp://stream/123, ghp://artwork/album/5?size=512) that is resolved to the
 * currently reachable server only when it is opened, so playback keeps working
 * when the phone moves between the home network and Tailscale.
 */
class App : Application() {
  lateinit var prefs: Prefs
  lateinit var servers: ServerManager
  lateinit var api: Api
  lateinit var images: ImageLoader
  /** Bumped when the server rejects the device token → UI shows sign-in. */
  val signedOut = MutableStateFlow(0)

  override fun attachBaseContext(base: android.content.Context) {
    super.attachBaseContext(AppLocale.wrap(base))
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    prefs = Prefs(this)
    servers = ServerManager(this, prefs)
    api = Api(servers, prefs) {
      prefs.signOut()
      signedOut.value = signedOut.value + 1
    }
    images = ImageLoader(this)
    com.gharmonize.player.playback.AudioEq.load(prefs)
  }

  fun streamQuality(): String = if (servers.isMetered()) prefs.qualityMobile else prefs.qualityWifi

  /** ghp:// → http(s)://<current server>/api/player/…, plus the auth header. */
  fun resolveUrl(uri: Uri): Pair<String, Map<String, String>>? {
    if (uri.scheme != SCHEME) return null
    val base = servers.currentBlocking() ?: throw IOException("Gharmonize server unreachable")
    val headers = prefs.token?.let { mapOf("Authorization" to "Bearer $it") } ?: emptyMap()
    val url = when (uri.host) {
      "stream" -> {
        val q = streamQuality()
        "$base/api/player/stream${uri.encodedPath}" + if (q != "original") "?quality=$q" else ""
      }
      "artwork" -> "$base/api/player/artwork${uri.encodedPath}?size=${uri.getQueryParameter("size") ?: "512"}"
      // Deezer preview links expire within minutes: ask the server for a fresh
      // one right before loading. The CDN gets no auth header.
      "preview" -> return freshPreview(base, uri.encodedPath.orEmpty(), headers) to emptyMap()
      else -> throw IOException("Unknown media URI: $uri")
    }
    return url to headers
  }

  /** Runs on the player's loading thread, so a blocking request is fine here. */
  private fun freshPreview(base: String, path: String, headers: Map<String, String>): String {
    val conn = (java.net.URL("$base/api/player/online/preview$path?format=json").openConnection() as java.net.HttpURLConnection).apply {
      connectTimeout = 10_000
      readTimeout = 15_000
      headers.forEach { (k, v) -> setRequestProperty(k, v) }
      setRequestProperty("Accept", "application/json")
    }
    try {
      if (conn.responseCode !in 200..299) throw IOException("Preview unavailable (HTTP ${conn.responseCode})")
      val url = org.json.JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).optString("url")
      if (!url.startsWith("https://")) throw IOException("Preview unavailable")
      return url
    } finally {
      conn.disconnect()
    }
  }

  @UnstableApi
  fun resolveDataSpec(spec: DataSpec): DataSpec {
    val (url, headers) = resolveUrl(spec.uri) ?: return spec
    return spec.withUri(Uri.parse(url)).withAdditionalHeaders(headers)
  }

  companion object {
    const val SCHEME = "ghp"
    lateinit var instance: App
      private set

    fun streamUri(trackId: Long): Uri = Uri.parse("$SCHEME://stream/$trackId")
    fun previewUri(provider: String, id: String): Uri = Uri.parse("$SCHEME://preview/$provider/${Uri.encode(id)}")
    fun artworkUri(ref: String?, size: Int = 512): Uri? =
      ref?.takeIf { it.isNotBlank() }?.let { if (it.startsWith("http")) Uri.parse(it) else Uri.parse("$SCHEME://artwork/$it?size=$size") }
  }
}
