package com.gharmonize.player.playback

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import com.gharmonize.player.App
import com.gharmonize.player.ui.MainActivity
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.concurrent.Executors

/** Background playback with media notification, lock screen and headset keys. */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // Play history: time actually spent playing the current item.
  private var playedMs = 0L
  private var playingSince = 0L
  private var currentId: String? = null
  private var retries = 0
  private var lastRetryAt = 0L
  private var autoplayJob: Job? = null
  private var autoplayRevision = 0L
  private var autoplayAttempted = false
  private var autoplayAttemptedAtEnd = false
  // The queue and position are kept on the phone (QueueStore) so the last
  // song is back, paused, after the app or the phone restarts.
  private var lastQueueSave = 0L
  private val queueWriter = Dispatchers.IO.limitedParallelism(1)

  // ---- crossfade -----------------------------------------------------------------------
  // In the last seconds of a song the next one starts on a helper player and
  // the volumes trade places (equal-power curve). When the song ends, the main
  // player moves to the next item at the helper's position and the helper is
  // released. Any user action during the fade cancels it.
  private lateinit var buildPlayer: (Boolean) -> ExoPlayer
  private var mainPlayer: ExoPlayer? = null
  private var helper: ExoPlayer? = null
  private var fadeStart = 0L
  private var fadeMs = 1L
  private var handingOver = false
  private val handler = android.os.Handler(android.os.Looper.getMainLooper())
  private val crossfadeTick = object : Runnable {
    override fun run() {
      runCatching { crossfadeStep() }
      mainPlayer?.let { if (it.isPlaying && SystemClock.elapsedRealtime() - lastQueueSave > 10_000) saveQueue(it) }
      handler.postDelayed(this, if (helper != null) 50L else 250L)
    }
  }

  private fun crossfadeStep() {
    val p = mainPlayer ?: return
    val h = helper
    if (h != null) {
      if (handingOver) {
        // The main player took over: drop the helper once it plays.
        if (p.playbackState == Player.STATE_READY && p.isPlaying) cancelCrossfade()
        return
      }
      val x = ((SystemClock.elapsedRealtime() - fadeStart).toFloat() / fadeMs).coerceIn(0f, 1f)
      p.volume = kotlin.math.cos(x * Math.PI / 2).toFloat()
      h.volume = kotlin.math.sin(x * Math.PI / 2).toFloat()
      return
    }
    val seconds = (application as App).prefs.crossfadeSeconds
    if (seconds <= 0 || !p.isPlaying || p.repeatMode == Player.REPEAT_MODE_ONE) return
    val duration = p.duration
    if (duration == C.TIME_UNSET || duration < (seconds * 2 + 5) * 1000L) return
    val remaining = duration - p.currentPosition
    if (remaining > seconds * 1000L || remaining < 800) return
    val nextIndex = p.nextMediaItemIndex
    if (nextIndex == C.INDEX_UNSET) return
    val next = p.getMediaItemAt(nextIndex)
    if (!next.mediaId.startsWith("t:")) return
    val hp = buildPlayer(false)
    hp.volume = 0f
    hp.setMediaItem(withPlayableUri(next))
    hp.prepare()
    hp.play()
    helper = hp
    fadeStart = SystemClock.elapsedRealtime()
    fadeMs = remaining
    handingOver = false
  }

  private fun cancelCrossfade() {
    helper?.let { runCatching { it.stop(); it.release() } }
    helper = null
    handingOver = false
    mainPlayer?.volume = 1f
  }

  override fun onCreate() {
    super.onCreate()
    val app = application as App
    val http = DefaultHttpDataSource.Factory()
      .setUserAgent("GharmonizePlayer-Android")
      .setConnectTimeoutMs(10_000)
      .setReadTimeoutMs(30_000)
      .setAllowCrossProtocolRedirects(true)
    val stream = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, http)) { spec -> app.resolveDataSpec(spec) }
    // Songs saved on the phone play from there; the others stream.
    val dataSource = Offline.playbackFactory(this, stream)
    // The equalizer runs inside the player's own audio pipeline.
    val renderers = object : DefaultRenderersFactory(this) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setAudioProcessors(arrayOf(EqualizerProcessor()))
          .build()
    }
    buildPlayer = { main ->
      ExoPlayer.Builder(this, renderers)
        .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
        // Only the main player takes audio focus; the crossfade helper must
        // not pause it.
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), main)
        .setHandleAudioBecomingNoisy(main)
        .setWakeMode(C.WAKE_MODE_NETWORK)
        .build()
    }
    val player = buildPlayer(true)
    restoreQueue(player)
    player.addListener(historyListener(player))
    mainPlayer = player
    handler.post(crossfadeTick)
    // While music plays, new releases of followed artists are checked now and then.
    scope.launch {
      while (true) {
        kotlinx.coroutines.delay(30 * 60 * 1000L)
        runCatching { com.gharmonize.player.data.ReleaseNotifier.check(app) }
      }
    }

    val openApp = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    // A library session: the app's own UI, and Android Auto / other media
    // browsers that list mixes, playlists and saved songs (AutoLibrary).
    session = MediaLibrarySession.Builder(this, player, AutoLibrary(this, scope))
      .setSessionActivity(openApp)
      .setBitmapLoader(AuthBitmapLoader(app))
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  // Swiping the app away from recents ends playback as well; stopping (idle)
  // also removes the media notification so nothing keeps the service alive.
  override fun onTaskRemoved(rootIntent: Intent?) {
    mainPlayer?.let { saveQueue(it, now = true) }
    pauseAllPlayersAndStopSelf()
    session?.player?.stop()
  }

  override fun onDestroy() {
    handler.removeCallbacks(crossfadeTick)
    cancelCrossfade()
    mainPlayer?.let { saveQueue(it, now = true) }
    session?.run {
      flushPlay(player, completed = false)
      player.release()
      release()
    }
    session = null
    scope.cancel()
    super.onDestroy()
  }

  private fun historyListener(player: ExoPlayer) = object : Player.Listener {
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      // A restored queue waits unprepared: play from anywhere (app, queue,
      // notification, headset) loads it first.
      if (playWhenReady && player.playbackState == Player.STATE_IDLE && player.mediaItemCount > 0) player.prepare()
      // Paused by the user (or focus loss) during a fade: stop the helper too.
      if (!playWhenReady && helper != null) cancelCrossfade()
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
      if (reason == Player.DISCONTINUITY_REASON_SEEK && helper != null && !handingOver) cancelCrossfade()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      if (isPlaying) playingSince = SystemClock.elapsedRealtime()
      else if (playingSince > 0) {
        playedMs += SystemClock.elapsedRealtime() - playingSince
        playingSince = 0
      }
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      val h = helper
      if (h != null && !handingOver) {
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && mediaItem?.mediaId == h.currentMediaItem?.mediaId) {
          // The faded-in song continues on the main player from where it is.
          handingOver = true
          player.volume = h.volume
          player.seekTo(h.currentPosition + 60)
        } else cancelCrossfade()
      }
      flushPlay(player, completed = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
      currentId = mediaItem?.mediaId
      retries = 0
      resetAutoplay()
    }

    override fun onPlaybackStateChanged(state: Int) {
      if (state == Player.STATE_ENDED) {
        flushPlay(player, completed = true)
      }
    }

    override fun onEvents(source: Player, events: Player.Events) {
      if (events.contains(Player.EVENT_REPEAT_MODE_CHANGED)) resetAutoplay()
      if (events.containsAny(
        Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED,
        Player.EVENT_POSITION_DISCONTINUITY, Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,
      )) saveQueue(player)
      if (events.containsAny(
        Player.EVENT_MEDIA_ITEM_TRANSITION, Player.EVENT_TIMELINE_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED,
        Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_REPEAT_MODE_CHANGED, Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED,
      )) keepPlaying(player)
    }

    // The home ↔ Tailscale switch breaks the open connection: re-resolve the
    // server and continue from the same position (a few times per track).
    override fun onPlayerError(error: PlaybackException) {
      val now = SystemClock.elapsedRealtime()
      if (now - lastRetryAt > 60_000) retries = 0
      if (retries >= 3) return
      retries++
      lastRetryAt = now
      (application as App).servers.invalidate()
      val pos = player.currentPosition
      player.prepare()
      player.seekTo(pos)
      player.play()
    }
  }

  private fun restoreQueue(player: ExoPlayer) {
    val saved = QueueStore.read(this) ?: return
    player.shuffleModeEnabled = saved.shuffle
    player.repeatMode = saved.repeatMode
    // Not prepared: nothing loads or plays until the user presses play.
    player.setMediaItems(saved.items, saved.index, saved.positionMs)
  }

  private fun saveQueue(player: Player, now: Boolean = false) {
    lastQueueSave = SystemClock.elapsedRealtime()
    val snapshot = runCatching { QueueStore.snapshot(player) }.getOrElse { return }
    if (now) QueueStore.write(this, snapshot)
    else scope.launch(queueWriter) { QueueStore.write(this@PlaybackService, snapshot) }
  }

  private fun resetAutoplay() {
    autoplayRevision++
    autoplayJob?.cancel()
    autoplayJob = null
    autoplayAttempted = false
    autoplayAttemptedAtEnd = false
  }

  /** Fetch a continuation as soon as playback reaches the last queue item. */
  private fun keepPlaying(player: ExoPlayer) {
    val app = application as App
    if (!app.prefs.autoplay || autoplayJob?.isActive == true || player.repeatMode != Player.REPEAT_MODE_OFF) return
    if (!player.playWhenReady || player.playbackState == Player.STATE_IDLE || player.nextMediaItemIndex != C.INDEX_UNSET) return
    val item = player.currentMediaItem ?: return
    if (item.mediaMetadata.extras?.getBoolean("downloadsOnly") == true) return
    val ended = player.playbackState == Player.STATE_ENDED
    if (autoplayAttemptedAtEnd || (autoplayAttempted && !ended)) return
    autoplayAttempted = true
    autoplayAttemptedAtEnd = ended
    val revision = autoplayRevision
    val queue = (0 until player.mediaItemCount).map(player::getMediaItemAt)
    autoplayJob = scope.launch(Dispatchers.Main) {
      val next = autoplayItems(app.api, item, queue)
      if (next.isEmpty() || session?.player !== player || revision != autoplayRevision ||
        player.currentMediaItem?.mediaId != item.mediaId || player.nextMediaItemIndex != C.INDEX_UNSET ||
        !app.prefs.autoplay || player.repeatMode != Player.REPEAT_MODE_OFF) return@launch
      val resume = player.playWhenReady && player.playbackState == Player.STATE_ENDED
      autoplayJob = null
      player.addMediaItems(next)
      if (resume) {
        player.seekToNextMediaItem()
        player.play()
      }
    }
  }

  private fun flushPlay(player: Player, completed: Boolean) {
    if (playingSince > 0) {
      playedMs += SystemClock.elapsedRealtime() - playingSince
      playingSince = if (player.isPlaying) SystemClock.elapsedRealtime() else 0
    }
    val id = currentId
    val ms = playedMs
    playedMs = 0
    if (id == null || !id.startsWith("t:")) return
    if (ms < 1000 && !completed) return
    val trackId = id.removePrefix("t:").toLongOrNull() ?: return
    scope.launch { runCatching { (application as App).api.recordPlay(trackId, ms, completed) } }
  }

  companion object {
    /** "t:<trackId>" → library stream, "p:<uri>" → online preview clip (https or ghp://preview/…). */
    fun withPlayableUri(item: MediaItem): MediaItem {
      val id = item.mediaId
      val uri = when {
        id.startsWith("t:") -> App.streamUri(id.removePrefix("t:").toLong())
        id.startsWith("p:") -> Uri.parse(id.removePrefix("p:"))
        else -> item.localConfiguration?.uri ?: item.requestMetadata.mediaUri
      }
      return if (uri == null) item else item.buildUpon().setUri(uri).build()
    }
  }
}

/** Loads notification / lock screen artwork with the device token. */
@OptIn(UnstableApi::class)
class AuthBitmapLoader(private val app: App) : BitmapLoader {
  private val executor = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())

  override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")

  override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
    BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Could not decode artwork")
  }

  override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
    app.images.loadBlocking(uri, 512) ?: throw IOException("Could not load artwork")
  }
}
