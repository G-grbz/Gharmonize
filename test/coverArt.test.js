import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { thumbnailCandidates, createThumbnailDownloader, createCoverResolver, taggedUrl, youtubeThumbnailFromUrl } from '../modules/coverArt.js';

const source = 'https://i.ytimg.com/vi_webp/tSzx9yln6ak/maxresdefault.webp';
test('old YouTube uploads fall back from unavailable WebP/maxres to JPEG resolutions', () => {
  const urls = thumbnailCandidates(source);
  assert.equal(urls[0],source);
  assert.ok(urls.includes('https://i.ytimg.com/vi/tSzx9yln6ak/hqdefault.jpg'));
  assert.deepEqual(thumbnailCandidates('https://example.org/vi_webp/tSzx9yln6ak/image.webp'),['https://example.org/vi_webp/tSzx9yln6ak/image.webp']);
  assert.equal(youtubeThumbnailFromUrl('https://www.youtube.com/watch?v=tSzx9yln6ak'),'https://i.ytimg.com/vi/tSzx9yln6ak/maxresdefault.jpg');
  assert.equal(youtubeThumbnailFromUrl('https://notyoutube.com/watch?v=tSzx9yln6ak'),null);
});
test('404 and HTML artwork are skipped, then the actual image format determines the file extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'gh-cover-download-'));
  const previous = process.env.DATA_DIR;process.env.DATA_DIR=root;
  fs.mkdirSync(path.join(root,'temp'));
  const tried=[];
  const jpeg=Buffer.from([255,216,255,224,1,2,3,4]);
  const download=createThumbnailDownloader({fetchRemote:async(url)=>{
    tried.push(url);
    return url.endsWith('/hqdefault.jpg') ? new Response(jpeg,{headers:{'content-type':'application/octet-stream'}})
      : url.endsWith('/sddefault.jpg') ? new Response('<html>not artwork</html>') : new Response('',{status:404});
  }});
  try {
    const file=await download(source,path.join(root,'temp','cover'));
    assert.equal(path.extname(file),'.jpg');assert.deepEqual(fs.readFileSync(file),jpeg);
    assert.equal(tried.at(-1),'https://i.ytimg.com/vi/tSzx9yln6ak/hqdefault.jpg');
    await assert.rejects(download(source,path.join(root,'outside-cover')),/path/i);
  } finally { if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true}); }
});
test('track artwork precedes playlist-wide cover and provider covers precede thumbnails', async () => {
  const calls=[];
  const resolve=createCoverResolver({download:async(url)=>{calls.push(url);return '/track.jpg'},exists:()=>true});
  assert.equal(await resolve({thumbnail:'https://images.example/track.jpg'},{baseNoExt:'/tmp/track',fallbackCoverPath:'/playlist.jpg'}),'/track.jpg');
  assert.deepEqual(calls,['https://images.example/track.jpg']);calls.length=0;
  await resolve({__applePreferredCoverUrl:'https://provider.example/album.jpg',thumbnail:'https://images.example/track.jpg'},{baseNoExt:'/tmp/track'});
  assert.deepEqual(calls,['https://provider.example/album.jpg']);
});
test('retag recovers embedded source and cover links when music-metadata common fields omit them', () => {
  const parsed={native:{'ID3v2.3':[{id:'WXXX',value:{description:'COVER_URL',url:source}},{id:'WXXX',value:{description:'SOURCE_URL',url:'https://www.youtube.com/watch?v=tSzx9yln6ak'}}]}};
  assert.equal(taggedUrl(parsed,'COVER_URL'),source);assert.equal(taggedUrl(parsed,'SOURCE_URL'),'https://www.youtube.com/watch?v=tSzx9yln6ak');
});
test('real conversion and retag embed JPEG/WebP covers for single, playlist and album entries', (t) => {
  try {execFileSync('ffmpeg',['-version'],{stdio:'ignore'})}catch{t.skip('FFmpeg is required');return}
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gh-cover-pipeline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const out=execFileSync(process.execPath,['test/fixtures/coverArt.mjs',root],{encoding:'utf8',timeout:45000,env:{...process.env,DATA_DIR:root,ENV_USER_PATH:path.join(root,'.env')}});
  assert.match(out,/COVER_PIPELINE_OK/);
});
