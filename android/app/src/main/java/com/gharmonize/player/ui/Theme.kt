package com.gharmonize.player.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.ColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

// Same colours as the classic Gharmonize theme (and the web player):
// navy dark / white light, blue accent, slate-violet secondary.
private val Dark = darkColorScheme(
  primary = Color(0xFF60A5FA),
  onPrimary = Color(0xFF0B1220),
  primaryContainer = Color(0xFF1E3A8A),
  onPrimaryContainer = Color(0xFFDBEAFE),
  secondary = Color(0xFF8B7CF6),
  onSecondary = Color(0xFFFFFFFF),
  secondaryContainer = Color(0xFF1F2A44),
  onSecondaryContainer = Color(0xFFE0E7FF),
  tertiaryContainer = Color(0xFF2E2A5C),
  onTertiaryContainer = Color(0xFFDDD6FE),
  background = Color(0xFF0D1117),
  onBackground = Color(0xFFF4F6FB),
  surface = Color(0xFF111827),
  onSurface = Color(0xFFF4F6FB),
  surfaceVariant = Color(0xFF1F2937),
  onSurfaceVariant = Color(0xFFA6ADBB),
  surfaceContainerLowest = Color(0xFF0B0F15),
  surfaceContainerLow = Color(0xFF111827),
  surfaceContainer = Color(0xFF172133),
  surfaceContainerHigh = Color(0xFF1F2937),
  surfaceContainerHighest = Color(0xFF2B3647),
  outline = Color(0xFF2F3D54),
  outlineVariant = Color(0xFF1F2A3A),
  error = Color(0xFFF87171),
)

private val Light = lightColorScheme(
  primary = Color(0xFF2563EB),
  onPrimary = Color(0xFFFFFFFF),
  primaryContainer = Color(0xFFDBEAFE),
  onPrimaryContainer = Color(0xFF1E3A8A),
  secondary = Color(0xFF6A5ACD),
  onSecondary = Color(0xFFFFFFFF),
  secondaryContainer = Color(0xFFE6E9F5),
  onSecondaryContainer = Color(0xFF1E2A55),
  tertiaryContainer = Color(0xFFEDE9FE),
  onTertiaryContainer = Color(0xFF3B2F7A),
  background = Color(0xFFF7F7FB),
  onBackground = Color(0xFF111317),
  surface = Color(0xFFFFFFFF),
  onSurface = Color(0xFF111317),
  surfaceVariant = Color(0xFFE6E9F5),
  onSurfaceVariant = Color(0xFF5B6170),
  surfaceContainerLowest = Color(0xFFFFFFFF),
  surfaceContainerLow = Color(0xFFF7F7FB),
  surfaceContainer = Color(0xFFF1F2F6),
  surfaceContainerHigh = Color(0xFFE6E9F5),
  surfaceContainerHighest = Color(0xFFD8DCEC),
  outline = Color(0xFFD0D3E0),
  outlineVariant = Color(0xFFE6E7EE),
  error = Color(0xFFDC2626),
)

/** Accent gradient (blue → slate violet) used by the play buttons. */
val AccentGradient = listOf(Color(0xFF8E5AF7), Color(0xFFBB20D4))

// ---- accents and ready-made player colours (same set as the web player) ----

/** Accent colours: dark-theme tones, then the deeper light-theme tones. */
class AccentDef(
  val key: String,
  val dark: Color, val darkStrong: Color, val dark2: Color, val onDark: Color,
  val light: Color, val lightStrong: Color, val light2: Color,
)

private fun c(v: Long) = Color(v)

