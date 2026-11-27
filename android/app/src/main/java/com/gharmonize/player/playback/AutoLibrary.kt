package com.gharmonize.player.playback

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.Mix
import com.gharmonize.player.data.Track
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * What Android Auto (and other media browsers) can browse:
 *   root → Mixes / Playlists / Recently played / Liked / On this phone
 * Songs inside a list are "bt:<listId>:<trackId>"; choosing one plays the
 * whole list from that song. Voice search ("play …") searches the library.
 */
@OptIn(UnstableApi::class)
class AutoLibrary(private val context: Context, private val scope: CoroutineScope) : MediaLibrarySession.Callback {
  private val app get() = context.applicationContext as App
  /** Last loaded songs per list, to queue the rest of a list. */
  private val lists = ConcurrentHashMap<String, List<Track>>()

  private fun folder(id: String, title: String, type: Int = MediaMetadata.MEDIA_TYPE_FOLDER_PLAYLISTS, subtitle: String? = null) =
    MediaItem.Builder().setMediaId(id).setMediaMetadata(
      MediaMetadata.Builder().setTitle(title).setSubtitle(subtitle).setIsBrowsable(true).setIsPlayable(false).setMediaType(type).build(),
    ).build()

  private fun song(listId: String, t: Track): MediaItem {
    val base = PlayerController.trackItem(t)
    return base.buildUpon().setMediaId("bt:$listId:${t.id}").setMediaMetadata(
      base.mediaMetadata.buildUpon().setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC).build(),
    ).build()
  }

  private fun mixTitle(m: Mix): String = when (m.kind) {
    "daily" -> context.getString(R.string.mix_daily, m.number)
    "discover" -> context.getString(R.string.mix_discover)
    "liked" -> context.getString(R.string.mix_liked)
    "decade" -> context.getString(R.string.mix_decade, "${m.decade}")
    "genre" -> context.getString(R.string.mix_genre, m.genre.orEmpty())
    else -> m.id
  }

  private fun <T> async(block: suspend () -> T): ListenableFuture<T> {
    val future = SettableFuture.create<T>()
    scope.launch {
      try { future.set(block()) } catch (e: Throwable) { future.setException(e) }
    }
    return future
  }

  override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> =
    Futures.immediateFuture(LibraryResult.ofItem(folder("root", context.getString(R.string.app_name)), params))

  override fun onGetChildren(
    session: MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = async {
    val items: List<MediaItem> = when {
      parentId == "root" -> listOf(
        folder("mixes", context.getString(R.string.home_mixes)),
        folder("playlists", context.getString(R.string.playlists)),
        folder("recent", context.getString(R.string.recent), MediaMetadata.MEDIA_TYPE_PLAYLIST),
        folder("liked", context.getString(R.string.liked_songs), MediaMetadata.MEDIA_TYPE_PLAYLIST),
        folder("offline", context.getString(R.string.offline_title), MediaMetadata.MEDIA_TYPE_PLAYLIST),
      )
      parentId == "mixes" -> app.api.mixes().map { folder("mix:${it.id}", mixTitle(it), MediaMetadata.MEDIA_TYPE_PLAYLIST, it.artists.take(3).joinToString(", ")) }
      parentId == "playlists" -> app.api.playlists().map { folder("playlist:${it.id}", it.name, MediaMetadata.MEDIA_TYPE_PLAYLIST) }
      else -> songsOf(parentId).map { song(parentId, it) }
    }
    val from = (page * pageSize).coerceAtLeast(0)
    val slice = if (pageSize in 1 until Int.MAX_VALUE) items.drop(from).take(pageSize) else items
    LibraryResult.ofItemList(ImmutableList.copyOf(slice), params)
  }

  private suspend fun songsOf(listId: String): List<Track> {
    val tracks = when {
      listId == "recent" -> app.api.recent()
      listId == "liked" -> app.api.tracks("favorites=1&limit=500")
      listId == "offline" -> Offline.tracksOnPhone()
      listId.startsWith("mix:") -> app.api.mix(listId.removePrefix("mix:")).second
      listId.startsWith("playlist:") -> app.api.playlist(listId.removePrefix("playlist:").toLong()).tracks
      else -> emptyList()
    }
    lists[listId] = tracks
    return tracks
  }

  override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> =
    Futures.immediateFuture(LibraryResult.ofItem(MediaItem.Builder().setMediaId(mediaId).build(), null))

  // A chosen song plays its whole list from there; a voice search plays the
  // matching library songs; anything else is resolved as before.
  override fun onSetMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = async {
    val one = mediaItems.singleOrNull()
    val query = one?.requestMetadata?.searchQuery
    val browsed = one?.mediaId?.takeIf { it.startsWith("bt:") }
    when {
      !query.isNullOrBlank() -> {
        val found = app.api.search(query).tracks
        MediaSession.MediaItemsWithStartPosition(found.map { PlaybackService.withPlayableUri(PlayerController.trackItem(it)) }, 0, 0)
      }
      browsed != null -> {
        val listId = browsed.removePrefix("bt:").substringBeforeLast(':')
        val trackId = browsed.substringAfterLast(':').toLongOrNull()
        val tracks = lists[listId] ?: songsOf(listId)
        val at = tracks.indexOfFirst { it.id == trackId }.coerceAtLeast(0)
        MediaSession.MediaItemsWithStartPosition(tracks.map { PlaybackService.withPlayableUri(PlayerController.trackItem(it)) }, at, startPositionMs.coerceAtLeast(0))
      }
      else -> MediaSession.MediaItemsWithStartPosition(mediaItems.map { PlaybackService.withPlayableUri(it) }, startIndex, startPositionMs)
    }
  }

  // Play pressed with an empty player (headset / Bluetooth / car after the
  // service was gone): continue the last saved queue where it stopped.
  override fun onPlaybackResumption(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
    val saved = QueueStore.read(context)
      ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
    return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(saved.items, saved.index, saved.positionMs))
  }

  // Controllers send items without their URIs; rebuild them from the id.
  override fun onAddMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
  ): ListenableFuture<MutableList<MediaItem>> =
    Futures.immediateFuture(mediaItems.map { item ->
      val id = item.mediaId
      if (id.startsWith("bt:")) {
        val trackId = id.substringAfterLast(':').toLongOrNull()
        val t = lists[id.removePrefix("bt:").substringBeforeLast(':')]?.firstOrNull { it.id == trackId }
        if (t != null) PlaybackService.withPlayableUri(PlayerController.trackItem(t)) else item
      } else PlaybackService.withPlayableUri(item)
    }.toMutableList())
}
