package com.gharmonize.player.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.OnlineItem
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/** The library song "refresh online" replaces. */
data class RefreshTarget(val trackId: Long, val title: String, val artist: String, val duration: Double, val artwork: String?)

private fun primaryArtist(name: String): String =
  name.split(Regex("""\s*(?:,|;|&|/| feat\.? | ft\.? | x )\s*""", RegexOption.IGNORE_CASE)).firstOrNull()?.trim().orEmpty()

/**
 * Admin: replace a library song with a version picked from YouTube Music results
 * or pasted as a link. The old file goes to the player trash; the new one takes
 * its name, folder and places in playlists, favorites and history.
 */
@Composable
fun RefreshOnlineDialog(state: AppState, target: RefreshTarget, onDismiss: () -> Unit) {
  var query by rememberSaveable { mutableStateOf(listOf(primaryArtist(target.artist), target.title).filter { it.isNotBlank() }.joinToString(" ")) }
  var asked by remember { mutableStateOf(query) }
  var link by rememberSaveable { mutableStateOf("") }
  var chosen by remember { mutableStateOf<JSONObject?>(null) }
  var chosenTitle by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  val results = rememberLoad("refresh-online", asked) { if (asked.isBlank()) emptyList() else state.api.youtubeSongs(asked) }

  fun pick(item: OnlineItem) {
    chosen = JSONObject().put("url", item.url).put("title", item.title).put("artist", item.artist)
      .put("duration", item.duration).put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
    chosenTitle = item.title
  }

  AlertDialog(
    onDismissRequest = { if (!busy) onDismiss() },
    title = { Text(stringResource(R.string.refresh_online)) },
    text = {
      if (chosen != null) {
        // Second step: what is replaced with what.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(stringResource(R.string.refresh_confirm, target.title, chosenTitle))
          if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        }
      } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
          Artwork(target.artwork, Modifier.size(44.dp), size = 128)
          Spacer(Modifier.width(10.dp))
          Column(Modifier.weight(1f)) {
            Text(target.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
            Text(listOfNotNull(target.artist.ifBlank { null }, if (target.duration > 0) fmtTime(target.duration) else null).joinToString(" · "),
              maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
        Text(stringResource(R.string.refresh_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
          query, { query = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
          label = { Text(stringResource(R.string.refresh_search)) },
          keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
          keyboardActions = KeyboardActions(onSearch = { asked = query.trim() }),
          trailingIcon = { IconButton(onClick = { asked = query.trim() }) { Icon(FluentIcons.Search, stringResource(R.string.refresh_search)) } },
        )
        Box(Modifier.fillMaxWidth().heightIn(min = 56.dp, max = 280.dp)) {
          val list = results.value
          when {
            results.loading -> LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.Center))
            results.error != null -> Text(state.errorText(results.error!!), color = MaterialTheme.colorScheme.error)
            list.isNullOrEmpty() -> Text(stringResource(R.string.refresh_no_results), style = MaterialTheme.typography.bodySmall)
            else -> LazyColumn {
              items(list, key = { it.url }) { item ->
                val gap = if (item.duration > 0 && target.duration > 0) (item.duration - target.duration).roundToInt() else 0
                val length = if (item.duration > 0) fmtTime(item.duration) + (if (gap != 0) " (${if (gap > 0) "+" else "−"}${fmtTime(abs(gap).toDouble())})" else "") else null
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                  Artwork(item.artworkUrl, Modifier.size(40.dp), size = 128)
                  Spacer(Modifier.width(10.dp))
                  Column(Modifier.weight(1f)) {
                    Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium)
                    Text(listOfNotNull(item.artist.ifBlank { null }, length).joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis,
                      style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                  }
                  TextButton(onClick = { pick(item) }) { Text(stringResource(R.string.refresh_pick)) }
                }
              }
            }
          }
        }
        OutlinedTextField(
          link, { link = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
          label = { Text(stringResource(R.string.refresh_link)) },
          placeholder = { Text("https://music.youtube.com/watch?v=…") },
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
          trailingIcon = {
            TextButton(enabled = link.isNotBlank(), onClick = { chosen = JSONObject().put("url", link.trim()); chosenTitle = link.trim() }) {
              Text(stringResource(R.string.refresh_use_link))
            }
          },
        )
      }
    },
    confirmButton = {
      val pending = chosen
      if (pending != null) TextButton(enabled = !busy, onClick = {
        busy = true
        state.replaceTrack(target.trackId, target.title, pending, onStarted = onDismiss, onFailed = { busy = false })
      }) { Text(stringResource(R.string.refresh_replace), color = MaterialTheme.colorScheme.error) }
    },
    dismissButton = {
      TextButton(enabled = !busy, onClick = { if (chosen != null) chosen = null else onDismiss() }) {
        Text(stringResource(if (chosen != null) R.string.refresh_back else R.string.cancel))
      }
    },
  )
}
