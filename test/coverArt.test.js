import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { thumbnailCandidates, createThumbnailDownloader, createCoverResolver, taggedUrl, youtubeThumbnailFromUrl, normalizeCoverImage } from '../modules/coverArt.js';

const source = 'https://i.ytimg.com/vi_webp/tSzx9yln6ak/maxresdefault.webp';
test('old YouTube uploads fall back from unavailable WebP/maxres to JPEG resolutions', () => {
  const urls = thumbnailCandidates(source);
  assert.equal(urls[0],source);
  assert.ok(urls.includes('https://i.ytimg.com/vi/tSzx9yln6ak/hqdefault.jpg'));
  assert.deepEqual(thumbnailCandidates('https://example.org/vi_webp/tSzx9yln6ak/image.webp'),['https://example.org/vi_webp/tSzx9yln6ak/image.webp']);
  assert.equal(youtubeThumbnailFromUrl('https://www.youtube.com/watch?v=tSzx9yln6ak'),'https://i.ytimg.com/vi/tSzx9yln6ak/maxresdefault.jpg');
  assert.equal(youtubeThumbnailFromUrl('https://notyoutube.com/watch?v=tSzx9yln6ak'),null);
});
test('404, HTML and forged image headers are skipped, and decoded artwork is stored as PNG', async (t) => {
  let jpeg;
  try { jpeg = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=red:s=16x16','-frames:v','1','-threads','1','-f','image2pipe','-c:v','mjpeg','pipe:1']); }
  catch { t.skip('FFmpeg is required'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'gh-cover-download-'));
  const previous = process.env.DATA_DIR;process.env.DATA_DIR=root;
  fs.mkdirSync(path.join(root,'temp'));
  const tried=[];
  const download=createThumbnailDownloader({fetchRemote:async(url)=>{
    tried.push(url);
    return url.endsWith('/hqdefault.jpg') ? new Response(Buffer.concat([jpeg,Buffer.from('<script>payload</script>')]),{headers:{'content-type':'application/octet-stream'}})
      : url.endsWith('/maxresdefault.jpg') ? new Response(Buffer.from([255,216,255,224,1,2,3,4]))
      : url.endsWith('/sddefault.jpg') ? new Response('<html>not artwork</html>') : new Response('',{status:404});
  }});
  try {
    const file=await download(source,path.join(root,'temp','cover'));
    assert.equal(path.extname(file),'.png');
    const saved=fs.readFileSync(file);
    assert.deepEqual(saved.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(saved.includes(Buffer.from('<script>')),false);
    assert.equal(fs.statSync(file).mode & 0o777,0o600);
    assert.equal(tried.at(-1),'https://i.ytimg.com/vi/tSzx9yln6ak/hqdefault.jpg');
    await assert.rejects(download(source,path.join(root,'outside-cover')),/path/i);
  } finally { if(previous===undefined)delete process.env.DATA_DIR;else process.env.DATA_DIR=previous;fs.rmSync(root,{recursive:true,force:true}); }
});
test('cover validation rejects unsupported and oversized content before decoding', async () => {
  await assert.rejects(normalizeCoverImage(Buffer.from('<html>error</html>')),/Invalid cover/);
  const huge=Buffer.alloc(25*1024*1024+1);huge.set([255,216,255]);
  await assert.rejects(normalizeCoverImage(huge),/Invalid cover/);
});
test('PNG and WebP covers decode to a clean PNG without changing aspect ratio', async (t) => {
  try { execFileSync('ffmpeg',['-version'],{stdio:'ignore'}); } catch { t.skip('FFmpeg is required'); return; }
  for (const codec of ['png','libwebp']) {
    const source=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=32x16','-frames:v','1','-threads','1','-c:v',codec,'-f','image2pipe','pipe:1']);
    const image=await normalizeCoverImage(source);
    assert.deepEqual(image.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(image.readUInt32BE(16),32);assert.equal(image.readUInt32BE(20),16);
  }
});
test('cover downloads stop oversized streamed responses before writing a file', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gh-cover-size-'));
  const previous=process.env.DATA_DIR;process.env.DATA_DIR=root;
  fs.mkdirSync(path.join(root,'temp'));
  let chunks=0;
  const body={async *[Symbol.asyncIterator](){for(let i=0;i<20;i++){chunks++;yield Buffer.alloc(8*1024*1024);}}};
  const download=createThumbnailDownloader({logger:{warn(){}},fetchRemote:async()=>({ok:true,headers:new Headers(),body})});
  try {
    assert.equal(await download('https://images.example/cover',path.join(root,'temp','cover')),null);
    assert.equal(chunks,4);assert.deepEqual(fs.readdirSync(path.join(root,'temp')),[]);
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
