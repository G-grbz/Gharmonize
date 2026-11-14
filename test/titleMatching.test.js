import test from 'node:test'
import assert from 'node:assert/strict'
import { isDescriptorPart, pickPipeTitlePart, baseSongTitle, isPlausibleContainsMatch } from '../modules/titleMatching.js'

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\[\](){}"'.,!?·•]/g, ' ').replace(/\s+/g, ' ').trim()

test('pipe titles keep the song, not a trailing description', () => {
  assert.equal(pickPipeTitlePart('Fikrimden Geceler Yatabilmirem | Psychedelic Anatolian Rock Cover'), 'Fikrimden Geceler Yatabilmirem')
  assert.equal(pickPipeTitlePart('Fikrimden Geceler Yatabilmirem | Psychedelic Anatolian Rock'), 'Fikrimden Geceler Yatabilmirem')
  // The classic "Channel | Song" layout still keeps the last part.
  assert.equal(pickPipeTitlePart('Kanal Adı | Gülümse'), 'Gülümse')
  assert.equal(pickPipeTitlePart('Sezen Aksu | Hadi Bakalım | Official Video'), 'Hadi Bakalım')
  assert.equal(pickPipeTitlePart('Muzik Kanalı | Live Forever'), 'Live Forever', 'one descriptive word is not enough')
  assert.equal(pickPipeTitlePart('Canlı 2019 | Official Video'), 'Official Video', 'all parts descriptive → last part')
  assert.equal(pickPipeTitlePart('No pipe here'), 'No pipe here')
  assert.equal(isDescriptorPart('Türkü Akustik'), true)
  assert.equal(isDescriptorPart('Ölürüm Sana'), false)
})

test('annotation-only overlaps are not accepted as the same song', () => {
  assert.equal(baseSongTitle('Esmerin Adı Oya (Psychedelic Anatolian Rock)'), 'Esmerin Adı Oya')
  assert.equal(baseSongTitle('Gülümse - Live'), 'Gülümse')
  assert.equal(isPlausibleContainsMatch('Psychedelic Anatolian Rock', 'Esmerin Adı Oya (Psychedelic Anatolian Rock)', norm), false)
  assert.equal(isPlausibleContainsMatch('Song', 'Song (Remastered 2011)', norm), true)
  assert.equal(isPlausibleContainsMatch('Gülümse', 'Gülümse - Canlı', norm), true)
  assert.equal(isPlausibleContainsMatch('Song (Official Video)', 'Song', norm), true)
  assert.equal(isPlausibleContainsMatch('Live', 'Love Me Do', norm), false)
  assert.equal(isPlausibleContainsMatch('', 'x', norm), false)
})

test('album base titles ignore store edition labels', async () => {
  const { albumBaseKey } = await import('../modules/player/matching.js')
  assert.equal(albumBaseKey('Wake Up - Single'), albumBaseKey('Wake Up'))
  assert.equal(albumBaseKey('Gülümse (Deluxe Edition)'), albumBaseKey('Gülümse'))
  assert.equal(albumBaseKey('Record - EP'), 'record')
  assert.notEqual(albumBaseKey('Live at Wembley'), albumBaseKey('Wembley'))
})
