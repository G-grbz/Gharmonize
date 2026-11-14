import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import { cleanUploader, pickTrackTitle, pickTrackArtist, parseTitleArtistPair, toFrozenEntries } from '../modules/player/ytTitles.js'
import { prepareYouTubePlaylist } from '../modules/player/coreAdapter.js'
import * as ytMusic from '../modules/ytMusicMetadata.js'

// The classic UI's own implementation, loaded as-is from the browser file.
function loadClassicPreviewManager() {
  const source = fs.readFileSync('public/ui/PreviewManager.js', 'utf8')
    .replace(/^import .*;?\s*$/gm, '')
    .replace(/export class PreviewManager/, 'class PreviewManager')
    .replace(/^export .*$/gm, '')
  const context = vm.createContext({ cleanUploader, pickTrackTitle, pickTrackArtist, parseTitleArtistPair, console, document: {}, window: {}, localStorage: { getItem: () => null, setItem: () => {} }, URL, URLSearchParams })
  vm.runInContext(`${source}\nglobalThis.__PM = PreviewManager;`, context)
  return new context.__PM({ t: (k) => k })
}

const SAMPLES = [
  { title: 'Harika', uploader: 'Ebru Gündeş' },
  { title: 'Dansöz', uploader: 'Serdar Ortaç - Topic' },
  { title: 'Aşka Yürek Gerek', uploader: 'Mustafa Sandal Official' },
  { title: 'Yonca Evcimik - 8:15 Vapuru #yoncaevcimik #815vapuru', uploader: 'Yonca Evcimik' },
  { title: 'Kenan Doğulu - Sımsıkı Sıkı Sıkı (Official Video)', uploader: 'Kenan Doğulu' },
  { title: 'Fikrimden Geceler Yatabilmirem | Psychedelic Anatolian Rock Cover', uploader: 'Anatolian Psych Rock Lab' },
  { title: 'Sezen Aksu l Gülümse l Official Audio', uploader: 'Sezen Aksu' },
  { title: 'Tarkan - Şımarık - Remastered', uploader: 'TARKAN' },
  { title: 'Gülümse - Sezen Aksu', uploader: 'Sezen Aksu' },
  { title: 'Hadi Bakalım • Sezen Aksu', uploader: 'Sezen Aksu VEVO' },
  { title: 'Daft Punk & Pharrell Williams - Get Lucky', uploader: 'Daft Punk' },
  { title: 'Only title', uploader: '' },
  { title: '', uploader: 'Nobody - Topic' },
  { title: 'A | B | C', uploader: 'Channel' },
  { title: 'Müslüm Gürses — Yıllar Utansın (1987)', uploader: 'Müslüm Gürses (Official)' },
  { title: 'Song Name', uploader: 'Artist and Friend' }
]

test('player cleans YouTube playlist entries exactly like the classic UI', () => {
  const classic = loadClassicPreviewManager()
  for (const item of SAMPLES) {
    assert.equal(pickTrackTitle(item), classic.pickTrackTitle(item), `title: ${item.title}`)
    assert.equal(cleanUploader(item.uploader), classic.cleanUploader(item.uploader), `uploader: ${item.uploader}`)
  }
  // Same shape as the classic "download all" payload.
  const entries = toFrozenEntries([{ index: 3, id: 'abc', title: 'Dansöz', uploader: 'Serdar Ortaç - Topic', duration: 317, webpage_url: 'https://music.youtube.com/watch?v=abc' }])
  assert.deepEqual(entries, [{ artist: 'Serdar Ortaç', index: 3, id: 'abc', title: 'Dansöz', uploader: 'Serdar Ortaç', duration: 317, webpage_url: 'https://music.youtube.com/watch?v=abc' }])
})

test('YouTube playlists reach the core with cleaned entries, title and ids', async () => {
  const url = 'https://music.youtube.com/playlist?list=PLtest'
  const yt = {
    extractPlaylistAllFlat: async () => ({
      title: 'hareketli',
      count: 3,
      items: [
        { index: 1, id: 'QQ6kpIyS-GQ', title: 'Harika', uploader: 'Ebru Gündeş', duration: 199, webpage_url: 'https://music.youtube.com/watch?v=QQ6kpIyS-GQ' },
        { index: 2, id: '7I1D8X6ckFM', title: 'Dansöz', uploader: 'Serdar Ortaç - Topic', duration: 317, webpage_url: 'https://music.youtube.com/watch?v=7I1D8X6ckFM' },
        { index: 3, id: 'ZEGEyW5v_TQ', title: 'Kenan Doğulu - Sımsıkı Sıkı Sıkı (Official Video)', uploader: 'Kenan Doğulu', duration: 371, webpage_url: 'https://music.youtube.com/watch?v=ZEGEyW5v_TQ' }
      ]
    }),
    extractAutomixAllFlat: async () => { throw new Error('not an automix') }
  }
  const prepared = await prepareYouTubePlaylist({ yt, ytMusic }, url)
  assert.equal(prepared.frozenTitle, 'hareketli')
  assert.deepEqual(prepared.selectedIds, ['QQ6kpIyS-GQ', '7I1D8X6ckFM', 'ZEGEyW5v_TQ'])
  assert.deepEqual(prepared.frozenEntries.map((e) => [e.index, e.title, e.uploader]), [
    [1, 'Harika', 'Ebru Gündeş'],
    [2, 'Dansöz', 'Serdar Ortaç'],
    [3, 'Sımsıkı Sıkı Sıkı (Official Video)', 'Kenan Doğulu']
  ])

  // Ids are only pinned when every entry has one (as in the classic UI).
  const partial = await prepareYouTubePlaylist({ yt: { extractPlaylistAllFlat: async () => ({ title: 'x', items: [{ index: 1, id: 'a', title: 'A' }, { index: 2, title: 'B' }] }) }, ytMusic }, url)
  assert.equal(partial.selectedIds, null)
  assert.equal(await prepareYouTubePlaylist({ yt: { extractPlaylistAllFlat: async () => ({ title: 'x', items: [] }) }, ytMusic }, url), null)
})
