package com.gharmonize.player.playback

import android.content.ComponentName
import android.content.Context
import android.os.Bundle
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.gharmonize.player.App
import com.gharmonize.player.data.OnlineItem
import com.gharmonize.player.data.Track
import com.google.common.util.concurrent.MoreExecutors

/** UI-side handle on the playback service (Compose-observable state). */
class PlayerController(private val context: Context) {
  private var controller: MediaController? = null

  var current by mutableStateOf<MediaItem?>(null); private set
  var isPlaying by mutableStateOf(false); private set
  var buffering by mutableStateOf(false); private set
  var shuffle by mutableStateOf(false); private set
  var repeatMode by mutableIntStateOf(Player.REPEAT_MODE_OFF); private set
  var queue by mutableStateOf<List<MediaItem>>(emptyList()); private set
  var index by mutableIntStateOf(0); private set

  val position: Long get() = controller?.currentPosition ?: 0
  val duration: Long get() = controller?.duration?.takeIf { it > 0 }
    ?: ((current?.mediaMetadata?.extras?.getDouble("duration") ?: 0.0) * 1000).toLong()

  fun connect() {
    if (controller != null) return
    val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
    val future = MediaController.Builder(context, token).buildAsync()
    future.addListener({
      val c = runCatching { future.get() }.getOrNull() ?: return@addListener
      controller = c
      c.addListener(object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = sync()
      })
      sync()
    }, MoreExecutors.directExecutor())
  }

  fun release() {
    controller?.release()
    controller = null
  }

  private fun sync() {
    val c = controller ?: return
    current = c.currentMediaItem
    isPlaying = c.isPlaying
    buffering = c.playbackState == Player.STATE_BUFFERING
    shuffle = c.shuffleModeEnabled
    repeatMode = c.repeatMode
    index = c.currentMediaItemIndex
    queue = (0 until c.mediaItemCount).map { c.getMediaItemAt(it) }
  }

  // ---- commands -----------------------------------------------------------------------

  fun play(tracks: List<Track>, start: Int = 0, shuffle: Boolean = false) {
    val c = controller ?: return
    if (tracks.isEmpty()) return
    c.shuffleModeEnabled = shuffle
    c.setMediaItems(tracks.map(::trackItem), if (shuffle) (tracks.indices).random() else start.coerceIn(0, tracks.lastIndex), 0)
    c.prepare()
    c.play()
  }

  /** Owned online items play from the library, others as 30 s previews. */
  fun playOnline(items: List<OnlineItem>, start: Int): Boolean {
    val c = controller ?: return false
    val playable = items.mapIndexedNotNull { i, it -> onlineItem(it)?.let { m -> i to m } }
    val pos = playable.indexOfFirst { it.first == start }
    if (pos < 0) return false
    c.setMediaItems(playable.map { it.second }, pos, 0)
    c.prepare()
    c.play()
    return true
  }

  fun playNext(track: Track) {
    val c = controller ?: return
    if (c.mediaItemCount == 0) return play(listOf(track))
    c.addMediaItem(c.currentMediaItemIndex + 1, trackItem(track))
  }

  fun addToQueue(track: Track) {
    val c = controller ?: return
    if (c.mediaItemCount == 0) return play(listOf(track))
    c.addMediaItem(trackItem(track))
  }

  fun toggle() { controller?.let { if (it.isPlaying) it.pause() else { if (it.playbackState == Player.STATE_IDLE) it.prepare(); it.play() } } }
  fun next() { controller?.seekToNextMediaItem() }
  fun previous() { controller?.seekToPrevious() }
  fun seekTo(ms: Long) { controller?.seekTo(ms) }
  fun jumpTo(i: Int) { controller?.let { it.seekTo(i, 0); it.play() } }
  fun clearUpcoming() { controller?.let { if (it.currentMediaItemIndex + 1 < it.mediaItemCount) it.removeMediaItems(it.currentMediaItemIndex + 1, it.mediaItemCount) } }
  fun move(from: Int, to: Int) { controller?.let { if (from in 0 until it.mediaItemCount && to in 0 until it.mediaItemCount) it.moveMediaItem(from, to) } }
  fun removeAt(i: Int) { controller?.removeMediaItem(i) }
  fun toggleShuffle() { controller?.let { it.shuffleModeEnabled = !it.shuffleModeEnabled } }
  fun cycleRepeat() {
    controller?.let {
      it.repeatMode = when (it.repeatMode) {
        Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
        Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
        else -> Player.REPEAT_MODE_OFF
      }
    }
  }

  /** Marks the current item as liked in the session metadata (UI refresh). */
  fun updateFavorite(trackId: Long, value: Boolean) {
    val c = controller ?: return
    for (i in 0 until c.mediaItemCount) {
      val item = c.getMediaItemAt(i)
      if (item.mediaId == "t:$trackId") {
        val extras = Bundle(item.mediaMetadata.extras ?: Bundle()).apply { putBoolean("favorite", value) }
        c.replaceMediaItem(i, item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build())
      }
    }
  }

  companion object {
    fun trackItem(t: Track, auto: Boolean = false): MediaItem = MediaItem.Builder()
      .setMediaId("t:${t.id}")
      .setUri(App.streamUri(t.id))
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(t.title)
          .setArtist(t.artist)
          .setAlbumTitle(t.album)
          .setArtworkUri(App.artworkUri(t.artwork ?: t.albumId?.let { "album/$it" } ?: "track/${t.id}", 512))
          .setIsPlayable(true)
          .setIsBrowsable(false)
          .setExtras(Bundle().apply {
            putLong("trackId", t.id)
            putLong("albumId", t.albumId ?: 0)
            putLong("artistId", t.artistId ?: 0)
            putBoolean("favorite", t.favorite)
            putDouble("duration", t.duration)
            if (auto) putBoolean("auto", true)
          })
          .build(),
      )
      .build()

    fun onlineItem(o: OnlineItem): MediaItem? {
      val owned = o.libraryTrackId
      if (owned != null) {
        return trackItem(Track(owned, o.title, o.artist, null, o.album, null, null, o.duration, "track/$owned", false, false, null, null, null))
      }
      val preview = o.previewUrl ?: return null
      // Deezer links expire within minutes; ghp://preview/… fetches a fresh one when loading.
      val uri = if (o.provider == "deezer" && o.id.matches(Regex("\\d{1,20}"))) App.previewUri("deezer", o.id) else android.net.Uri.parse(preview)
      return MediaItem.Builder()
        .setMediaId("p:$uri")
        .setUri(uri)
        .setMediaMetadata(
          MediaMetadata.Builder()
            .setTitle(o.title)
            .setArtist(o.artist)
            .setAlbumTitle(o.album)
            .setArtworkUri(o.artworkUrl?.let(android.net.Uri::parse))
            .setIsPlayable(true)
            .setIsBrowsable(false)
            .setExtras(Bundle().apply { putBoolean("preview", true); putDouble("duration", 30.0) })
            .build(),
        )
        .build()
    }
  }
}
