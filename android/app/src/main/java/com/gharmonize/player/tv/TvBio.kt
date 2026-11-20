package com.gharmonize.player.tv

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.gharmonize.player.App
import com.gharmonize.player.R
import com.gharmonize.player.ui.rememberLoad
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Artist biography under the artist's name and buttons: three wide lines,
 * then "show more" (whole text in a dialog that scrolls with the remote's
 * up / down keys) and the source. Nothing is shown when none is found.
 */
@Composable
fun TvArtistBio(name: String, deezerId: String?, modifier: Modifier = Modifier) {
  val bio = rememberLoad("tv-artist-bio", name, deezerId) {
    runCatching { App.instance.api.artistBio(name, deezerId, Locale.getDefault().language) }.getOrNull()
  }.value ?: return
  val text = bio.optString("text").ifBlank { return }
  val source = stringResource(R.string.bio_source, bio.optString("source", "Wikipedia"), bio.optString("lang").uppercase())
  var open by remember(name) { mutableStateOf(false) }
  Column(modifier.widthIn(max = 820.dp).padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
    Text(text.replace(Regex("\\s+"), " "), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = 3, overflow = TextOverflow.Ellipsis)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
      TvButton(stringResource(R.string.show_more)) { open = true }
      Text(source, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
  }
  if (open) TvBioDialog(name, text, source) { open = false }
}

@Composable
private fun TvBioDialog(title: String, text: String, source: String, onClose: () -> Unit) {
  val scroll = rememberScrollState()
  val scope = rememberCoroutineScope()
  val focus = remember { FocusRequester() }
  var focused by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
  Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.6f)), contentAlignment = Alignment.Center) {
      Column(
        Modifier.fillMaxWidth(0.62f).fillMaxHeight(0.82f)
          .background(MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(24.dp))
          .padding(36.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
      ) {
        Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        // The text itself takes the focus: up / down scroll it, back closes.
        Box(
          Modifier.weight(1f).fillMaxWidth()
            .border(2.dp, if (focused) MaterialTheme.colorScheme.primary.copy(alpha = 0.5f) else MaterialTheme.colorScheme.surfaceContainer, RoundedCornerShape(12.dp))
            .focusRequester(focus)
            .onFocusChanged { focused = it.isFocused }
            .onPreviewKeyEvent { e ->
              if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
              when (e.key) {
                Key.DirectionDown -> { scope.launch { scroll.animateScrollBy(260f) }; true }
                Key.DirectionUp -> { scope.launch { scroll.animateScrollBy(-260f) }; true }
                Key.DirectionCenter, Key.Enter -> { onClose(); true }
                else -> false
              }
            }
            .focusable()
            .verticalScroll(scroll)
            .padding(12.dp),
        ) {
          Text(text, style = MaterialTheme.typography.bodyLarge)
        }
        Text(source, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
      }
    }
  }
}
