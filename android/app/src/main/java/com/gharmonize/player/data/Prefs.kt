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

  /** Now playing progress look: "ring" | "classic" | "bold" | "minimal" | "wave". */
  var progressStyle: String
    get() = sp.getString("progress_style", "ring") ?: "ring"
    set(value) = sp.edit().putString("progress_style", value).apply()

  /** Keep playing similar library songs when the queue ends. */
  var autoplay: Boolean
    get() = sp.getBoolean("autoplay", true)
    set(value) = sp.edit().putBoolean("autoplay", value).apply()

  /** Volume arc on the right of the round cover (drag along it). */
  var coverVolume: Boolean
    get() = sp.getBoolean("cover_volume", true)
    set(value) = sp.edit().putBoolean("cover_volume", value).apply()

  // ---- equalizer ----
  var eqEnabled: Boolean
    get() = sp.getBoolean("eq_enabled", false)
    set(value) = sp.edit().putBoolean("eq_enabled", value).apply()

  var eqPreset: String
    get() = sp.getString("eq_preset", "flat") ?: "flat"
    set(value) = sp.edit().putString("eq_preset", value).apply()

  var eqGains: FloatArray
    get() = runCatching {
      val arr = JSONArray(sp.getString("eq_gains", "[]"))
      FloatArray(arr.length()) { arr.getDouble(it).toFloat() }
    }.getOrDefault(FloatArray(0))
    set(value) = sp.edit().putString("eq_gains", JSONArray(value.map { it.toDouble() }).toString()).apply()

  var eqAutoPreamp: Boolean
    get() = sp.getBoolean("eq_auto_preamp", true)
    set(value) = sp.edit().putBoolean("eq_auto_preamp", value).apply()

  var eqPreamp: Float
    get() = sp.getFloat("eq_preamp", 0f)
    set(value) = sp.edit().putFloat("eq_preamp", value).apply()

  val signedIn: Boolean get() = !token.isNullOrBlank() && servers.isNotEmpty()

  fun signOut() {
    sp.edit().remove("token").remove("user").apply()
  }
}
