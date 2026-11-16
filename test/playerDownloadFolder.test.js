import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalExistingFolder, assertWritableFolder, FolderPathError } from '../modules/player/folderPath.js'
import { openPlayerDatabase } from '../modules/player/db.js'
import { createLibraryStore } from '../modules/player/libraries.js'
import { relocateDownloads } from '../modules/player/relocate.js'

function tmp(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghp-dl-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('typed folders are rebuilt from directory listings', (t) => {
  const root = tmp(t)
  fs.mkdirSync(path.join(root, 'Music', 'Player'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Music', 'song.mp3'), 'x')
  fs.symlinkSync(path.join(root, 'Music'), path.join(root, 'link'))
  assert.equal(canonicalExistingFolder(path.join(root, 'Music', 'Player')), path.join(root, 'Music', 'Player'))
  assert.equal(canonicalExistingFolder(`${root}/Music/./Player/../Player/`), path.join(root, 'Music', 'Player'))
  // Symbolic links resolve to the real folder.
  assert.equal(canonicalExistingFolder(path.join(root, 'link', 'Player')), path.join(root, 'Music', 'Player'))
  const code = (fn) => { try { fn(); return null } catch (error) { assert.ok(error instanceof FolderPathError); return error.code } }
  assert.equal(code(() => canonicalExistingFolder('')), 'FOLDER_PATH_REQUIRED')
  assert.equal(code(() => canonicalExistingFolder('Music/Player')), 'FOLDER_PATH_NOT_ABSOLUTE')
  assert.equal(code(() => canonicalExistingFolder(`${root}/Music\0`)), 'FOLDER_PATH_INVALID')
  assert.equal(code(() => canonicalExistingFolder(path.join(root, 'missing'))), 'FOLDER_PATH_NOT_FOUND')
  assert.equal(code(() => canonicalExistingFolder(path.join(root, 'Music', 'song.mp3'))), 'FOLDER_PATH_NOT_DIRECTORY')
  // Case-insensitive file systems match regardless of case; Linux does not.
  assert.equal(code(() => canonicalExistingFolder(path.join(root, 'music'))), 'FOLDER_PATH_NOT_FOUND')
})

test('Windows paths must start at a drive letter', () => {
  const code = (fn) => { try { fn(); return null } catch (error) { return error.code } }
  assert.equal(code(() => canonicalExistingFolder('\\\\server\\share\\music', { platform: 'win32' })), 'FOLDER_PATH_INVALID')
  const listed = []
  const fsApi = {
    readdirSync: (dir) => { listed.push(dir); return [{ name: 'Music', isDirectory: () => true, isSymbolicLink: () => false }] },
    realpathSync: (p) => p,
    statSync: () => ({ isDirectory: () => true })
  }
  assert.equal(canonicalExistingFolder('d:\\music', { platform: 'win32', fsApi }), 'D:\\Music')
  assert.deepEqual(listed, ['D:\\'])
})

test('the write check needs a folder Gharmonize can create files in', { skip: process.getuid?.() === 0 }, (t) => {
  const root = tmp(t)
  assertWritableFolder(root)
  assert.deepEqual(fs.readdirSync(root), [], 'the probe file is removed')
  const locked = path.join(root, 'locked')
  fs.mkdirSync(locked)
  fs.chmodSync(locked, 0o555)
  try {
    assert.throws(() => assertWritableFolder(locked), { code: 'FOLDER_NOT_WRITABLE' })
  } finally {
    fs.chmodSync(locked, 0o755)
  }
})

test('the player download folder becomes a library and only counts while the default library is off', async (t) => {
  const root = tmp(t)
  const outputs = path.join(root, 'outputs')
  const target = path.join(root, 'player-music')
  fs.mkdirSync(target)
  const db = await openPlayerDatabase(path.join(root, 'data'))
  t.after(() => db.close())
  const libraries = createLibraryStore(db, { defaultLibraryDir: outputs })
  const def = libraries.ensureDefaultLibrary()

  assert.throws(() => libraries.setDownloadFolder(path.join(outputs)), { code: 'DOWNLOAD_DIR_IN_DEFAULT' })
  assert.throws(() => libraries.setDownloadFolder(path.join(root, 'nope')), { code: 'LIBRARY_PATH_NOT_FOUND' })
  const saved = libraries.setDownloadFolder(target)
  assert.equal(saved.created, true)
  assert.equal(saved.path, target)
  assert.equal(libraries.list().find((lib) => lib.id === saved.libraryId).path, target)
  assert.equal(libraries.downloadTarget(), null, 'inactive while the default library is on')

  libraries.update(def.id, { enabled: false })
  assert.deepEqual(libraries.downloadTarget(), { dir: target, sourceRoot: fs.realpathSync(outputs) })
  // Saving again reuses the library instead of adding a second one.
  assert.equal(libraries.setDownloadFolder(target).created, false)
  assert.equal(libraries.list().length, 2)
  libraries.clearDownloadFolder()
  assert.equal(libraries.downloadTarget(), null)
})

test('finished downloads move with their lyrics; repeats keep the existing copy', async (t) => {
  const root = tmp(t)
  const source = path.join(root, 'outputs')
  const target = path.join(root, 'music')
  fs.mkdirSync(path.join(source, 'Artist', 'Album'), { recursive: true })
  fs.mkdirSync(target)
  const song = path.join(source, 'Artist', 'Album', '01 Song.mp3')
  fs.writeFileSync(song, 'audio')
  fs.writeFileSync(path.join(source, 'Artist', 'Album', '01 Song.lrc'), '[00:01.00]hi')
  fs.writeFileSync(path.join(source, 'Artist', 'Album', 'cover.jpg'), 'img')

  const moved = await relocateDownloads([song], { sourceRoot: source, targetDir: target, logger: { warn() {} } })
  const dest = path.join(target, 'Artist', 'Album', '01 Song.mp3')
  assert.equal(moved.get(song), dest)
  assert.equal(fs.readFileSync(dest, 'utf8'), 'audio')
  assert.ok(fs.existsSync(path.join(target, 'Artist', 'Album', '01 Song.lrc')))
  assert.ok(fs.existsSync(path.join(target, 'Artist', 'Album', 'cover.jpg')))
  // Gone from the Gharmonize download folder (checked by listing, not by path).
  assert.ok(!fs.readdirSync(path.dirname(song)).includes('01 Song.mp3'))

  // Same song again: no duplicate; a different file with the same name gets "(2)".
  fs.writeFileSync(song, 'audio')
  assert.equal((await relocateDownloads([song], { sourceRoot: source, targetDir: target })).get(song), dest)
  fs.writeFileSync(song, 'other audio')
  assert.equal((await relocateDownloads([song], { sourceRoot: source, targetDir: target })).get(song), path.join(target, 'Artist', 'Album', '01 Song (2).mp3'))
})
