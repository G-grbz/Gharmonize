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
import androidx.media3.session.MediaSessionService
import com.gharmonize.player.App
import com.gharmonize.player.ui.MainActivity
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.concurrent.Executors

/** Background playback with media notification, lock screen and headset keys. */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  // Play history: time actually spent playing the current item.
  private var playedMs = 0L
  private var playingSince = 0L
  private var currentId: String? = null
  private var retries = 0
  private var lastRetryAt = 0L
  private var autoplayBusy = false

  override fun onCreate() {
    super.onCreate()
    val app = application as App
    val http = DefaultHttpDataSource.Factory()
      .setUserAgent("GharmonizePlayer-Android")
      .setConnectTimeoutMs(10_000)
      .setReadTimeoutMs(30_000)
      .setAllowCrossProtocolRedirects(true)
    val dataSource = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, http)) { spec -> app.resolveDataSpec(spec) }
    // The equalizer runs inside the player's own audio pipeline.
    val renderers = object : DefaultRenderersFactory(this) {
      override fun buildAudioSink(context: Context, enableFloatOutput: Boolean, enableAudioTrackPlaybackParams: Boolean): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setAudioProcessors(arrayOf(EqualizerProcessor()))
          .build()
    }
    val player = ExoPlayer.Builder(this, renderers)
      .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource))
      .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    player.addListener(historyListener(player))

    val openApp = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    session = MediaSession.Builder(this, player)
      .setSessionActivity(openApp)
      .setBitmapLoader(AuthBitmapLoader(app))
      .setCallback(object : MediaSession.Callback {
        // Controllers send items without their URIs; rebuild them from the id.
        override fun onAddMediaItems(
          mediaSession: MediaSession,
          controller: MediaSession.ControllerInfo,
          mediaItems: MutableList<MediaItem>,
        ): ListenableFuture<MutableList<MediaItem>> =
          Futures.immediateFuture(mediaItems.map(::withPlayableUri).toMutableList())
      })
      .build()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  // Swiping the app away from recents ends playback as well; stopping (idle)
  // also removes the media notification so nothing keeps the service alive.
  override fun onTaskRemoved(rootIntent: Intent?) {
    pauseAllPlayersAndStopSelf()
    session?.player?.stop()
  }

  override fun onDestroy() {
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
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      if (isPlaying) playingSince = SystemClock.elapsedRealtime()
      else if (playingSince > 0) {
        playedMs += SystemClock.elapsedRealtime() - playingSince
        playingSince = 0
      }
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
      flushPlay(player, completed = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
      currentId = mediaItem?.mediaId
      retries = 0
      keepPlaying(player)
    }

    override fun onPlaybackStateChanged(state: Int) {
      if (state == Player.STATE_ENDED) {
        flushPlay(player, completed = true)
        keepPlaying(player, resume = true)
      }
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

  /**
   * When the last song of the queue starts, similar library songs are added
   * after it, so the queue is never empty and the music keeps going if the
   * user does nothing. `resume` also starts them when the queue already ended.
   */
  private fun keepPlaying(player: ExoPlayer, resume: Boolean = false) {
    val app = application as App
    if (!app.prefs.autoplay || autoplayBusy || player.repeatMode != Player.REPEAT_MODE_OFF) return
    if (player.mediaItemCount == 0 || player.nextMediaItemIndex != C.INDEX_UNSET) return
    if (player.currentMediaItem?.mediaId?.startsWith("t:") != true) return
    val ids = (0 until player.mediaItemCount).mapNotNull { player.getMediaItemAt(it).mediaId.takeIf { id -> id.startsWith("t:") }?.removePrefix("t:")?.toLongOrNull() }
    val at = player.currentMediaItemIndex
    val seeds = (maxOf(0, at - 9)..at).mapNotNull { player.getMediaItemAt(it).mediaId.takeIf { id -> id.startsWith("t:") }?.removePrefix("t:")?.toLongOrNull() }
    if (seeds.isEmpty()) return
    autoplayBusy = true
    scope.launch {
      val known = ids.toSet()
      val tracks = runCatching { app.api.autoplay(seeds, ids) }.getOrDefault(emptyList()).filter { it.id !in known }
      withContext(Dispatchers.Main) {
        autoplayBusy = false
        if (tracks.isEmpty() || session?.player !== player) return@withContext
        player.addMediaItems(tracks.map { PlayerController.trackItem(it, auto = true) })
        if (resume && player.playbackState == Player.STATE_ENDED) {
          player.seekToNextMediaItem()
          player.play()
        }
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
