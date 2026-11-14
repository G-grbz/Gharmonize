package com.gharmonize.player.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL

/**
 * Picks the server address that works right now. The pairing QR code carries
 * every known address (home network, Tailscale, custom); at home the LAN one
 * answers, away from home the Tailscale one does. The choice is dropped when
 * the phone's network changes and re-probed on the next request.
 */
class ServerManager(context: Context, private val prefs: Prefs) {
  private val mutex = Mutex()
  @Volatile private var current: String? = null
  private val _active = MutableStateFlow<String?>(null)
  val active: StateFlow<String?> = _active
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  @Volatile private var lastVpn = false

  init {
    connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = invalidate()
      override fun onLost(network: Network) = invalidate()
      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        // VPN (Tailscale) coming up or going down changes what is reachable.
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) != lastVpn) {
          lastVpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
          invalidate()
        }
      }
    })
  }

  fun invalidate() {
    current = null
    _active.value = null
  }

  /** Metered (mobile data) networks use the "mobile" streaming quality. */
  fun isMetered(): Boolean = connectivity?.isActiveNetworkMetered ?: false

  suspend fun current(): String? {
    current?.let { return it }
    return mutex.withLock {
      current ?: withContext(Dispatchers.IO) { probeAll() }.also {
        current = it
        _active.value = it
        if (it != null) prefs.lastGoodServer = it
      }
    }
  }

  /** For Media3 loader threads (already off the main thread). */
  fun currentBlocking(): String? = current ?: runBlocking { current() }

  private fun ordered(): List<String> {
    val all = prefs.servers
    val last = prefs.lastGoodServer
    return if (last != null && last in all) listOf(last) + (all - last) else all
  }

  private fun probeAll(): String? {
    for (base in ordered()) if (probe(base)) return base
    return null
  }

  fun probe(base: String, timeoutMs: Int = 2500): Boolean = try {
    val conn = URL("$base/api/player/status").openConnection() as HttpURLConnection
    conn.connectTimeout = timeoutMs
    conn.readTimeout = timeoutMs
    conn.setRequestProperty("Accept", "application/json")
    try {
      conn.responseCode == 200 && conn.inputStream.bufferedReader().use { it.readText() }.contains("\"enabled\":true")
    } finally {
      conn.disconnect()
    }
  } catch (_: Exception) {
    false
  }
}
