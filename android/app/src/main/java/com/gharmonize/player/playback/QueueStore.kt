package com.gharmonize.player.playback

import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import com.gharmonize.player.App
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The last queue, song and position kept on the phone (per signed-in user),
 * like the web player's saved queue: after the app or the phone restarts the
 * last song is back in the player, paused, and play continues where it was.
 * Only library songs are kept; online previews expire anyway.
 */
object QueueStore {
  class Saved(val items: List<MediaItem>, val index: Int, val positionMs: Long, val shuffle: Boolean, val repeatMode: Int)

  private const val MAX_BEFORE = 100
  private const val MAX_ITEMS = 500

  private fun file(context: Context): File? {
    val app = context.applicationContext as? App ?: return null
    if (!app.prefs.signedIn) return null
    val user = app.prefs.userJson?.optLong("id") ?: 0L
    return File(File(context.filesDir, "queue"), "$user.json")
  }

  /** Snapshot of the player (call on the player's thread); null = nothing to keep. */
  fun snapshot(player: Player): JSONObject? {
    val all = (0 until player.mediaItemCount).map(player::getMediaItemAt)
    val current = player.currentMediaItemIndex
    val kept = all.withIndex().filter { it.value.mediaId.startsWith("t:") }
    if (kept.isEmpty()) return null
    // Index of the current song among the kept ones (an online preview in
    // between counts as the next library song, from its start).
    var at = kept.indexOfFirst { it.index >= current }.let { if (it < 0) kept.lastIndex else it }
    val exact = kept.getOrNull(at)?.index == current
    val from = (at - MAX_BEFORE).coerceAtLeast(0)
    val slice = kept.subList(from, (from + MAX_ITEMS).coerceAtMost(kept.size))
    at -= from
    return JSONObject()
      .put("items", JSONArray().apply { slice.forEach { put(encode(it.value)) } })
      .put("index", at)
      .put("position", if (exact) player.currentPosition.coerceAtLeast(0) else 0L)
      .put("shuffle", player.shuffleModeEnabled)
      .put("repeat", player.repeatMode)
  }

  fun write(context: Context, snapshot: JSONObject?) {
    val f = file(context) ?: return
    runCatching {
      if (snapshot == null) { f.delete(); return }
      f.parentFile?.mkdirs()
      val tmp = File(f.path + ".tmp")
      tmp.writeText(snapshot.toString())
      if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }
  }

  fun read(context: Context): Saved? = runCatching {
    val f = file(context)?.takeIf { it.isFile } ?: return null
    val o = JSONObject(f.readText())
    val arr = o.optJSONArray("items") ?: return null
    val items = (0 until arr.length()).mapNotNull { decode(arr.optJSONObject(it)) }
    if (items.isEmpty()) return null
    val repeat = o.optInt("repeat", Player.REPEAT_MODE_OFF)
    Saved(
      items = items,
      index = o.optInt("index", 0).coerceIn(0, items.lastIndex),
      positionMs = o.optLong("position", 0L).coerceAtLeast(0L),
      shuffle = o.optBoolean("shuffle", false),
      repeatMode = if (repeat in Player.REPEAT_MODE_OFF..Player.REPEAT_MODE_ALL) repeat else Player.REPEAT_MODE_OFF,
    )
  }.getOrNull()

  private val EXTRA_LONGS = listOf("trackId", "albumId", "artistId")
  private val EXTRA_FLAGS = listOf("favorite", "auto", "downloadsOnly")

  private fun encode(item: MediaItem): JSONObject {
    val m = item.mediaMetadata
    val extras = m.extras
    return JSONObject().apply {
      put("id", item.mediaId)
      m.title?.let { put("title", it.toString()) }
      m.artist?.let { put("artist", it.toString()) }
      m.albumTitle?.let { put("album", it.toString()) }
      m.genre?.let { put("genre", it.toString()) }
      m.recordingYear?.let { put("year", it) }
      m.artworkUri?.let { put("artwork", it.toString()) }
      if (extras != null) {
        EXTRA_LONGS.forEach { k -> if (extras.containsKey(k)) put(k, extras.getLong(k)) }
        EXTRA_FLAGS.forEach { k -> if (extras.getBoolean(k)) put(k, true) }
        if (extras.containsKey("duration")) put("duration", extras.getDouble("duration"))
      }
    }
  }

  private fun decode(o: JSONObject?): MediaItem? {
    if (o == null) return null
    val id = o.optString("id")
    val trackId = id.removePrefix("t:").toLongOrNull()?.takeIf { id.startsWith("t:") } ?: return null
    val extras = Bundle().apply {
      EXTRA_LONGS.forEach { k -> putLong(k, o.optLong(k, if (k == "trackId") trackId else 0L)) }
      EXTRA_FLAGS.forEach { k -> if (o.optBoolean(k)) putBoolean(k, true) }
      putDouble("duration", o.optDouble("duration", 0.0))
    }
    return MediaItem.Builder()
      .setMediaId(id)
      .setUri(App.streamUri(trackId))
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(o.optString("title").takeIf { it.isNotEmpty() })
          .setArtist(o.optString("artist").takeIf { it.isNotEmpty() })
          .setAlbumTitle(o.optString("album").takeIf { it.isNotEmpty() })
          .setGenre(o.optString("genre").takeIf { it.isNotEmpty() })
          .setRecordingYear(if (o.has("year")) o.optInt("year") else null)
          .setArtworkUri(o.optString("artwork").takeIf { it.isNotEmpty() }?.let(Uri::parse))
          .setIsPlayable(true)
          .setIsBrowsable(false)
          .setExtras(extras)
          .build(),
      )
      .build()
  }
}
