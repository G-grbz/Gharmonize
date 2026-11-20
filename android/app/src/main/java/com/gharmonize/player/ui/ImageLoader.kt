package com.gharmonize.player.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import com.gharmonize.player.App
import com.gharmonize.player.playback.Offline
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.security.MessageDigest
import java.net.URL

/**
 * Tiny image loader: memory LRU of display-sized bitmaps, a disk cache of the
 * downloaded bytes (so a bitmap dropped from memory comes back from disk, not
 * the network), auth for server artwork, downsampling.
 */
class ImageLoader(private val app: App) {
  private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 6 / 1024).toInt()) {
    override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
  }
  private val diskDir: File by lazy { File(app.cacheDir, "artwork").apply { mkdirs() } }
  private val offlineDir: File by lazy { File(app.filesDir, "offline-artwork").apply { mkdirs() } }
  private val offlineWriteLock = Any()
  // Up to 2 GB, but never more than a fifth of the space the phone has
  // (free + what this cache already uses): small phones keep their room.
  private val diskMaxBytes = 2048L * 1024 * 1024
  private val diskMinBytes = 150L * 1024 * 1024
  @Volatile private var lastTrim = 0L

  fun cached(key: String): Bitmap? = cache.get(key)

  suspend fun load(uri: Uri, maxPx: Int = 512): Bitmap? = withContext(Dispatchers.IO) { loadBlocking(uri, maxPx) }

  fun loadBlocking(uri: Uri, maxPx: Int = 512): Bitmap? {
    val key = "$uri@$maxPx"
    offlineArtworkTrackId(uri)?.let { id ->
      val file = offlineFile(id)
      if (file.isFile) {
        val offlineKey = "$key:offline:${file.lastModified()}"
        cache.get(offlineKey)?.let { return it }
        val bytes = runCatching { file.readBytes() }.getOrNull()
        bytes?.let { decode(it, maxPx) }?.let { bitmap ->
          cache.put(offlineKey, bitmap)
          return bitmap
        }
      }
    }
    readCached(key, maxPx)?.let { return it }
    val file = File(diskDir, sha1(key))
    return try {
      val (url, headers) = app.resolveUrl(uri) ?: (uri.toString() to emptyMap())
      val conn = URL(url).openConnection() as HttpURLConnection
      conn.connectTimeout = 8000
      conn.readTimeout = 15000
      headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
      val bytes = try {
        if (conn.responseCode != 200) return null
        conn.inputStream.use { it.readBytes() }
      } finally {
        conn.disconnect()
      }
      decode(bytes, maxPx)?.also { bmp ->
        cache.put(key, bmp)
        // Stored re-encoded at display size: small files, fast to decode.
        runCatching { writeArtwork(file, bmp) }
        trimDiskSometimes()
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun readCached(key: String, maxPx: Int): Bitmap? {
    cache.get(key)?.let { return it }
    val file = File(diskDir, sha1(key))
    if (file.isFile) {
      val bytes = runCatching { file.readBytes() }.getOrNull()
      val bmp = bytes?.let { decode(it, maxPx) }
      if (bmp != null) {
        file.setLastModified(System.currentTimeMillis())
        cache.put(key, bmp)
        return bmp
      }
      file.delete()
    }
    return null
  }

  private fun offlineFile(trackId: Long) = File(offlineDir, "$trackId.jpg")

  fun hasOfflineArtwork(trackId: Long) = offlineFile(trackId).isFile

  fun saveOfflineArtwork(trackId: Long, ref: String, connected: Boolean, stillNeeded: () -> Boolean): Boolean {
    val size = 900
    val uri = App.artworkUri(ref, size) ?: return false
    val legacy = sequenceOf(size, 512, 300, 128).mapNotNull { px ->
      App.artworkUri(ref, px)?.let { readCached("$it@$px", px) }
    }
    val bitmap = (if (connected) loadBlocking(uri, size) else null) ?: legacy.firstOrNull() ?: return false
    return runCatching { writeArtwork(offlineFile(trackId), bitmap, stillNeeded) }.getOrDefault(false)
  }

  fun removeOfflineArtwork(trackId: Long) {
    synchronized(offlineWriteLock) { offlineFile(trackId).delete() }
  }

  private fun writeArtwork(file: File, bitmap: Bitmap, stillNeeded: (() -> Boolean)? = null): Boolean {
    val tmp = File.createTempFile(file.name, ".tmp", file.parentFile)
    return try {
      val written = tmp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 88, it) }
      if (!written) return false
      if (stillNeeded == null) tmp.renameTo(file)
      else synchronized(offlineWriteLock) { stillNeeded() && tmp.renameTo(file) }
    } finally {
      tmp.delete()
    }
  }

  /** Decodes and scales to at most maxPx on the longer side. */
  fun decode(bytes: ByteArray, maxPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= maxPx && bounds.outHeight / (sample * 2) >= maxPx) sample *= 2
    val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    val longer = maxOf(decoded.width, decoded.height)
    if (longer <= maxPx) return decoded
    val scale = maxPx.toFloat() / longer
    val scaled = Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true)
    if (scaled !== decoded) decoded.recycle()
    return scaled
  }

  // Oldest files go first once the folder is over its budget.
  private fun trimDiskSometimes() {
    val now = System.currentTimeMillis()
    if (now - lastTrim < 60_000) return
    lastTrim = now
    val files = diskDir.listFiles()?.filter { it.isFile } ?: return
    var total = files.sumOf { it.length() }
    val limit = minOf(diskMaxBytes, maxOf(diskMinBytes, (diskDir.usableSpace + total) / 5))
    if (total <= limit) return
    for (f in files.sortedBy { it.lastModified() }) {
      if (total <= limit * 8 / 10) break
      total -= f.length()
      f.delete()
    }
  }

  private fun sha1(text: String): String =
    MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
}

private fun offlineArtworkTrackId(uri: Uri?): Long? {
  if (uri?.scheme != App.SCHEME || uri.host != "artwork") return null
  val parts = uri.pathSegments
  return parts.getOrNull(1)?.toLongOrNull()?.takeIf { parts.firstOrNull() == "track" }
}

/** Artwork with a tinted placeholder while loading or when there is none. */
@Composable
fun Artwork(
  ref: String?,
  modifier: Modifier = Modifier,
  shape: Shape = MaterialTheme.shapes.small,
  size: Int = 256,
  placeholder: ImageVector = FluentIcons.MusicNote,
) {
  val uri = remember(ref, size) { App.artworkUri(ref, size) }
  val key = "$uri@$size"
  val offlineReady = offlineArtworkTrackId(uri)?.let { Offline.artworkReady[it] } == true
  var bitmap by remember(key) { mutableStateOf(App.instance.images.cached(key)) }
  LaunchedEffect(key, offlineReady) {
    if ((bitmap == null || offlineReady) && uri != null) bitmap = App.instance.images.load(uri, size) ?: bitmap
  }
  Box(modifier.clip(shape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
    val bmp = bitmap
    if (bmp != null) {
      Image(bmp.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
    } else {
      Icon(placeholder, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
