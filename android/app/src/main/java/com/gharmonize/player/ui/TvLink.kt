package com.gharmonize.player.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.gharmonize.player.R
import com.gharmonize.player.tv.TvPairLink
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings → "Connect a TV": scan the QR code the Gharmonize TV app shows;
 * the TV gets signed in to this account (as its own device).
 */
@Composable
fun TvLinkItem(state: AppState) {
  val ctx = LocalContext.current
  var busy by remember { mutableStateOf(false) }
  val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
    val text = result.contents ?: return@rememberLauncherForActivityResult
    val target = TvPairLink.parse(text)
    if (target == null) { state.messageRes(R.string.tv_link_bad_qr); return@rememberLauncherForActivityResult }
    busy = true
    state.scope.launch {
      try {
        val code = state.api.createPairingCode()
        // Home-network addresses first: the TV is at home.
        val known = (runCatching { state.api.reachableAddresses() }.getOrDefault(emptyList()) + state.app.prefs.servers)
          .mapNotNull { com.gharmonize.player.data.PairLinks.normalizeBase(it) }.distinct()
        val servers = known.sortedBy { if (Regex("^https?://(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)").containsMatchIn(it)) 0 else 1 }
        withContext(Dispatchers.IO) { TvPairLink.sendToTv(state.app, target, code, servers) }
        state.messageRes(R.string.tv_link_done, target.name.ifBlank { "TV" })
      } catch (e: Exception) {
        state.message(ctx.getString(R.string.tv_link_failed) + (e.message?.let { " ($it)" } ?: ""))
      }
      busy = false
    }
  }
  SettingItem(stringResource(R.string.tv_link_title), stringResource(if (busy) R.string.tv_link_busy else R.string.tv_link_hint)) {
    if (!busy) scanner.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE).setPrompt(ctx.getString(R.string.tv_link_prompt)).setBeepEnabled(false).setOrientationLocked(false))
  }
}
