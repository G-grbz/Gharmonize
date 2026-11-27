import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { integrateAppImage, buildAppImageDesktopEntry, APPIMAGE_MARKER } from '../electron/linuxDesktopIntegration.mjs'

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-appimage-'))
  const home = path.join(root, 'home')
  const sys = path.join(root, 'usr', 'share')
  const icons = path.join(root, 'icons')
  fs.mkdirSync(icons, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  for (const size of [16, 48, 512]) fs.writeFileSync(path.join(icons, `${size}x${size}.png`), `png-${size}`)
  fs.writeFileSync(path.join(icons, 'notes.txt'), 'x')
  const env = { XDG_DATA_DIRS: sys }
  const userEntry = path.join(home, '.local', 'share', 'applications', 'gharmonize.desktop')
  return { root, home, sys, icons, env, userEntry }
}

test('the release icon set is the app logo in every standard size', () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const file = `build/icons/${size}x${size}.png`
    const png = fs.readFileSync(file)
    assert.equal(png.readUInt32BE(16), size, `${file} width`)
    assert.equal(png.readUInt32BE(20), size, `${file} height`)
  }
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(pkg.build.linux.icon, 'build/icons')
  assert.ok(pkg.build.extraResources.some((r) => r.from === 'build/icons' && r.to === 'icons'))
})

test('AppImage installs its icons and a desktop entry when no package provides one', () => {
  const { root, home, icons, env, userEntry } = setup()
  try {
    const appImage = '/home/u/Apps/Gharmonize 2.1.0.AppImage'
    const first = integrateAppImage({ appImage, iconsDir: icons, env, home })
    assert.deepEqual(first, { icons: 3, desktop: 'written' })
    assert.equal(fs.readFileSync(path.join(home, '.local/share/icons/hicolor/48x48/apps/gharmonize.png'), 'utf8'), 'png-48')
    const entry = fs.readFileSync(userEntry, 'utf8')
    assert.match(entry, /^Exec="\/home\/u\/Apps\/Gharmonize 2\.1\.0\.AppImage" %U$/m)
    assert.match(entry, /^Icon=gharmonize$/m)
    assert.match(entry, /^StartupWMClass=gharmonize$/m)
    assert.ok(entry.includes(APPIMAGE_MARKER))
    // Nothing changes on the next start; a moved AppImage updates Exec.
    assert.deepEqual(integrateAppImage({ appImage, iconsDir: icons, env, home }), { icons: 0, desktop: 'kept' })
    assert.equal(integrateAppImage({ appImage: '/opt/new.AppImage', iconsDir: icons, env, home }).desktop, 'written')
    assert.equal(fs.readFileSync(userEntry, 'utf8'), buildAppImageDesktopEntry('/opt/new.AppImage'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an installed package or the user\'s own entry wins; icons are still installed', () => {
  const { root, home, sys, icons, env, userEntry } = setup()
  try {
    integrateAppImage({ appImage: '/a.AppImage', iconsDir: icons, env, home })
    // A package (deb/rpm/pacman) is installed later: our entry steps aside.
    fs.mkdirSync(path.join(sys, 'applications'), { recursive: true })
    fs.writeFileSync(path.join(sys, 'applications', 'gharmonize.desktop'), '[Desktop Entry]\nExec=/opt/Gharmonize/gharmonize\n')
    assert.equal(integrateAppImage({ appImage: '/a.AppImage', iconsDir: icons, env, home }).desktop, 'removed')
    assert.ok(!fs.existsSync(userEntry))
    // A user's own entry is never rewritten.
    fs.mkdirSync(path.dirname(userEntry), { recursive: true })
    fs.writeFileSync(userEntry, '[Desktop Entry]\nName=Mine\n')
    fs.rmSync(path.join(home, '.local/share/icons'), { recursive: true })
    assert.deepEqual(integrateAppImage({ appImage: '/a.AppImage', iconsDir: icons, env, home }), { icons: 3, desktop: 'kept' })
    assert.equal(fs.readFileSync(userEntry, 'utf8'), '[Desktop Entry]\nName=Mine\n')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
