import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {parseFile} from 'music-metadata';
const root=process.argv[2];const temp=path.join(root,'temp'),output=path.join(root,'outputs');fs.mkdirSync(temp);fs.mkdirSync(output);
const find=(name)=>process.env.PATH.split(path.delimiter).map(d=>path.join(d,name)).find(p=>{try{fs.accessSync(p,fs.constants.X_OK);return true}catch{return false}});
const ffmpeg=find('ffmpeg');process.env.FFMPEG_BIN=ffmpeg;process.env.FFPROBE_BIN=find('ffprobe');
const {convertMedia,retagMediaFile}=await import('../../modules/media.js');const {resolveDownloadPathToAbs}=await import('../../modules/outputPaths.js');
const run=(args)=>execFileSync(ffmpeg,['-v','error','-nostdin','-y',...args],{timeout:15000});
const wav=path.join(temp,'audio.wav'),jpeg=path.join(temp,'cover.jpg'),webp=path.join(temp,'cover.webp');
run(['-f','lavfi','-i','sine=frequency=440:duration=1',wav]);run(['-f','lavfi','-i','color=c=blue:s=64x64','-frames:v','1','-threads','1',jpeg]);run(['-i',jpeg,'-frames:v','1',webp]);
for(const [i,kind] of ['single','playlist','album'].entries()){
 const result=await convertMedia(wav,'mp3','192k',`cover-${kind}`,()=>{},{title:`Track ${kind}`,artist:'Fixture',album:kind},i===1?webp:jpeg,false,output,temp,{ffmpegBin:ffmpeg,outputRootDir:output,includeLyrics:false,embedLyrics:false});
 const file=resolveDownloadPathToAbs(result.outputPath,output);const m=await parseFile(file);assert.ok(m.common.picture?.length,`${kind} cover missing`);assert.equal(m.common.picture[0].format,'image/jpeg');
}
const bare=path.join(output,'retag.mp3');run(['-i',wav,'-c:a','libmp3lame',bare]);
const hash=(f)=>run(['-i',f,'-map','0:a','-c','copy','-f','hash','-hash','sha256','-']).toString().trim();const before=hash(bare);
assert.ok(await retagMediaFile(bare,'mp3',{artist:'Fixture',title:'Retag'},webp,{ffmpegBin:ffmpeg,tempDir:temp}));
assert.ok((await parseFile(bare)).common.picture?.length);assert.equal(hash(bare),before,'retag must preserve audio bytes');
assert.ok(await retagMediaFile(bare,'mp3',{artist:'Fixture',title:'Retag'},null,{ffmpegBin:ffmpeg,tempDir:temp}));assert.ok((await parseFile(bare)).common.picture?.length,'retag without replacement must preserve existing cover');
console.log('COVER_PIPELINE_OK');process.exit(0);
