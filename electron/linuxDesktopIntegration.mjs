// AppImage desktop integration. An AppImage started directly installs
// nothing, so docks, launchers and search (which look the window's app id
// "gharmonize" up as gharmonize.desktop and its Icon= in the icon theme)
// showed a generic icon. On start the AppImage copies its icon set into the
// user's hicolor theme and, when no installed package provides one, adds a
// gharmonize.desktop entry that starts this AppImage. Entries written here
// carry a marker; anything else (a package's or the user's own entry) is
// never touched, and our entry steps aside once a package provides one.

import fs from 'node:fs'
import path from 'node:path'

export const APPIMAGE_MARKER = 'X-Gharmonize-AppImage=true'
const ICON_NAME = 'gharmonize'
const ICON_FILE_RE = /^(\d+)x\1\.png$/

function desktopExecQuote(value) {
  return `"${String(value || '').replace(/(["\\$`])/g, '\\$1')}"`
}

export function buildAppImageDesktopEntry(appImage, { comment = 'Gharmonize' } = {}) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Gharmonize',
    `Comment=${comment}`,
    `TryExec=${appImage}`,
    `Exec=${desktopExecQuote(appImage)} %U`,
    `Icon=${ICON_NAME}`,
    'Terminal=false',
    'Categories=AudioVideo;',
    'StartupNotify=true',
    'StartupWMClass=gharmonize',
    APPIMAGE_MARKER,
    ''
  ].join('\n')
}

function sameFile(a, b, fsApi) {
  try {
    const x = fsApi.readFileSync(a)
    const y = fsApi.readFileSync(b)
    return x.equals(y)
  } catch { return false }
}

/**
 * Returns { icons, desktop } — how many icons were written and what happened
 * to the desktop entry ('written' | 'removed' | 'kept' | 'skipped').
 */
export function integrateAppImage({ appImage, iconsDir, env = process.env, home, fsApi = fs } = {}) {
  const result = { icons: 0, desktop: 'skipped' }
  if (!appImage || !home) return result
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((dir) => path.isAbsolute(dir))

  // 1) Icons: every NxN.png of the bundled set into the user's hicolor theme.
  let names = []
  try { names = fsApi.readdirSync(iconsDir).filter((name) => ICON_FILE_RE.test(name)) } catch {}
  for (const name of names) {
    const size = name.slice(0, -4)
    const target = path.join(dataHome, 'icons', 'hicolor', size, 'apps', `${ICON_NAME}.png`)
    const source = path.join(iconsDir, name)
    if (sameFile(source, target, fsApi)) continue
    fsApi.mkdirSync(path.dirname(target), { recursive: true })
    fsApi.copyFileSync(source, target)
    result.icons += 1
  }

  // 2) Desktop entry, only while no installed package provides one.
  const entry = path.join(dataHome, 'applications', `${ICON_NAME}.desktop`)
  let current = null
  try { current = fsApi.readFileSync(entry, 'utf8') } catch {}
  const ours = current == null || current.includes(APPIMAGE_MARKER)
  if (!ours) {
    result.desktop = 'kept'
    return result
  }
  const packaged = dataDirs.some((dir) => fsApi.existsSync(path.join(dir, 'applications', `${ICON_NAME}.desktop`)))
  if (packaged) {
    if (current != null) {
      fsApi.rmSync(entry, { force: true })
      result.desktop = 'removed'
    }
    return result
  }
  const wanted = buildAppImageDesktopEntry(appImage)
  if (current === wanted) {
    result.desktop = 'kept'
    return result
  }
  fsApi.mkdirSync(path.dirname(entry), { recursive: true })
  fsApi.writeFileSync(entry, wanted, { mode: 0o644 })
  result.desktop = 'written'
  return result
}
