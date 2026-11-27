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
import com.gharmonize.player.data.DownloadGroup
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
  data object Offline : Route
  data object Notifications : Route
}

/** UI state shared by all screens: navigation, player, downloads, messages. */
class AppState(private val context: Context, val scope: CoroutineScope, val player: PlayerController) {
  /** Keeps a search text and / or the result picked from it in the user's search history. */
  fun rememberSearch(q: String?, item: org.json.JSONObject? = null) {
    scope.launch { runCatching { api.rememberSearch(q, item) } }
  }

  val app get() = App.instance
  val api get() = app.api
  val snackbar = SnackbarHostState()

  val stack = mutableStateListOf<Route>(Route.Home)
  val top: Route get() = stack.last()

  var me by mutableStateOf<Me?>(null)
  /** Unread server notifications (new releases of followed artists). */
  var unreadNotifications by mutableStateOf(0)

  fun checkNotifications() {
    scope.launch {
      runCatching { com.gharmonize.player.data.ReleaseNotifier.check(app) }.onSuccess { unreadNotifications = it.second }
    }
  }
  val canDownload: Boolean get() = me?.canDownload == true
  /** Admins can replace library files ("refresh online"). */
  val canRefreshOnline: Boolean get() = me?.role == "admin" && canDownload

  /** Replaces a library song with the chosen version and reports when it is done. */
  fun replaceTrack(trackId: Long, title: String, source: org.json.JSONObject, onStarted: () -> Unit = {}, onFailed: () -> Unit = {}) {
    scope.launch {
      val batchId = try {
        api.replaceTrack(trackId, source)
      } catch (e: Exception) {
        message(if (e is ApiException && e.code == "INVALID_REPLACEMENT_URL") context.getString(R.string.refresh_invalid_link) else errorText(e))
        onFailed()
        return@launch
      }
      onStarted()
      messageRes(R.string.refresh_started, title)
      startPolling()
      if (batchId == null) return@launch
      while (isActive) {
        delay(2000)
        val batch = runCatching { api.healthBatch() }.getOrNull() ?: continue
        if (batch.optString("id") != batchId) return@launch
        if (batch.optBoolean("running")) continue
        val error = batch.optJSONArray("errors")?.optJSONObject(0)
        when {
          batch.optInt("succeeded") > 0 -> messageRes(R.string.refresh_done, title)
          error != null -> message(context.getString(R.string.refresh_failed, title) + " " + error.optString("message"))
          batch.optBoolean("canceled") -> messageRes(R.string.refresh_canceled, title)
        }
        return@launch
      }
    }
  }

  /** Live download state by source URL, for the badges on online items. */
  val downloadsByUrl = mutableStateMapOf<String, DownloadRow>()
  var downloads by mutableStateOf<List<DownloadRow>>(emptyList())
  /** Songs picked together (one entry each on the downloads screen). */
  var downloadGroups by mutableStateOf<List<DownloadGroup>>(emptyList())
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
  fun text(res: Int, vararg args: Any): String = context.getString(res, *args)

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

  /** Likes several songs with one message (selection bar). */
  fun likeAll(trackIds: List<Long>, onDone: () -> Unit = {}) {
    scope.launch {
      try {
        for (id in trackIds) { api.setFavorite(id, true); player.updateFavorite(id, true) }
        messageRes(R.string.liked_many, trackIds.size)
        onDone()
      } catch (e: Exception) { message(errorText(e)) }
    }
  }

