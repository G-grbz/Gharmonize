const safeProcessUrl = new URL('../../modules/safeProcess.js', import.meta.url).href;
const capsUrl = new URL('../../modules/ffmpegCaps.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  let source;
  if (resolved.url === safeProcessUrl) {
    source = `
      export * from ${JSON.stringify(`${safeProcessUrl}?real`)};
      import fs from 'node:fs';
      import { EventEmitter } from 'node:events';
      export function spawnSafe(bin, args) {
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => {
          if (process.env.PROGRESS_CASE === 'split-header') {
            child.stderr.emit('data', Buffer.from('  Duration: 00:00:'));
            child.stderr.emit('data', Buffer.from('20.00, start: 0.000000, bitrate: 1000 kb/s\\n'));
          } else {
            child.stderr.emit('data', Buffer.from('  Duration: N/A, start: 0.000000\\n'));
          }
          child.stderr.emit('data', Buffer.from('Stream #0:0: Video: h264, yuv420p, 640x360, 25 fps, 25 tbr\\n'));
          child.stderr.emit('data', Buffer.from('frame= 125 fps=125.0 size=1024kB time=00:00:'));
          child.stderr.emit('data', Buffer.from('05.00 bitrate=1000.0kbits/s speed=5x\\r'));
          child.stderr.emit('data', Buffer.from('frame= 250 fps=125.0 size=2048kB time=00:00:10.00 bitrate=1000.0kbits/s speed=5x\\r'));
          fs.writeFileSync(args.at(-1), 'fixture media');
          child.emit('close', 0);
        });
        return child;
      }
    `;
  } else if (resolved.url === capsUrl) {
    source = `
      export async function getFfmpegCaps() { return {}; }
      export async function probeVideoStreamInfo() {
        return { ok: true, width: 640, height: 360, frameRate: '25/1',
          duration: process.env.PROGRESS_CASE === 'probe-duration' ? 20
            : process.env.PROGRESS_CASE === 'clip-duration' ? 60 : 0 };
      }
    `;
  } else {
    return resolved;
  }
  return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
}
