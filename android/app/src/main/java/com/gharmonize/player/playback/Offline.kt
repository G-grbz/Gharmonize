package com.gharmonize.player.playback

import android.app.Notification
import android.content.Context
import androidx.annotation.OptIn
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.NoOpCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.exoplayer.offline.Download
import androidx.media3.exoplayer.offline.DownloadManager
import androidx.media3.exoplayer.offline.DownloadNotificationHelper
import androidx.media3.exoplayer.offline.DownloadRequest
import androidx.media3.exoplayer.offline.DownloadService
import androidx.media3.exoplayer.scheduler.Requirements
import androidx.media3.exoplayer.scheduler.Scheduler
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Songs saved on the phone for listening without a connection.
 *
 * Media3's DownloadManager writes each song into a private cache under the
 * key "t:<trackId>". The player reads through the same cache: a song that is
 * completely on the phone plays from there (no server needed), every other
 * song streams as before. Partly downloaded songs are never mixed with a
 * stream (the key is used only once a download is complete).
 */
@OptIn(UnstableApi::class)
object Offline {
  private lateinit var app: App
  lateinit var cache: SimpleCache
    private set
  lateinit var manager: DownloadManager
    private set
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val artworkSync = Channel<Unit>(Channel.CONFLATED)

  /** Completed downloads, readable from any thread (player loading thread). */
  private val completed = ConcurrentHashMap.newKeySet<Long>()

  /** Compose-observable state per track: Download.STATE_* and progress (0..100). */
  val states = mutableStateMapOf<Long, Int>()
  val progress = mutableStateMapOf<Long, Int>()
  val artworkReady = mutableStateMapOf<Long, Boolean>()
  /** Bumped whenever the set of songs on the phone changes. */
  val version = mutableStateOf(0)

  fun init(app: App) {
    this.app = app
    val db = StandaloneDatabaseProvider(app)
    cache = SimpleCache(File(app.filesDir, "offline"), NoOpCacheEvictor(), db)
    manager = DownloadManager(app, db, cache, upstreamFactory(app), Executors.newFixedThreadPool(2)).apply {
      maxParallelDownloads = 2
      requirements = requirementsFor(app.prefs.offlineWifiOnly)
      addListener(object : DownloadManager.Listener {
        override fun onDownloadChanged(downloadManager: DownloadManager, download: Download, finalException: Exception?) = track(download)
        override fun onRequirementsStateChanged(downloadManager: DownloadManager, requirements: Requirements, notMetRequirements: Int) {
          if (notMetRequirements == 0) refreshArtwork()
        }
        override fun onDownloadRemoved(downloadManager: DownloadManager, download: Download) {
          val id = trackIdOf(download.request.id) ?: return
          completed.remove(id)
          states.remove(id)
          progress.remove(id)
          artworkReady.remove(id)
          app.images.removeOfflineArtwork(id)
          version.value++
        }
      })
    }
    scope.launch { for (request in artworkSync) backfillArtwork() }
    scope.launch { app.servers.active.filterNotNull().collect { refreshArtwork() } }
    // Known downloads (the index is a small local database).
    scope.launch {
      val all = runCatching { list() }.getOrDefault(emptyList())
      launchMain { all.forEach(::track) }
    }
  }

  private fun launchMain(block: () -> Unit) = android.os.Handler(android.os.Looper.getMainLooper()).post(block)

  private fun track(download: Download) {
    val id = trackIdOf(download.request.id) ?: return
    if (download.state == Download.STATE_COMPLETED) {
      if (completed.add(id)) refreshArtwork()
    } else completed.remove(id)
    val changed = states[id] != download.state
    states[id] = download.state
    progress[id] = download.percentDownloaded.takeIf { it >= 0 }?.toInt() ?: 0
    if (changed) version.value++
  }

  fun requirementsFor(wifiOnly: Boolean) = Requirements(if (wifiOnly) Requirements.NETWORK_UNMETERED else Requirements.NETWORK)

  fun setWifiOnly(value: Boolean) {
    app.prefs.offlineWifiOnly = value
    DownloadService.sendSetRequirements(app, OfflineDownloadService::class.java, requirementsFor(value), false)
  }

  private fun trackIdOf(requestId: String): Long? = requestId.takeIf { it.startsWith("t:") }?.removePrefix("t:")?.toLongOrNull()

  fun isOnPhone(trackId: Long) = trackId in completed

  fun refreshArtwork() { artworkSync.trySend(Unit) }

  private fun backfillArtwork() {
    val missing = runCatching { list() }.getOrDefault(emptyList())
      .filter { it.state == Download.STATE_COMPLETED }.mapNotNull(::trackOf)
      .filter { !app.images.hasOfflineArtwork(it.id) }
    if (missing.isEmpty()) return
    val connected = app.prefs.signedIn && requirementsFor(app.prefs.offlineWifiOnly).checkRequirements(app) &&
      app.servers.currentBlocking() != null
    for (track in missing) {
      if (!isOnPhone(track.id)) continue
      val ref = track.artwork ?: track.albumId?.let { "album/$it" } ?: "track/${track.id}"
      if (app.images.saveOfflineArtwork(track.id, ref, connected) { isOnPhone(track.id) }) {
        launchMain { if (isOnPhone(track.id)) artworkReady[track.id] = true }
      }
    }
  }

  /** Cache key the player uses: only songs that are fully on the phone. */
  fun playbackKey(spec: DataSpec): String {
    val uri = spec.uri
    if (uri.scheme == App.SCHEME && uri.host == "stream") {
      val id = uri.lastPathSegment?.toLongOrNull()
      if (id != null && id in completed) return "t:$id"
    }
    return spec.key ?: uri.toString()
  }

