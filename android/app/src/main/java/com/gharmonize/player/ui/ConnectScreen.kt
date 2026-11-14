package com.gharmonize.player.ui

import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.data.ApiException
import com.gharmonize.player.data.PairLink
import com.gharmonize.player.data.PairLinks
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import androidx.activity.compose.rememberLauncherForActivityResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

fun deviceName(): String = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL)
  .distinct().joinToString(" ").take(60)

/** Pairing (QR or code) and password sign-in. */
@Composable
fun ConnectScreen(initialLink: PairLink?, onLinkFailed: (() -> Unit)? = null, onSignedIn: () -> Unit) {
  val app = App.instance
  val ctx = LocalContext.current
  val scope = rememberCoroutineScope()
  var tab by rememberSaveable { mutableIntStateOf(0) }
  var server by rememberSaveable { mutableStateOf(app.prefs.servers.firstOrNull() ?: "") }
  var code by rememberSaveable { mutableStateOf("") }
  var username by rememberSaveable { mutableStateOf("") }
  var password by rememberSaveable { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }

  fun errorMessage(e: Exception): String = when {
    e is ApiException && e.code == "INVALID_PAIRING_CODE" -> ctx.getString(R.string.connect_bad_code)
    e is ApiException && e.code == "BAD_CREDENTIALS" -> ctx.getString(R.string.connect_bad_password)
    e is ApiException && e.code == "PLAYER_REMOTE_ACCESS_DISABLED" -> ctx.getString(R.string.connect_remote_disabled)
    e is ApiException && e.code == "PLAYER_DISABLED" -> ctx.getString(R.string.connect_player_disabled)
    e is ApiException && e.status > 0 -> e.message ?: ctx.getString(R.string.error_generic)
    else -> ctx.getString(R.string.connect_unreachable)
  }

  /** Tries each address until one answers; saves everything on success. */
  fun finish(servers: List<String>, onFailed: (() -> Unit)? = null, call: (String) -> JSONObject) {
    if (busy) return
    busy = true
    error = null
    scope.launch {
      var lastError: Exception? = null
      for (base in servers) {
        try {
          val result = withContext(Dispatchers.IO) { call(base) }
          app.prefs.servers = listOf(base) + (servers - base)
          app.prefs.lastGoodServer = base
          app.prefs.token = result.getString("token")
          app.prefs.userJson = result.optJSONObject("user")
          result.optString("serverName").takeIf { it.isNotBlank() }?.let { app.prefs.serverName = it }
          app.servers.invalidate()
          busy = false
          onSignedIn()
          return@launch
        } catch (e: ApiException) {
          lastError = e
          if (e.status in 400..499) break // the server answered: wrong code/password
        } catch (e: Exception) {
          lastError = e
        }
      }
      busy = false
      error = lastError?.let(::errorMessage) ?: ctx.getString(R.string.connect_unreachable)
      // Only when the server rejected the code; a network error stays visible.
      if ((lastError as? ApiException)?.status in 400..499) onFailed?.invoke()
    }
  }

  fun pairWith(link: PairLink, onFailed: (() -> Unit)? = null) = finish(link.servers, onFailed) { base -> app.api.pair(base, link.code, deviceName()) }

  val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
    val text = result.contents ?: return@rememberLauncherForActivityResult
    val link = PairLinks.parse(text)
    if (link == null) error = ctx.getString(R.string.connect_bad_qr) else pairWith(link)
  }

  // An already used or expired link while still signed in: keep the session.
  androidx.compose.runtime.LaunchedEffect(initialLink) { initialLink?.let { pairWith(it, onLinkFailed) } }

  Column(
    Modifier.fillMaxSize().systemBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Spacer(Modifier.height(24.dp))
    Image(painterResource(R.drawable.gharmonize_logo), null, modifier = Modifier.size(140.dp))
    Text(stringResource(R.string.connect_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
    Text(stringResource(R.string.connect_text), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Button(
      onClick = {
        scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(ctx.getString(R.string.connect_scan_prompt)).setBeepEnabled(false).setOrientationLocked(false))
      },
      enabled = !busy,
      modifier = Modifier.fillMaxWidth().height(52.dp),
    ) {
      Icon(FluentIcons.QrCodeScanner, null)
      Spacer(Modifier.width(8.dp))
      Text(stringResource(R.string.connect_scan))
    }
    HorizontalDivider()
    TabRow(selectedTabIndex = tab) {
      Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text(stringResource(R.string.connect_with_code)) })
      Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text(stringResource(R.string.connect_with_password)) })
    }
    OutlinedTextField(server, { server = it }, label = { Text(stringResource(R.string.connect_server)) }, placeholder = { Text("192.168.1.20:5175") },
      singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), modifier = Modifier.fillMaxWidth())
    if (tab == 0) {
      OutlinedTextField(code, { code = it.uppercase() }, label = { Text(stringResource(R.string.connect_code)) }, placeholder = { Text("ABCD-2345") },
        singleLine = true, modifier = Modifier.fillMaxWidth())
      OutlinedButton(
        onClick = {
          val base = PairLinks.normalizeBase(server)
          val c = PairLinks.normalizeCode(code)
          if (base == null || c == null) error = ctx.getString(R.string.connect_fill_fields)
          else finish(listOf(base)) { b -> app.api.pair(b, c, deviceName()) }
        },
        enabled = !busy, modifier = Modifier.fillMaxWidth(),
      ) { Text(stringResource(R.string.connect_pair)) }
    } else {
      OutlinedTextField(username, { username = it }, label = { Text(stringResource(R.string.connect_username)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
      OutlinedTextField(password, { password = it }, label = { Text(stringResource(R.string.connect_password)) }, singleLine = true,
        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth())
      OutlinedButton(
        onClick = {
          val base = PairLinks.normalizeBase(server)
          if (base == null || username.isBlank() || password.isBlank()) error = ctx.getString(R.string.connect_fill_fields)
          else finish(listOf(base)) { b -> app.api.login(b, username.trim(), password, deviceName()) }
        },
        enabled = !busy, modifier = Modifier.fillMaxWidth(),
      ) { Text(stringResource(R.string.connect_sign_in)) }
    }
    if (busy) CircularProgressIndicator()
    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
    Text(stringResource(R.string.connect_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
}
