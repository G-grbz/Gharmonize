package com.gharmonize.player.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Small persistent settings store (app-private SharedPreferences). */
class Prefs(context: Context) {
  private val sp = context.getSharedPreferences("gharmonize_player", Context.MODE_PRIVATE)

  /** Server base URLs in preference order (home network first, Tailscale next…). */
  var servers: List<String>
    get() = runCatching {
      val arr = JSONArray(sp.getString("servers", "[]"))
      (0 until arr.length()).map { arr.getString(it) }
    }.getOrDefault(emptyList())
    set(value) = sp.edit().putString("servers", JSONArray(value.distinct()).toString()).apply()

  var lastGoodServer: String?
    get() = sp.getString("last_good_server", null)
    set(value) = sp.edit().putString("last_good_server", value).apply()

  var token: String?
    get() = sp.getString("token", null)
    set(value) = sp.edit().putString("token", value).apply()

  var serverName: String
    get() = sp.getString("server_name", "Gharmonize Player") ?: "Gharmonize Player"
    set(value) = sp.edit().putString("server_name", value).apply()

  var userJson: JSONObject?
    get() = sp.getString("user", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
    set(value) = sp.edit().putString("user", value?.toString()).apply()

  /** Streaming quality on Wi-Fi / unmetered networks. */
  var qualityWifi: String
    get() = sp.getString("quality_wifi", "original") ?: "original"
    set(value) = sp.edit().putString("quality_wifi", value).apply()

  /** Streaming quality on mobile data / metered networks. */
  var qualityMobile: String
    get() = sp.getString("quality_mobile", "normal") ?: "normal"
    set(value) = sp.edit().putString("quality_mobile", value).apply()

  /** "system" | "dark" | "light" */
  var theme: String
    get() = sp.getString("theme", "system") ?: "system"
    set(value) = sp.edit().putString("theme", value).apply()

  val signedIn: Boolean get() = !token.isNullOrBlank() && servers.isNotEmpty()

  fun signOut() {
    sp.edit().remove("token").remove("user").apply()
  }
}
