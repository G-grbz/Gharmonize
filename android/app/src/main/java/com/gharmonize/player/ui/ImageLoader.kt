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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/** Tiny image loader: memory LRU cache, auth for server artwork, downsampling. */
class ImageLoader(private val app: App) {
  private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 8 / 1024).toInt()) {
    override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
  }

  fun cached(key: String): Bitmap? = cache.get(key)

  suspend fun load(uri: Uri, maxPx: Int = 512): Bitmap? = withContext(Dispatchers.IO) { loadBlocking(uri, maxPx) }

  fun loadBlocking(uri: Uri, maxPx: Int = 512): Bitmap? {
    val key = "$uri@$maxPx"
    cache.get(key)?.let { return it }
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
      decode(bytes, maxPx)?.also { cache.put(key, it) }
    } catch (_: Exception) {
      null
    }
  }

  fun decode(bytes: ByteArray, maxPx: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= maxPx && bounds.outHeight / (sample * 2) >= maxPx) sample *= 2
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
  }
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
  var bitmap by remember(key) { mutableStateOf(App.instance.images.cached(key)) }
  LaunchedEffect(key) {
    if (bitmap == null && uri != null) bitmap = App.instance.images.load(uri, size)
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
