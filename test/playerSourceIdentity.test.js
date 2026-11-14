import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openPlayerDatabase } from '../modules/player/db.js'
import { createScanner } from '../modules/player/scanner.js'
import { createLibraryMatcher } from '../modules/player/matching.js'
import { metadataSourceKey, youtubeSourceKey } from '../modules/player/sourceKey.js'
import { writeTrack, tmpDir } from './fixtures/playerAudio.mjs'
import { pickTrackArtist, pickTrackTitle, toFrozenEntries } from '../modules/youtubeIdentity.js'
import { buildId3FromYouTube } from '../modules/tags.js'

const cases = [
  ['Ayfer Vardar - Ölmeyince Sakın Yardan Ayrılma I Single © 2017 Z Müzik', 'Z Müzik', 'Ayfer Vardar', 'Ölmeyince Sakın Yardan Ayrılma'],
  ['Cengiz Ozkan - Zülüf Dökülmüş Yüze I Bir Çift Selam © 2019 Z Müzik', 'Z Müzik', 'Cengiz Ozkan', 'Zülüf Dökülmüş Yüze'],
  ['Resul Dindar&Aslıhan Güner / Kapundaki Nar Midur', 'rd müzik', 'Resul Dindar&Aslıhan Güner', 'Kapundaki Nar Midur'],
  ['Cengiz Özkan - O Yâr Gelir [ Hayâlmest © 2015 Kalan Müzik ]', 'Kalan Müzik', 'Cengiz Özkan', 'O Yâr Gelir']
]
test('label-upload identities survive preview preparation and core ID3 fallback', () => {
  for (const [title,uploader,artist,track] of cases) {
    const input={title,uploader}
    assert.equal(pickTrackArtist(input),artist)
    assert.equal(pickTrackTitle(input),track)
    const entry=toFrozenEntries([input])[0]
    const tags=buildId3FromYouTube(entry)
    assert.equal(tags.artist,artist)
    assert.equal(tags.title,track)
  }
})
test('source keys accept real metadata URL tags and reject unrelated hosts', () => {
  assert.equal(youtubeSourceKey('https://youtu.be/X4zgBkz1tcw'), 'youtube:X4zgBkz1tcw')
  assert.equal(metadataSourceKey({native:{vorbis:[{id:'URL',value:'https://youtu.be/X4zgBkz1tcw'}]}}), 'youtube:X4zgBkz1tcw')
  assert.equal(youtubeSourceKey('https://evil-youtube.com/watch?v=X4zgBkz1tcw'),null)
  assert.equal(metadataSourceKey({native:{'ID3v2.3':[{id:'WXXX',value:{description:'SOURCE_URL',url:'https://music.youtube.com/watch?v=X4zgBkz1tcw'}}]}}),'youtube:X4zgBkz1tcw')
})
test('downloaded track matches by source despite bad old tags, with library visibility enforced', async () => {
  const dir=tmpDir('source');const db=await openPlayerDatabase(dir,{fileName:':memory:'})
  try {
    const audio=path.join(dir,'music');fs.mkdirSync(audio)
    const file=writeTrack(path.join(audio,'rd müzik - wrong.mp3'),{title:'wrong title',artist:'rd müzik',userDefinedUrl:[{description:'SOURCE_URL',url:'https://music.youtube.com/watch?v=X4zgBkz1tcw'}]})
    db.prepare('INSERT INTO libraries (name,path,enabled,is_default,created_at) VALUES (?, ?, 1, 1, 0)').run('Test',audio)
    db.prepare("INSERT INTO users (username,display_name,password_hash,role,created_at,updated_at) VALUES ('admin','Admin','test','admin',0,0),('guest','Guest','test','user',0,0)").run()
    const indexed=await createScanner(db).indexFiles([file]); const id=indexed.get(file)
    assert.ok(id)
    const matcher=createLibraryMatcher(db)
    const item={title:'Kapundaki Nar Midur',artist:'Resul Dindar, Aslıhan Güner',url:'https://www.youtube.com/watch?v=X4zgBkz1tcw&list=test'}
    assert.equal(matcher.findTrack(item,1),id)
    assert.equal(matcher.findTrack(item,2),null)
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true})}
})
