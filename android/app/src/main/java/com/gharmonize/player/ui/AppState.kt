package com.gharmonize.player.ui

import android.content.Context
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.ApiException
import com.gharmonize.player.data.DownloadRow
import com.gharmonize.player.data.Me
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track
import com.gharmonize.player.playback.PlayerController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

sealed interface Route {
  data object Home : Route
  data object Search : Route
  data object Library : Route
  data object Playlists : Route
  data object Downloads : Route
  data object Settings : Route
  data object Liked : Route
  data object NowPlaying : Route
  data class Album(val id: Long) : Route
  data class Artist(val id: Long) : Route
  data class Playlist(val id: Long) : Route
  data class OnlineAlbum(val item: OnlineItem) : Route
  data class OnlineArtist(val id: String?, val name: String?) : Route
  data object Stats : Route
  data class Mix(val id: String) : Route
  data class Wrapped(val year: Int) : Route
  data object Equalizer : Route
}

/** UI state shared by all screens: navigation, player, downloads, messages. */
class AppState(private val context: Context, val scope: CoroutineScope, val player: PlayerController) {
  val app get() = App.instance
  val api get() = app.api
  val snackbar = SnackbarHostState()

  val stack = mutableStateListOf<Route>(Route.Home)
  val top: Route get() = stack.last()

  var me by mutableStateOf<Me?>(null)
  val canDownload: Boolean get() = me?.canDownload == true

  /** Live download state by source URL, for the badges on online items. */
  val downloadsByUrl = mutableStateMapOf<String, DownloadRow>()
  var downloads by mutableStateOf<List<DownloadRow>>(emptyList())
  private var poller: Job? = null

  fun navigate(route: Route) {
    if (route in listOf(Route.Home, Route.Search, Route.Library, Route.Downloads, Route.Settings)) {
      stack.clear()
      stack.add(route)
    } else {
      stack.add(route)
    }
  }

  fun back(): Boolean {
    if (stack.size <= 1) return false
    stack.removeAt(stack.lastIndex)
    return true
  }

  fun message(text: String) {
    scope.launch { snackbar.showSnackbar(text) }
  }

  fun messageRes(res: Int, vararg args: Any) = message(context.getString(res, *args))

  fun errorText(e: Throwable): String = when {
    e is ApiException && e.code == "SERVER_UNREACHABLE" -> context.getString(R.string.error_unreachable)
    e is ApiException && e.code == "DOWNLOADS_NOT_ALLOWED" -> context.getString(R.string.downloads_not_allowed)
    e is ApiException -> e.message ?: context.getString(R.string.error_generic)
    else -> context.getString(R.string.error_generic)
  }

  /**
   * Learns the server's current addresses. A quick Cloudflare tunnel gets a
   * new address when Gharmonize restarts; the phone picks it up the next time
   * it can reach the server (e.g. at home) and drops the dead one.
   */
  fun refreshServers() {
    scope.launch {
      runCatching {
        val fresh = api.reachableAddresses().mapNotNull { com.gharmonize.player.data.PairLinks.normalizeBase(it) }
        if (fresh.isEmpty()) return@runCatching
        val known = app.prefs.servers
        val kept = known.filter { !it.contains(".trycloudflare.com") || it in fresh }
        app.prefs.servers = (kept + fresh.filter { it !in kept }).distinct()
      }
    }
  }

  fun loadMe() {
    scope.launch { runCatching { me = api.me() } }
  }

  // ---- favorites ------------------------------------------------------------------------

