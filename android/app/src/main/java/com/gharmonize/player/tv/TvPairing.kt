package com.gharmonize.player.tv

import android.graphics.Bitmap
import android.net.Uri
import com.gharmonize.player.App
import com.gharmonize.player.data.ApiException
import com.gharmonize.player.data.PairLinks
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * Pairing a TV from the phone.
 *
 * The TV listens on its home-network address and shows a QR code:
 *   gharmonize-tv://pair?h=192.168.1.30:41234&n=<nonce>&name=<TV name>
 * The signed-in phone scans it, asks the server for a one-time pairing code
 * and sends {nonce, code, servers, serverName} to the TV. The TV redeems the
 * code itself, so it gets its own device token (listed and revocable under
 * the user's devices). Nobody has to type on the TV.
 */
object TvPairLink {
  const val SCHEME = "gharmonize-tv"

  data class Target(val host: String, val nonce: String, val name: String)

  fun build(host: String, nonce: String, name: String): String =
    "$SCHEME://pair?h=${Uri.encode(host)}&n=${Uri.encode(nonce)}&name=${Uri.encode(name)}"

  fun parse(text: String): Target? {
    val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return null
    if (uri.scheme != SCHEME || uri.host != "pair") return null
    val host = uri.getQueryParameter("h")?.takeIf { Regex("^[0-9.]{7,15}:[0-9]{2,5}$").matches(it) } ?: return null
    val nonce = uri.getQueryParameter("n")?.takeIf { Regex("^[A-Za-z0-9]{16,64}$").matches(it) } ?: return null
    return Target(host, nonce, uri.getQueryParameter("name").orEmpty().take(60))
  }

  /** Phone side: a pairing code from the server, sent to the TV. Blocking (IO thread). */
  fun sendToTv(app: App, target: Target, code: String, servers: List<String>): JSONObject {
    val body = JSONObject().put("nonce", target.nonce).put("code", code).put("servers", JSONArray(servers)).put("serverName", app.prefs.serverName)
    val conn = java.net.URL("http://${target.host}/pair").openConnection() as java.net.HttpURLConnection
    try {
      conn.requestMethod = "POST"
      conn.connectTimeout = 8000
      conn.readTimeout = 45000
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.outputStream.use { it.write(body.toString().toByteArray()) }
      val status = conn.responseCode
      val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.bufferedReader()?.use { it.readText() } ?: ""
      val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
      if (status >= 400 || !json.optBoolean("ok")) throw ApiException(status, json.optString("error", "TV_PAIR_FAILED"), json.optString("message", "TV pairing failed"))
      return json
    } finally {
      conn.disconnect()
    }
  }
}

/** TV side: a one-shot HTTP receiver on the home network. */
class TvPairReceiver(private val app: App, private val onPaired: () -> Unit) {
  val nonce: String = ByteArray(18).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }.take(32)
  private var socket: ServerSocket? = null
  @Volatile private var done = false

  /** Starts listening; returns "ip:port" or null when the TV has no home-network address. */
  fun start(): String? {
    val ip = lanAddress() ?: return null
    val server = ServerSocket(0, 4, InetAddress.getByName("0.0.0.0"))
    socket = server
    thread(name = "tv-pair", isDaemon = true) {
      while (!done && !server.isClosed) {
        val client = runCatching { server.accept() }.getOrNull() ?: break
        runCatching { handle(client) }
        runCatching { client.close() }
      }
    }
    return "${ip.hostAddress}:${server.localPort}"
  }

  fun stop() {
    done = true
    runCatching { socket?.close() }
  }

  private fun handle(client: Socket) {
    client.soTimeout = 15_000
    val input = BufferedInputStream(client.getInputStream())
    val head = StringBuilder()
    while (!head.endsWith("\r\n\r\n") && head.length < 8192) {
      val b = input.read()
      if (b < 0) return
      head.append(b.toChar())
    }
    val lines = head.split("\r\n")
    val request = lines.firstOrNull().orEmpty()
    val length = lines.firstOrNull { it.lowercase().startsWith("content-length:") }?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
    if (!request.startsWith("POST /pair ") || length !in 1..16_384) return reply(client, 404, JSONObject().put("ok", false).put("error", "NOT_FOUND"))
    val bytes = ByteArray(length)
    var read = 0
    while (read < length) {
      val n = input.read(bytes, read, length - read)
      if (n < 0) break
      read += n
    }
    val body = runCatching { JSONObject(String(bytes, 0, read)) }.getOrNull()
    if (body == null || body.optString("nonce") != nonce) return reply(client, 403, JSONObject().put("ok", false).put("error", "BAD_NONCE"))
    val code = PairLinks.normalizeCode(body.optString("code")) ?: return reply(client, 400, JSONObject().put("ok", false).put("error", "BAD_CODE"))
    val arr = body.optJSONArray("servers") ?: JSONArray()
    val servers = (0 until arr.length()).mapNotNull { PairLinks.normalizeBase(arr.optString(it)) }.distinct()
    if (servers.isEmpty()) return reply(client, 400, JSONObject().put("ok", false).put("error", "NO_SERVER"))

    var lastError: Exception? = null
    for (base in servers) {
      try {
        val result = app.api.pair(base, code, tvName(), platform = "android-tv")
        app.prefs.servers = listOf(base) + (servers - base)
        app.prefs.lastGoodServer = base
        app.prefs.token = result.getString("token")
        app.prefs.userJson = result.optJSONObject("user")
        (result.optString("serverName").ifBlank { body.optString("serverName") }).takeIf { it.isNotBlank() }?.let { app.prefs.serverName = it }
        app.servers.invalidate()
        reply(client, 200, JSONObject().put("ok", true).put("name", tvName()))
        done = true
        android.os.Handler(android.os.Looper.getMainLooper()).post(onPaired)
        return
      } catch (e: ApiException) {
        lastError = e
        if (e.status in 400..499) break
      } catch (e: Exception) {
        lastError = e
      }
    }
    reply(client, 502, JSONObject().put("ok", false).put("error", (lastError as? ApiException)?.code ?: "SERVER_UNREACHABLE").put("message", lastError?.message ?: ""))
  }

  private fun reply(client: Socket, status: Int, json: JSONObject) {
    val bytes = json.toString().toByteArray()
    val text = if (status == 200) "OK" else "Error"
    val out = client.getOutputStream()
    out.write("HTTP/1.1 $status $text\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
    out.write(bytes)
    out.flush()
  }

  companion object {
    fun tvName(): String = listOf(android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, android.os.Build.MODEL, "TV")
      .distinct().joinToString(" ").take(60)

    /** The TV's private IPv4 address on the home network (Wi-Fi or Ethernet). */
    fun lanAddress(): InetAddress? = runCatching {
      NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback && !it.isVirtual }
        .sortedBy { if (it.name.startsWith("eth")) 0 else if (it.name.startsWith("wlan")) 1 else 2 }
        .flatMap { it.inetAddresses.toList() }
        .firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
    }.getOrNull()

    fun qr(text: String, size: Int = 600): Bitmap? = runCatching { BarcodeEncoder().encodeBitmap(text, BarcodeFormat.QR_CODE, size, size) }.getOrNull()
  }
}