val ACCENTS = listOf(
  AccentDef("blue", c(0xFF60A5FA), c(0xFF93C5FD), c(0xFF8B7CF6), c(0xFF0B1220), c(0xFF2563EB), c(0xFF1D4ED8), c(0xFF6A5ACD)),
  AccentDef("violet", c(0xFFA78BFA), c(0xFFC4B5FD), c(0xFFF472B6), c(0xFF140B2E), c(0xFF6D28D9), c(0xFF5B21B6), c(0xFFDB2777)),
  AccentDef("ocean", c(0xFF22D3EE), c(0xFF67E8F9), c(0xFF60A5FA), c(0xFF04161A), c(0xFF0E7490), c(0xFF155E75), c(0xFF2563EB)),
  AccentDef("moss", c(0xFF34D399), c(0xFF6EE7B7), c(0xFF60A5FA), c(0xFF04170F), c(0xFF047857), c(0xFF065F46), c(0xFF2563EB)),
  AccentDef("amber", c(0xFFFBBF24), c(0xFFFCD34D), c(0xFFF87171), c(0xFF1A1103), c(0xFFB45309), c(0xFF92400E), c(0xFFDC2626)),
  AccentDef("rose", c(0xFFFB7185), c(0xFFFDA4AF), c(0xFFA78BFA), c(0xFF2A0710), c(0xFFBE123C), c(0xFF9F1239), c(0xFF6D28D9)),
  AccentDef("indigo", c(0xFF818CF8), c(0xFFA5B4FC), c(0xFF22D3EE), c(0xFF0C0F2E), c(0xFF4338CA), c(0xFF3730A3), c(0xFF0E7490)),
  AccentDef("coral", c(0xFFFB923C), c(0xFFFDBA74), c(0xFFF472B6), c(0xFF1F0D02), c(0xFFC2410C), c(0xFF9A3412), c(0xFFBE185D)),
  AccentDef("fuchsia", c(0xFFE879F9), c(0xFFF0ABFC), c(0xFF818CF8), c(0xFF240829), c(0xFFA21CAF), c(0xFF86198F), c(0xFF4338CA)),
  AccentDef("silver", c(0xFFCBD5E1), c(0xFFE2E8F0), c(0xFF94A3B8), c(0xFF0B1220), c(0xFF334155), c(0xFF1E293B), c(0xFF64748B)),
)

/** Surfaces of a player colour; it belongs to the dark or the light theme. */
class PaletteDef(
  val key: String, val dark: Boolean,
  val bg: Color, val s1: Color, val s2: Color, val s3: Color, val s4: Color,
  val border: Color, val borderStrong: Color, val text: Color, val text2: Color,
)

private val DarkText = c(0xFFF4F6FB)

val PALETTES = listOf(
  PaletteDef("navy", true, c(0xFF0D1117), c(0xFF111827), c(0xFF172133), c(0xFF1F2937), c(0xFF2B3647), c(0xFF1F2A3A), c(0xFF2F3D54), DarkText, c(0xFFA6ADBB)),
  PaletteDef("oled", true, c(0xFF000000), c(0xFF0A0A0A), c(0xFF121212), c(0xFF1C1C1C), c(0xFF2A2A2A), c(0xFF1F1F1F), c(0xFF333333), DarkText, c(0xFFA6ADBB)),
  PaletteDef("deepsea", true, c(0xFF061D25), c(0xFF0D2128), c(0xFF122B33), c(0xFF18363F), c(0xFF21444F), c(0xFF1A333B), c(0xFF285059), DarkText, c(0xFFA3B8BF)),
  PaletteDef("forest", true, c(0xFF0A1A11), c(0xFF111C16), c(0xFF17251D), c(0xFF1E2F25), c(0xFF283D31), c(0xFF1D2C23), c(0xFF2E4537), DarkText, c(0xFFA7B7AD)),
  PaletteDef("plum", true, c(0xFF1A1028), c(0xFF1C1428), c(0xFF241A33), c(0xFF2E2240), c(0xFF3A2C50), c(0xFF2A2038), c(0xFF3F3155), DarkText, c(0xFFB2A8C2)),
  PaletteDef("light", false, c(0xFFF7F7FB), c(0xFFFFFFFF), c(0xFFF1F2F6), c(0xFFE6E9F5), c(0xFFD8DCEC), c(0xFFE6E7EE), c(0xFFD0D3E0), c(0xFF111317), c(0xFF5B6170)),
  PaletteDef("mist", false, c(0xFFEEF2F7), c(0xFFF8FAFC), c(0xFFE8EDF4), c(0xFFDDE4EE), c(0xFFCCD6E3), c(0xFFD9E0EA), c(0xFFC2CCDA), c(0xFF0F172A), c(0xFF475569)),
  PaletteDef("sky", false, c(0xFFEDF6F9), c(0xFFF8FCFD), c(0xFFE4F1F5), c(0xFFD5E8EF), c(0xFFBFDBE6), c(0xFFD3E5EC), c(0xFFB8D3DE), c(0xFF0B1A20), c(0xFF46606A)),
  PaletteDef("mint", false, c(0xFFEEF6F1), c(0xFFF9FCFA), c(0xFFE6F1EA), c(0xFFD8E9DE), c(0xFFC4DCCC), c(0xFFD6E6DB), c(0xFFBCD4C4), c(0xFF0F1A14), c(0xFF4A5F53)),
  PaletteDef("lilac", false, c(0xFFF4F2FB), c(0xFFFDFCFF), c(0xFFEFECF9), c(0xFFE4DFF5), c(0xFFD4CDEC), c(0xFFE2DDF2), c(0xFFCBC3E6), c(0xFF17131F), c(0xFF5A5370)),
)