  /** Removes these entries from one of your playlists. */
  fun removeFromPlaylist(playlistId: Long, tracks: List<Track>, onDone: () -> Unit) {
    scope.launch {
      try {
        val entries = tracks.mapNotNull { it.entryId }
        for (entry in entries) api.removeFromPlaylist(playlistId, entry)
        messageRes(R.string.removed_many, entries.size)
        onDone()
      } catch (e: Exception) { message(errorText(e)) }
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

  fun download(item: OnlineItem, only: List<OnlineItem>? = null) {
    scope.launch {
      try {
        val row = api.requestDownload(item, only = only)
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

  /**
   * Queues several songs at once: one request and one message. Songs over
   * the per-user queue limit wait on the server and follow as earlier ones
   * finish (shown as queued here meanwhile).
   */
  /** [only]: per album link, just these of its songs (the rest stays out). */
  fun downloadAll(items: List<OnlineItem>, title: String? = null, playlistId: Long? = null, only: Map<String, List<OnlineItem>> = emptyMap(), onQueued: (() -> Unit)? = null) {
    scope.launch {
      val wanted = items.filter { item ->
        val known = downloadsByUrl[item.url]
        item.url.isNotBlank() && item.libraryTrackId == null && (known == null || known.status == "failed" || known.status == "canceled")
      }.distinctBy { it.url }
      if (wanted.isEmpty()) return@launch
      try {
        val group = api.requestDownloadGroup(wanted, title, playlistId, only)
        markWaiting(group)
        downloadGroups = listOf(group) + downloadGroups.filter { it.id != group.id }
        // Songs, not links: an album counts with the songs it brings.
        messageRes(R.string.group_queued, wanted.sumOf { item -> only[item.url]?.size ?: if (item.kind == "album") (item.trackCount ?: 1) else 1 })
        startPolling()
        onQueued?.invoke()
      } catch (e: Exception) {
        message(errorText(e))
      }
    }
  }

  /** The songs of a group that wait on the server show as queued. */
  private fun markWaiting(group: DownloadGroup) {
    val pending = group.pendingUrls ?: return
    for (url in pending) {
      val known = downloadsByUrl[url]
      if (known == null || known.waiting || !known.active) downloadsByUrl[url] = DownloadRow.waitingIn(group.id, url)
    }
  }

  fun cancelDownloadGroup(id: String) {
    scope.launch {
      runCatching { api.cancelDownloadGroup(id) }.onFailure { message(errorText(it)) }
      refreshDownloadsNow()
    }
  }

  fun retryDownloadGroup(id: String) {
    scope.launch {
      runCatching { api.retryDownloadGroup(id) }.onSuccess { markWaiting(it) }
      startPolling()
      refreshDownloadsNow()
    }
  }

  fun refreshDownloads() {
    scope.launch { refreshDownloadsNow() }
  }

  private suspend fun refreshDownloadsNow() {
    runCatching { api.downloads() }.getOrNull()?.let { applyDownloads(it) }
    runCatching { api.downloadGroups(activeOnly = false) }.getOrNull()?.let { applyGroups(it) }
    runCatching { api.downloadGroups(activeOnly = true) }.getOrNull()?.forEach(::markWaiting)
  }

  // A group finished: one message for all of its songs.
  private fun applyGroups(groups: List<DownloadGroup>) {
    val before = downloadGroups.associateBy { it.id }
    downloadGroups = groups
    for (group in groups) {
      val prev = before[group.id] ?: continue
      if (!prev.active || group.active || group.status == "canceled") continue
      val name = group.title ?: context.getString(R.string.group_untitled)
      if (group.counts.failed > 0) messageRes(R.string.group_done_failed, name, group.counts.done, group.counts.failed)
      else messageRes(R.string.group_done, name, group.counts.done)
    }
    // Waiting songs of a canceled or finished group are not waiting any more.
    val live = groups.filter { it.active && it.counts.waiting > 0 }.map { it.id }.toSet()
    for ((url, row) in downloadsByUrl.toMap()) if (row.waiting && row.groupId !in live) downloadsByUrl.remove(url)
  }

  // A selection, an album or a playlist finishes song by song: one message
  // for the batch (when nothing is left, or a progress note every 30 s)
  // instead of a queue of messages, one per song.
  private val batchDone = mutableListOf<String>()
  private val batchFailed = mutableListOf<String>()
  private var batchStartedAt = 0L

  private fun applyDownloads(rows: List<DownloadRow>) {
    val before = downloads.associateBy { it.id }
    downloads = rows
    for (row in rows) {
      val prev = before[row.id]
      // Songs of a group get one message when the whole group is done.
      if (row.groupId != null) continue
      if (prev != null && prev.active && row.status == "completed") batchDone.add(row.title)
      if (prev != null && prev.active && row.status == "failed") batchFailed.add(row.title)
    }
    if (batchDone.isEmpty() && batchFailed.isEmpty()) return
    val now = System.currentTimeMillis()
    if (batchStartedAt == 0L) batchStartedAt = now
    val left = rows.count { it.active && it.groupId == null }
    if (left > 0 && now - batchStartedAt < 30_000) return
    when {
      batchDone.size == 1 && left == 0 -> messageRes(R.string.download_done, batchDone[0])
      batchDone.isNotEmpty() && left > 0 -> messageRes(R.string.download_done_many_left, batchDone.size, left)
      batchDone.isNotEmpty() -> messageRes(R.string.download_done_many, batchDone.size)
    }
    when {
      batchFailed.size == 1 -> messageRes(R.string.download_failed, batchFailed[0])
      batchFailed.isNotEmpty() -> messageRes(R.string.download_failed_many, batchFailed.size)
    }
    batchDone.clear()
    batchFailed.clear()
    batchStartedAt = 0L
  }

  fun startPolling() {
    if (poller?.isActive == true) return
    poller = scope.launch {
      while (isActive) {
        val rows = runCatching { api.downloads() }.getOrNull()
        val groups = runCatching { api.downloadGroups() }.getOrNull()
        if (groups != null) applyGroups(groups)
        if (rows != null) {
          applyDownloads(rows)
          // Keep badges of items started from this phone up to date; a song
          // that waited in its group gets its real download once queued.
          for ((url, row) in downloadsByUrl.toMap()) {
            val fresh = if (row.waiting) rows.firstOrNull { url in it.urls } else rows.firstOrNull { it.id == row.id }
            fresh?.let { downloadsByUrl[url] = it }
          }
          if (rows.none { it.active } && groups.orEmpty().none { it.active }) break
        }
        delay(3000)
      }
    }
  }

  fun trackFromOnline(o: OnlineItem): Track? = o.libraryTrackId?.let {
    Track(it, o.title, o.artist, null, o.album, null, null, o.duration, "track/$it", false, false, null, null, null)
  }
}
