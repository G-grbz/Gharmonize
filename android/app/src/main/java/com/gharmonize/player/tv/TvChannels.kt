package com.gharmonize.player.tv

import android.content.BroadcastReceiver
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Rect
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.tvprovider.media.tv.PreviewChannel
import androidx.tvprovider.media.tv.PreviewChannelHelper
import androidx.tvprovider.media.tv.PreviewProgram
import androidx.tvprovider.media.tv.TvContractCompat
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.Mix
import com.gharmonize.player.data.mapObjects
import com.gharmonize.player.data.parseAlbum
import com.gharmonize.player.data.parseTrack
import com.gharmonize.player.ui.decadeLabel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Rows on the Android TV home screen (like Jellyfin / Emby / YouTube):
 *  - "For you" (the app's default channel, shown without asking): daily /
 *    discover / decade mixes, then the user's playlists;
 *  - "Recently played": recent songs (OK plays from there) and albums to jump
 *    back into. Android asks the user once before showing a second row.
 * Updated when the TV app opens (and when the launcher asks); nothing runs in
 * the background otherwise. Unchanged rows are not rewritten.
 */
object TvChannels {
  private const val TAG = "TvChannels"
  const val FOR_YOU = "for_you"
  const val RECENT = "recent"
  const val EXTRA_OPEN = "com.gharmonize.player.tv.OPEN"
  private const val MAX_PROGRAMS = 20
  private val lock = Mutex()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  private class Item(val key: String, val type: Int, val title: String, val description: String, val art: List<String>, val open: String)

  fun supported(context: Context) =
    context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)

  fun syncSoon(context: Context) {
    val app = context.applicationContext
    if (!supported(app)) return
    scope.launch { runCatching { sync(app) }.onFailure { Log.w(TAG, "sync failed: ${it.message}") } }
  }

  /** Publishes / refreshes both rows. Returns the ids of rows not shown yet (key → id). */
  suspend fun sync(context: Context): Map<String, Long> = lock.withLock {
    withContext(Dispatchers.IO) {
      val app = App.instance
      if (!app.prefs.signedIn || !supported(context)) return@withContext emptyMap()
      val api = app.api
      val mixes = runCatching { api.mixes() }.getOrDefault(emptyList())
      val playlists = runCatching { api.playlists() }.getOrDefault(emptyList()).filter { it.editable }
      val home = runCatching { api.home() }.getOrNull()
      val shelves = home?.optJSONArray("shelves").mapObjects { it }

      val forYou = buildList {
        mixes.forEach { m -> add(Item("mix:${m.id}", TvContractCompat.PreviewPrograms.TYPE_PLAYLIST, mixName(context, m), m.artists.take(3).joinToString(", "), m.covers.take(4), "mix:${m.id}")) }
        playlists.forEach { p ->
          add(Item("pl:${p.id}", TvContractCompat.PreviewPrograms.TYPE_PLAYLIST, p.name, context.getString(R.string.count_songs, p.trackCount),
            listOfNotNull(p.artwork.takeIf { p.trackCount > 0 }), "playlist:${p.id}"))
        }
      }.take(MAX_PROGRAMS)

      val recentTracks = shelves.firstOrNull { it.optString("id") == "recently-played" }?.optJSONArray("items").mapObjects(::parseTrack)
      val backIn = shelves.firstOrNull { it.optString("id") == "jump-back-in" }?.optJSONArray("items").mapObjects(::parseAlbum)
      val ids = recentTracks.take(MAX_PROGRAMS).joinToString(",") { it.id.toString() }
      val recent = buildList {
        recentTracks.take(12).forEachIndexed { i, t ->
          add(Item("t:${t.id}", TvContractCompat.PreviewPrograms.TYPE_TRACK, t.title, t.artist,
            listOf(t.artwork ?: t.albumId?.let { "album/$it" } ?: "track/${t.id}"), "play:$ids|$i"))
        }
        backIn.take(8).forEach { a -> add(Item("a:${a.id}", TvContractCompat.PreviewPrograms.TYPE_ALBUM, a.title, a.artist, listOfNotNull(a.artwork), "album:${a.id}")) }
      }

      val helper = PreviewChannelHelper(context)
      val state = runCatching { JSONObject(app.prefs.tvChannelState ?: "{}") }.getOrDefault(JSONObject())
      val out = mutableMapOf<String, Long>()
      val hidden = mutableSetOf<String>()
      for ((key, items) in listOf(FOR_YOU to forYou, RECENT to recent)) {
        val name = context.getString(if (key == FOR_YOU) R.string.tv_channel_for_you else R.string.tv_channel_recent)
        val ch = ensureChannel(context, helper, key, name)
        val channelId = ch.id
        out[key] = channelId
        if (!ch.browsable) hidden += key
        val signature = sha1(name + "\n" + items.joinToString("\n") { "${it.key}|${it.title}|${it.description}|${it.art.joinToString(",")}|${it.open}" })
        if (state.optString(key) == "$channelId:$signature" && items.isNotEmpty()) continue
        replacePrograms(context, helper, channelId, items)
        state.put(key, "$channelId:$signature")
      }
      app.prefs.tvChannelState = state.toString()
      if (FOR_YOU in hidden) runCatching { TvContractCompat.requestChannelBrowsable(context, out.getValue(FOR_YOU)) }
      // Only rows the user has not switched on yet are returned for asking.
      out.filterKeys { it in hidden || it == FOR_YOU }
    }
  }

  /** Signing out removes the rows (they show this account's music). */
  fun clear(context: Context) {
    val app = context.applicationContext
    if (!supported(app)) return
    scope.launch {
      lock.withLock {
        runCatching {
          val helper = PreviewChannelHelper(app)
          channels(app).forEach { helper.deletePreviewChannel(it.id) }
        }
        App.instance.prefs.tvChannelState = null
        File(app.cacheDir, ART_DIR).listFiles()?.forEach { it.delete() }
      }
    }
  }

  private class Channel(val id: Long, val key: String?, val browsable: Boolean)

  /** This app's channels (tvprovider's own listing crashes on empty columns). */
  private fun channels(context: Context): List<Channel> {
    val out = mutableListOf<Channel>()
    runCatching {
      context.contentResolver.query(TvContractCompat.Channels.CONTENT_URI,
        arrayOf(TvContractCompat.Channels._ID, TvContractCompat.Channels.COLUMN_INTERNAL_PROVIDER_ID, TvContractCompat.Channels.COLUMN_BROWSABLE),
        null, null, null)?.use { c ->
        while (c.moveToNext()) out += Channel(c.getLong(0), if (c.isNull(1)) null else c.getString(1), c.getInt(2) == 1)
      }
    }.onFailure { Log.w(TAG, "channel list failed: ${it.message}") }
    return out
  }

  /** The channel for [key] (made once; extra copies from older versions are removed). */
  private fun ensureChannel(context: Context, helper: PreviewChannelHelper, key: String, name: String): Channel {
    val all = channels(context)
    val mine = all.filter { it.key == key }.sortedWith(compareByDescending<Channel> { it.browsable }.thenBy { it.id })
    mine.drop(1).forEach { runCatching { helper.deletePreviewChannel(it.id) } }
    val logo = BitmapFactory.decodeResource(context.resources, R.drawable.gharmonize_logo)
    val launch = Intent(context, TvActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val channel = PreviewChannel.Builder()
      .setDisplayName(name)
      .setDescription(name)
      .setInternalProviderId(key)
      .setAppLinkIntentUri(Uri.parse(launch.toUri(Intent.URI_INTENT_SCHEME)))
      .setLogo(logo)
      .build()
    mine.firstOrNull()?.let { existing ->
      runCatching { helper.updatePreviewChannel(existing.id, channel) }
      return existing
    }
    return Channel(helper.publishChannel(channel), key, false)
  }

  private fun replacePrograms(context: Context, helper: PreviewChannelHelper, channelId: Long, items: List<Item>) {
    val old = mutableListOf<Long>()
    context.contentResolver.query(TvContractCompat.buildPreviewProgramsUriForChannel(channelId), arrayOf(TvContractCompat.PreviewPrograms._ID), null, null, null)?.use { c ->
      while (c.moveToNext()) old += c.getLong(0)
    }
    old.forEach { runCatching { helper.deletePreviewProgram(it) } }
    for ((i, item) in items.withIndex()) {
      val poster = runCatching { posterUri(context, item.art) }.getOrNull()
      val open = Intent(context, TvActivity::class.java).setAction(EXTRA_OPEN).putExtra(EXTRA_OPEN, item.open)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val program = PreviewProgram.Builder()
        .setChannelId(channelId)
        .setType(item.type)
        .setTitle(item.title)
        .setDescription(item.description)
        .setInternalProviderId(item.key)
        .setWeight(items.size - i)
        .setPosterArtAspectRatio(TvContractCompat.PreviewPrograms.ASPECT_RATIO_1_1)
        .setIntentUri(Uri.parse(open.toUri(Intent.URI_INTENT_SCHEME)))
        .apply { if (poster != null) setPosterArtUri(poster) }
        .build()
      runCatching { helper.publishPreviewProgram(program) }.onFailure { Log.w(TAG, "program ${item.key}: ${it.message}") }
    }
  }

  private fun mixName(context: Context, mix: Mix): String = when (mix.kind) {
    "daily" -> context.getString(R.string.mix_daily, mix.number)
    "discover" -> context.getString(R.string.mix_discover)
    "liked" -> context.getString(R.string.mix_liked)
    "decade" -> context.getString(R.string.mix_decade, decadeLabel(mix.decade))
    else -> mix.id
  }

  // ---- artwork ------------------------------------------------------------------------------

  const val ART_DIR = "tv-art"

  /**
   * The launcher cannot sign in to the server, so covers are fetched here and
   * served by [TvArtProvider]. A mix with four covers gets a 2×2 mosaic.
   */
  private fun posterUri(context: Context, refs: List<String>): Uri? {
    if (refs.isEmpty()) return null
    val dir = File(context.cacheDir, ART_DIR).apply { mkdirs() }
    val name = sha1(refs.joinToString("|")) + ".jpg"
    val file = File(dir, name)
    if (!file.exists() || file.length() < 500) {
      val bitmaps = refs.take(if (refs.size >= 4) 4 else 1).mapNotNull { download(it) }
      if (bitmaps.isEmpty()) return null
      val size = 400
      val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(out)
      if (bitmaps.size >= 4) {
        val half = size / 2
        bitmaps.take(4).forEachIndexed { i, b -> canvas.drawBitmap(b, null, Rect((i % 2) * half, (i / 2) * half, (i % 2 + 1) * half, (i / 2 + 1) * half), null) }
      } else canvas.drawBitmap(bitmaps[0], null, Rect(0, 0, size, size), null)
      val tmp = File(dir, "$name.tmp")
      tmp.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 88, it) }
      tmp.renameTo(file)
    }
    return Uri.parse("content://${context.packageName}.tvart/$name")
  }

  private fun download(ref: String): Bitmap? {
    val (url, headers) = App.instance.resolveUrl(Uri.parse("ghp://artwork/$ref?size=256")) ?: return null
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 10_000
      readTimeout = 15_000
      headers.forEach { (k, v) -> setRequestProperty(k, v) }
    }
    return try {
      if (conn.responseCode !in 200..299) null else conn.inputStream.use { BitmapFactory.decodeStream(it) }
    } catch (e: Exception) { null } finally { conn.disconnect() }
  }

  private fun sha1(text: String) = MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
}

/** Serves the cached row covers to the TV launcher (read-only, that folder only). */
class TvArtProvider : ContentProvider() {
  private val name = Regex("^[0-9a-f]{24}\\.jpg$")

  override fun onCreate() = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
    if (mode != "r") throw SecurityException("read only")
    val file = uri.lastPathSegment?.takeIf { name.matches(it) }?.let { File(File(context!!.cacheDir, TvChannels.ART_DIR), it) }
    if (file == null || !file.isFile) throw java.io.FileNotFoundException(uri.toString())
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun getType(uri: Uri) = "image/jpeg"
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
  override fun insert(uri: Uri, values: ContentValues?): Uri? = null
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
}

/** The launcher asks for the rows (after install, or when it was reset). */
class TvChannelsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    TvChannels.syncSoon(context)
  }
}
