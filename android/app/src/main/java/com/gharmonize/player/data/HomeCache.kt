package com.gharmonize.player.data

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * The last home page answers (library shelves, online shelves) kept on the
 * phone: the home screen shows them at once and refreshes behind them, and
 * still has something to show when the server cannot be reached.
 */
object HomeCache {
  private fun dir(context: Context) = File(context.filesDir, "home-cache")

  private fun file(context: Context, name: String): File {
    val user = (context.applicationContext as? com.gharmonize.player.App)?.prefs?.userJson?.optLong("id") ?: 0L
    return File(dir(context), "$user-$name.json")
  }

  fun read(context: Context, name: String): JSONObject? = runCatching {
    val f = file(context, name)
    if (f.isFile) JSONObject(f.readText()) else null
  }.getOrNull()

  fun write(context: Context, name: String, value: JSONObject) {
    runCatching {
      dir(context).mkdirs()
      val f = file(context, name)
      val tmp = File(f.path + ".tmp")
      tmp.writeText(value.toString())
      tmp.renameTo(f)
    }
  }

  fun clear(context: Context) {
    runCatching { dir(context).deleteRecursively() }
  }
}
