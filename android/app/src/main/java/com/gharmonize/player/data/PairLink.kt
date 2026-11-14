package com.gharmonize.player.data

import android.net.Uri

/**
 * Pairing link from the QR code shown in the web player:
 *   http://192.168.1.20:5175/player/#/pair?code=ABCD2345&s=Server&alt=http%3A%2F%2F100.x…
 * The scanned address comes first; `alt` adds the other known addresses
 * (Tailscale, custom) so the app keeps working away from home.
 */
data class PairLink(val servers: List<String>, val code: String, val serverName: String?)

object PairLinks {
  fun parse(text: String): PairLink? {
    val raw = text.trim()
    val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    val fragment = uri.encodedFragment ?: return null
    if (!fragment.startsWith("/pair?")) return null
    val params = Uri.parse("x://pair?" + fragment.removePrefix("/pair?"))
    val code = normalizeCode(params.getQueryParameter("code") ?: return null) ?: return null
    val path = (uri.path ?: "").removeSuffix("/").removeSuffix("/player")
    val base = normalizeBase("$scheme://${uri.encodedAuthority}$path") ?: return null
    val alts = params.getQueryParameters("alt").mapNotNull(::normalizeBase)
    return PairLink((listOf(base) + alts).distinct(), code, params.getQueryParameter("s"))
  }

  fun normalizeCode(value: String): String? =
    value.uppercase().filter { it.isLetterOrDigit() }.takeIf { it.length == 8 }

  /** "192.168.1.20:5175" → "http://192.168.1.20:5175"; strips "/player" and slashes. */
  fun normalizeBase(value: String): String? {
    var v = value.trim()
    if (v.isEmpty()) return null
    if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://$v"
    val uri = runCatching { Uri.parse(v) }.getOrNull() ?: return null
    if (uri.host.isNullOrBlank()) return null
    val path = (uri.path ?: "").removeSuffix("/").removeSuffix("/player").removeSuffix("/")
    return "${uri.scheme}://${uri.encodedAuthority}$path"
  }
}
