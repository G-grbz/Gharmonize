package com.gharmonize.player.tv

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.gharmonize.player.R
import com.gharmonize.player.data.Prefs
import com.gharmonize.player.ui.Appearance
import com.gharmonize.player.ui.FluentIcons
import com.gharmonize.player.ui.accentDef
import com.gharmonize.player.ui.paletteDef

/** A ready-made look: a player colour (dark or light surfaces) with an accent. */
class TvThemePreset(val key: String, val palette: String, val accent: String, @StringRes val label: Int)

val TV_THEMES = listOf(
  TvThemePreset("classic", "navy", "blue", R.string.tv_theme_classic),
  TvThemePreset("midnight", "oled", "silver", R.string.tv_theme_midnight),
  TvThemePreset("neon", "oled", "fuchsia", R.string.tv_theme_neon),
  TvThemePreset("ember", "oled", "amber", R.string.tv_theme_ember),
  TvThemePreset("ocean", "deepsea", "ocean", R.string.tv_theme_ocean),
  TvThemePreset("forest", "forest", "moss", R.string.tv_theme_forest),
  TvThemePreset("sunset", "plum", "coral", R.string.tv_theme_sunset),
  TvThemePreset("velvet", "plum", "rose", R.string.tv_theme_velvet),
  TvThemePreset("cosmos", "navy", "indigo", R.string.tv_theme_cosmos),
  TvThemePreset("daylight", "light", "blue", R.string.tv_theme_daylight),
  TvThemePreset("sky", "sky", "ocean", R.string.tv_theme_sky),
  TvThemePreset("mint", "mint", "moss", R.string.tv_theme_mint),
  TvThemePreset("lilac", "lilac", "violet", R.string.tv_theme_lilac),
)

/**
 * The TV's look. It is kept apart from the phone's colour settings and only
 * set in memory on [Appearance], which the shared theme reads.
 */
object TvTheme {
  var key by mutableStateOf("classic")
    private set

  val preset get() = TV_THEMES.firstOrNull { it.key == key } ?: TV_THEMES[0]
  val dark get() = paletteDef(preset.palette).dark

  fun load(prefs: Prefs) = apply(prefs.tvTheme, null)

  fun apply(newKey: String, prefs: Prefs?) {
    val p = TV_THEMES.firstOrNull { it.key == newKey } ?: TV_THEMES[0]
    key = p.key
    Appearance.accent = p.accent
    if (paletteDef(p.palette).dark) Appearance.paletteDark = p.palette else Appearance.paletteLight = p.palette
    prefs?.tvTheme = p.key
  }
}

/** A preview tile: the theme's surfaces, a fake card and its accent. */
@Composable
fun TvThemeTile(preset: TvThemePreset, selected: Boolean, onClick: () -> Unit) {
  val palette = paletteDef(preset.palette)
  val accent = accentDef(preset.accent)
  val tone = if (palette.dark) accent.dark else accent.light
  val tone2 = if (palette.dark) accent.dark2 else accent.light2
  TvFocusable(onClick, Modifier.width(220.dp), shape = RoundedCornerShape(18.dp)) {
    Column(Modifier.padding(8.dp)) {
      Box(
        Modifier.fillMaxWidth().height(124.dp).background(palette.bg, RoundedCornerShape(14.dp))
          .then(if (selected) Modifier.border(3.dp, tone, RoundedCornerShape(14.dp)) else Modifier.border(1.dp, palette.borderStrong, RoundedCornerShape(14.dp)))
          .padding(12.dp),
      ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.size(48.dp).background(Brush.linearGradient(listOf(tone, tone2)), RoundedCornerShape(10.dp)))
          Spacer(Modifier.width(10.dp))
          Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.width(80.dp).height(10.dp).background(palette.text, RoundedCornerShape(5.dp)))
            Box(Modifier.width(56.dp).height(8.dp).background(palette.text2, RoundedCornerShape(4.dp)))
          }
        }
        Row(Modifier.align(Alignment.BottomStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.weight(1f).height(6.dp).background(palette.s4, RoundedCornerShape(3.dp))) {
            Box(Modifier.fillMaxWidth(0.55f).height(6.dp).background(tone, RoundedCornerShape(3.dp)))
          }
          Spacer(Modifier.width(10.dp))
          Box(Modifier.size(26.dp).background(tone, CircleShape), contentAlignment = Alignment.Center) {
            Icon(FluentIcons.PlayArrow, null, tint = if (palette.dark) accent.onDark else androidx.compose.ui.graphics.Color.White, modifier = Modifier.size(16.dp))
          }
        }
      }
      Spacer(Modifier.height(8.dp))
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(preset.label), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (selected) Icon(FluentIcons.CheckCircle, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
      }
      Text(stringResource(if (palette.dark) R.string.theme_dark else R.string.theme_light), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}