/**
 * Current accent and the player colour remembered for each base theme: the
 * dark / light switch (or the system theme) brings back the last colour used
 * with that base.
 */
object Appearance {
  var accent by mutableStateOf("blue")
  var paletteDark by mutableStateOf("navy")
  var paletteLight by mutableStateOf("light")

  fun load(prefs: com.gharmonize.player.data.Prefs) {
    accent = prefs.accent.takeIf { k -> ACCENTS.any { it.key == k } } ?: "blue"
    paletteDark = prefs.paletteDark.takeIf { k -> PALETTES.any { it.key == k && it.dark } } ?: "navy"
    paletteLight = prefs.paletteLight.takeIf { k -> PALETTES.any { it.key == k && !it.dark } } ?: "light"
  }

  fun paletteFor(dark: Boolean) = if (dark) paletteDark else paletteLight

  /** Remembers a colour for its own base theme. */
  fun pick(prefs: com.gharmonize.player.data.Prefs, key: String) {
    val def = PALETTES.firstOrNull { it.key == key } ?: return
    if (def.dark) { paletteDark = key; prefs.paletteDark = key } else { paletteLight = key; prefs.paletteLight = key }
  }
}

fun accentDef(key: String) = ACCENTS.firstOrNull { it.key == key } ?: ACCENTS[0]
fun paletteDef(key: String) = PALETTES.firstOrNull { it.key == key } ?: PALETTES[0]

/** Accent tones for the always-dark now playing screen and the play buttons. */
class AccentColors(
  val gradient: List<Color>,
  val onDarkTint: Color,
  /** Now playing backdrop and its glass card (always dark, white text). */
  val backdrop: List<Color> = ClassicBackdrop,
  val glass: List<Color> = ClassicGlass,
)

private val ClassicBackdrop = listOf(c(0xFF125A70), c(0xFF0C1933), c(0xFF373161))
private val ClassicGlass = listOf(c(0xFFA2D5E3).copy(alpha = 0.32f), c(0xFF9797C2).copy(alpha = 0.28f))

val LocalAccent = staticCompositionLocalOf { AccentColors(AccentGradient, c(0xFF93C5FD)) }

