package com.gharmonize.player.data

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.ui.MainActivity
import org.json.JSONObject

/**
 * New releases of followed artists as phone notifications. The server keeps
 * the notifications; the phone asks when the app opens / comes back and while
 * music plays, and shows the ones it has not shown before.
 */
object ReleaseNotifier {
  const val CHANNEL = "releases"
  const val EXTRA_OPEN = "open_online"

  data class Item(val id: Long, val title: String, val body: String, val artworkUrl: String?, val read: Boolean, val single: Boolean, val data: JSONObject?, val createdAt: Long, val kind: String = "release", val link: String? = null) {
    /** A new Gharmonize release (only administrators get these). */
    val isAppUpdate get() = kind == "app-update"
    /** The GitHub release page of an update notice. */
    val releaseUrl get() = link?.takeIf { isAppUpdate && it.startsWith("https://github.com/") }
  }

  fun parse(o: JSONObject) = Item(
    kind = o.optString("kind", "release"),
    link = o.optString("link").takeIf { it.isNotBlank() },
    id = o.optLong("id"),
    title = o.optString("title"),
    body = o.optString("body"),
    artworkUrl = o.optString("artworkUrl").takeIf { it.startsWith("https://") },
    read = o.optBoolean("read"),
    single = o.optJSONObject("data")?.optString("recordKind") == "single",
    data = o.optJSONObject("data"),
    createdAt = o.optLong("createdAt"),
  )

  /** Fetches notifications, posts the new unread ones, returns (items, unread). */
  suspend fun check(app: App): Pair<List<Item>, Int> {
    val res = app.api.notifications()
    val items = res.optJSONArray("items").let { a -> (0 until (a?.length() ?: 0)).mapNotNull { a!!.optJSONObject(it)?.let(::parse) } }
    val last = app.prefs.lastNotificationId
    val fresh = items.filter { !it.read && it.id > last }
    if (fresh.isNotEmpty()) {
      app.prefs.lastNotificationId = fresh.maxOf { it.id }
      // The first run after installing only remembers where it is.
      if (last > 0) fresh.take(5).forEach { post(app, it) }
    }
    return items to res.optInt("unread")
  }

  private fun post(context: Context, item: Item) {
    if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    val nm = context.getSystemService(NotificationManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.notif_channel), NotificationManager.IMPORTANCE_DEFAULT))
    }
    val release = item.releaseUrl
    val open = if (release != null) {
      Intent(Intent.ACTION_VIEW, Uri.parse(release)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } else {
      Intent(context, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        .putExtra(EXTRA_OPEN, item.data?.toString())
    }
    val pending = PendingIntent.getActivity(context, item.id.toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val kind = context.getString(
      when {
        item.isAppUpdate -> R.string.notif_update
        item.single -> R.string.notif_new_single
        else -> R.string.notif_new_album
      }
    )
    val n = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.media3_notification_small_icon)
      .setContentTitle(if (item.isAppUpdate) item.title else "${item.body}: ${item.title}")
      .setContentText(kind)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .build()
    nm.notify(10_000 + item.id.toInt(), n)
  }
}