  /** Server stream, resolved to the reachable server with the device token. */
  private fun upstreamFactory(app: App): DataSource.Factory {
    val http = DefaultHttpDataSource.Factory()
      .setUserAgent("GharmonizePlayer-Android")
      .setConnectTimeoutMs(15_000)
      .setReadTimeoutMs(60_000)
      .setAllowCrossProtocolRedirects(true)
    return ResolvingDataSource.Factory(DefaultDataSource.Factory(app, http)) { spec -> app.resolveDataSpec(spec) }
  }

  /** Player data source: phone copy when there is one, otherwise the stream. */
  fun playbackFactory(context: Context, upstream: DataSource.Factory): DataSource.Factory =
    CacheDataSource.Factory()
      .setCache(cache)
      .setUpstreamDataSourceFactory(upstream)
      .setCacheWriteDataSinkFactory(null)
      .setCacheKeyFactory(::playbackKey)
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)

  // ---- requests ----------------------------------------------------------------------------

  private fun requestFor(t: Track): DownloadRequest {
    val meta = JSONObject()
      .put("id", t.id).put("title", t.title).put("artist", t.artist).put("album", t.album)
      .put("artistId", t.artistId ?: 0).put("albumId", t.albumId ?: 0).put("trackNo", t.trackNo ?: 0)
      .put("duration", t.duration).put("artwork", t.artwork ?: "").put("genre", t.genre ?: "").put("year", t.year ?: 0)
      .put("savedAt", System.currentTimeMillis())
    return DownloadRequest.Builder("t:${t.id}", App.offlineUri(t.id, app.prefs.offlineQuality))
      .setCustomCacheKey("t:${t.id}")
      .setData(meta.toString().toByteArray())
      .build()
  }

  /** Saves songs on the phone (already saved ones are skipped). */
  fun download(context: Context, tracks: List<Track>): Int {
    var added = 0
    for (t in tracks.distinctBy { it.id }) {
      val state = states[t.id]
      if (state == Download.STATE_COMPLETED || state == Download.STATE_DOWNLOADING || state == Download.STATE_QUEUED) continue
      DownloadService.sendAddDownload(context, OfflineDownloadService::class.java, requestFor(t), false)
      states[t.id] = Download.STATE_QUEUED
      added++
    }
    return added
  }

  fun remove(context: Context, trackIds: Collection<Long>) {
    for (id in trackIds) DownloadService.sendRemoveDownload(context, OfflineDownloadService::class.java, "t:$id", false)
  }

  fun removeAll(context: Context) {
    DownloadService.sendRemoveAllDownloads(context, OfflineDownloadService::class.java, false)
  }

  /** Resumes unfinished downloads after the app starts. */
  fun resume(context: Context) {
    val pending = states.values.any { it == Download.STATE_QUEUED || it == Download.STATE_DOWNLOADING || it == Download.STATE_RESTARTING }
    if (pending) runCatching { DownloadService.start(context, OfflineDownloadService::class.java) }
  }

  /** All downloads (any state), newest first. Blocking: call off the main thread. */
  fun list(): List<Download> {
    val out = mutableListOf<Download>()
    manager.downloadIndex.getDownloads().use { c -> while (c.moveToNext()) out.add(c.download) }
    return out.sortedByDescending { it.startTimeMs }
  }

  /** Songs completely on the phone, as tracks (no server needed). */
  fun tracksOnPhone(): List<Track> = list().filter { it.state == Download.STATE_COMPLETED }.mapNotNull(::trackOf)
    .map { it.copy(artwork = "track/${it.id}") }

  private fun trackOf(d: Download): Track? = runCatching {
    val o = JSONObject(String(d.request.data))
    Track(
      id = o.getLong("id"),
      title = o.optString("title"),
      artist = o.optString("artist"),
      artistId = o.optLong("artistId").takeIf { it > 0 },
      album = o.optString("album"),
      albumId = o.optLong("albumId").takeIf { it > 0 },
      trackNo = o.optInt("trackNo").takeIf { it > 0 },
      duration = o.optDouble("duration", 0.0),
      artwork = o.optString("artwork").ifBlank { null },
      favorite = false,
      lossless = false,
      codec = null,
      bitrate = null,
      playCount = null,
      genre = o.optString("genre").ifBlank { null },
      year = o.optInt("year").takeIf { it > 0 },
    )
  }.getOrNull()

  fun bytesUsed(): Long = runCatching { cache.cacheSpace }.getOrDefault(0L)
}

/** Keeps downloads running in the background with a progress notification. */
@OptIn(UnstableApi::class)
class OfflineDownloadService : DownloadService(
  NOTIFICATION_ID,
  DEFAULT_FOREGROUND_NOTIFICATION_UPDATE_INTERVAL,
  CHANNEL_ID,
  R.string.offline_channel,
  0,
) {
  private val helper by lazy { DownloadNotificationHelper(this, CHANNEL_ID) }

  override fun getDownloadManager(): DownloadManager = Offline.manager

  override fun getScheduler(): Scheduler? = null

  override fun getForegroundNotification(downloads: MutableList<Download>, notMetRequirements: Int): Notification {
    val active = downloads.count { it.state == Download.STATE_DOWNLOADING || it.state == Download.STATE_QUEUED }
    return helper.buildProgressNotification(
      this, R.drawable.media3_notification_small_icon, null,
      getString(R.string.offline_notification, active), downloads, notMetRequirements,
    )
  }

  companion object {
    const val NOTIFICATION_ID = 4711
    const val CHANNEL_ID = "offline"
  }
}