/** Backdrop from the player colour (light ones use their dark ink) and accent. */
private fun nowPlayingColors(accent: AccentDef, palette: PaletteDef, gradient: List<Color>): AccentColors {
  if (accent.key == "blue" && (palette.key == "navy" || palette.key == "light")) return AccentColors(gradient, accent.darkStrong)
  val base = if (palette.dark) palette.bg else lerp(palette.text, accent.dark, 0.1f)
  return AccentColors(
    gradient, accent.darkStrong,
    backdrop = listOf(lerp(base, accent.dark, 0.42f), lerp(base, accent.dark, 0.14f), lerp(base, accent.dark2, 0.36f)),
    glass = listOf(lerp(c(0xFFE1F1FF), accent.dark, 0.35f).copy(alpha = 0.26f), lerp(c(0xFFE1F1FF), accent.dark2, 0.3f).copy(alpha = 0.22f)),
  )
}

private fun schemeFor(dark: Boolean, accent: AccentDef, palette: PaletteDef): ColorScheme {
  // The classic look stays exactly as it was.
  if (accent.key == "blue" && (palette.key == "navy" || palette.key == "light")) return if (dark) Dark else Light
  val p = palette
  return if (dark) Dark.copy(
    primary = accent.dark, onPrimary = accent.onDark,
    primaryContainer = lerp(p.s1, accent.dark, 0.3f), onPrimaryContainer = accent.darkStrong,
    secondary = accent.dark2, onSecondary = accent.onDark,
    secondaryContainer = lerp(p.s2, accent.dark2, 0.18f), onSecondaryContainer = p.text,
    tertiaryContainer = lerp(p.s2, accent.dark, 0.22f), onTertiaryContainer = accent.darkStrong,
    background = p.bg, onBackground = p.text, surface = p.s1, onSurface = p.text,
    surfaceVariant = p.s3, onSurfaceVariant = p.text2,
    surfaceContainerLowest = lerp(p.bg, Color.Black, 0.25f), surfaceContainerLow = p.s1, surfaceContainer = p.s2,
    surfaceContainerHigh = p.s3, surfaceContainerHighest = p.s4,
    outline = p.borderStrong, outlineVariant = p.border,
  ) else Light.copy(
    primary = accent.light, onPrimary = Color.White,
    primaryContainer = lerp(p.s1, accent.light, 0.15f), onPrimaryContainer = accent.lightStrong,
    secondary = accent.light2, onSecondary = Color.White,
    secondaryContainer = p.s3, onSecondaryContainer = p.text,
    tertiaryContainer = lerp(p.s1, accent.light2, 0.12f), onTertiaryContainer = accent.lightStrong,
    background = p.bg, onBackground = p.text, surface = p.s1, onSurface = p.text,
    surfaceVariant = p.s3, onSurfaceVariant = p.text2,
    surfaceContainerLowest = Color.White, surfaceContainerLow = p.bg, surfaceContainer = p.s2,
    surfaceContainerHigh = p.s3, surfaceContainerHighest = p.s4,
    outline = p.borderStrong, outlineVariant = p.border,
  )
}

@Composable
fun GharmonizeTheme(theme: String, content: @Composable () -> Unit) {
  val dark = when (theme) {
    "dark" -> true
    "light" -> false
    else -> isSystemInDarkTheme()
  }
  val accent = accentDef(Appearance.accent)
  // A player colour applies to its own base theme; otherwise the classic one.
  val palette = paletteDef(Appearance.paletteFor(dark)).takeIf { it.dark == dark } ?: paletteDef(if (dark) "navy" else "light")
  // White play icons sit on the deeper (light-theme) tones of the accent.
  val accentColors = nowPlayingColors(accent, palette, if (accent.key == "blue") AccentGradient else listOf(accent.light, accent.light2))
  CompositionLocalProvider(LocalAccent provides accentColors) {
    MaterialTheme(
      colorScheme = schemeFor(dark, accent, palette),
      shapes = Shapes(small = RoundedCornerShape(6.dp), medium = RoundedCornerShape(10.dp), large = RoundedCornerShape(16.dp)),
      content = content,
    )
  }
}