  private val waveforms = object : LinkedHashMap<Long, FloatArray>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, FloatArray>?) = size > 30
  }

  /** Cached waveform for the "wave" progress style. */
  suspend fun waveform(trackId: Long): FloatArray? {
    waveforms[trackId]?.let { return it }
    return runCatching { api.waveform(trackId) }.getOrNull()?.also { waveforms[trackId] = it }
  }

  fun setFavorite(trackId: Long, value: Boolean, onDone: (Boolean) -> Unit = {}) {
    scope.launch {
      try {
        api.setFavorite(trackId, value)
        player.updateFavorite(trackId, value)
        messageRes(if (value) R.string.favorite_added else R.string.favorite_removed)
        onDone(value)
      } catch (e: Exception) {
        message(errorText(e))
        onDone(!value)
      }
    }
  }

  // ---- playing online items -------------------------------------------------------------

  /**
   * A song whose download finished after its list was loaded still says "not
   * in library": take the track from the finished download instead.
   */
  fun withDownload(item: OnlineItem): OnlineItem {
    if (item.libraryTrackId != null || item.kind != "track") return item
    val row = downloadsByUrl[item.url] ?: return item
    if ((row.status != "completed" && row.status != "exists") || row.trackIds.isEmpty()) return item
    return item.copy(libraryTrackId = row.trackIds.first())
  }

  fun playOnline(items: List<OnlineItem>, index: Int) {
    if (!player.playOnline(items.map(::withDownload), index)) {
      val item = items.getOrNull(index) ?: return
      if (canDownload) messageRes(R.string.online_not_owned_download, item.title)
      else messageRes(R.string.online_no_preview)
    }
  }

  // ---- downloads ----------------------------------------------------------------------------

  fun download(item: OnlineItem) {
    scope.launch {
      try {
        val row = api.requestDownload(item)
        downloadsByUrl[item.url] = row
        if (row.status == "exists") messageRes(R.string.download_exists, item.title)
        else messageRes(R.string.download_queued, item.title)
        startPolling()
      } catch (e: Exception) {
        message(errorText(e))
      }
    }
  }

  /**
   * Adds a suggestion to a playlist: a library song right away, a new song
   * is downloaded and joins the playlist when the download finishes.
   */
  fun addSuggestion(playlistId: Long, item: OnlineItem, onDone: (Boolean) -> Unit) {
    scope.launch {
      try {
        val owned = withDownload(item).libraryTrackId
        if (owned != null) {
          api.addToPlaylist(playlistId, listOf(owned))
          messageRes(R.string.suggest_added, item.title)
        } else {
          downloadsByUrl[item.url] = api.requestDownload(item, playlistId)
          messageRes(R.string.suggest_downloading, item.title)
          startPolling()
        }
        onDone(true)
      } catch (e: Exception) {
        message(errorText(e))
        onDone(false)
      }
    }
  }

  /** Queues several songs at once with a single message. */
  fun downloadAll(items: List<OnlineItem>) {
    scope.launch {
      var queued = 0
      for (item in items) {
        val known = downloadsByUrl[item.url]
        if (item.libraryTrackId != null || (known != null && known.status != "failed" && known.status != "canceled")) continue
        runCatching { api.requestDownload(item) }.onSuccess { downloadsByUrl[item.url] = it; queued++ }
      }
      if (queued > 0) { messageRes(R.string.missing_queued, queued); startPolling() }
    }
  }

  fun refreshDownloads() {
    scope.launch { runCatching { applyDownloads(api.downloads()) } }
  }

  private fun applyDownloads(rows: List<DownloadRow>) {
    val before = downloads.associateBy { it.id }
    downloads = rows
    for (row in rows) {
      val prev = before[row.id]
      if (prev != null && prev.active && row.status == "completed") messageRes(R.string.download_done, row.title)
      if (prev != null && prev.active && row.status == "failed") messageRes(R.string.download_failed, row.title)
    }
  }

  fun startPolling() {
    if (poller?.isActive == true) return
    poller = scope.launch {
      while (isActive) {
        val rows = runCatching { api.downloads() }.getOrNull()
        if (rows != null) {
          applyDownloads(rows)
          // Keep badges of items started from this phone up to date.
          for ((url, row) in downloadsByUrl.toMap()) rows.firstOrNull { it.id == row.id }?.let { downloadsByUrl[url] = it }
          if (rows.none { it.active }) break
        }
        delay(3000)
      }
    }
  }

  fun trackFromOnline(o: OnlineItem): Track? = o.libraryTrackId?.let {
    Track(it, o.title, o.artist, null, o.album, null, null, o.duration, "track/$it", false, false, null, null, null)
  }
}
