import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { shouldDetectBlackBars, cropSampleWindows, cropAnalysisGeometry, parseCropRect, selectBlackBarCrop, detectBlackBars } from '../modules/autoCrop.js';
import { VideoSettingsManager } from '../public/ui/VideoSettingsManager.js';

test('black-bar detection is opt-in and only applies to automatic-height video transcoding', () => {
  const settings = { autoCropBlackBars: true, heightMode: 'auto', transcodeEnabled: true };
  assert.equal(shouldDetectBlackBars(settings), true);
  for (const override of [
    { autoCropBlackBars: false }, { autoCropBlackBars: 'true' },
    { heightMode: 'source' }, { heightMode: 'custom' },
    { transcodeEnabled: false }, { videoCodec: 'copy' }, { cropEnabled: true }
  ]) assert.equal(shouldDetectBlackBars({ ...settings, ...override }), false);
});

test('crop samples are bounded, distributed and stay inside the selected clip', () => {
  for (const duration of [1, 2, 8, 6397.856]) {
    const windows = cropSampleWindows(duration, 30);
    assert.equal(windows.length, 5);
    assert.ok(windows.reduce((sum, window) => sum + window.duration, 0) <= 10);
    for (const window of windows) {
      assert.ok(window.start >= 30);
      assert.ok(window.start + window.duration <= 30 + duration);
    }
  }
  for (const duration of [undefined, NaN, Infinity, 0, -1]) assert.deepEqual(cropSampleWindows(duration), []);
});

test('crop geometry respects autorotation and explicit orientation overrides', () => {
  const info = { width: 1920, height: 1080, rotation: -90 };
  assert.deepEqual(cropAnalysisGeometry(info), { width: 1080, height: 1920 });
  assert.deepEqual(cropAnalysisGeometry(info, 'none'), { width: 1920, height: 1080 });
  assert.deepEqual(cropAnalysisGeometry(info, '90cw'), { width: 1080, height: 1920 });
  assert.deepEqual(cropAnalysisGeometry(info, '180'), { width: 1920, height: 1080 });
});

test('crop records must be in-frame numeric geometry, not blank frames or filter expressions', () => {
  assert.deepEqual(parseCropRect('crop=3840:1604:0:278', 3840, 2160), { w: 3840, h: 1604, x: 0, y: 278 });
  for (const line of ['crop=3840:2200:0:0', 'crop=3840:1604:4:278', 'crop=2:2:0:0', 'crop=iw:ih:0:0', 'crop=-1:800:0:0']) {
    assert.equal(parseCropRect(line, 3840, 2160), null);
  }
});

test('safe crop uses the union of multiple samples and preserves full-frame scenes', () => {
  const letterbox = { w: 3840, h: 1604, x: 0, y: 278 };
  const samples = Array(5).fill(letterbox);
  assert.deepEqual(selectBlackBarCrop(samples, 3840, 2160), {
    w: 3840, h: 1608, x: 0, y: 276, filter: 'crop=3840:1608:0:276'
  });
  assert.equal(selectBlackBarCrop(samples.slice(0, 2), 3840, 2160), null);
  assert.equal(selectBlackBarCrop([...samples, { w: 3840, h: 2160, x: 0, y: 0 }], 3840, 2160), null);
  const wider = { w: 3840, h: 1800, x: 0, y: 180 };
  assert.equal(selectBlackBarCrop([...samples, wider], 3840, 2160).h, 1804);
  const asymmetric = { w: 3840, h: 1600, x: 0, y: 50 };
  assert.equal(selectBlackBarCrop(Array(5).fill(asymmetric), 3840, 2160), null);
});

test('the switch is visible/enabled only for automatic height and settings never enable it for other modes', () => {
  const manager = new VideoSettingsManager({});
  assert.equal(manager.getSettings().autoCropBlackBars, false);
  const controls = { style: {} };
  const checkbox = {};
  manager.modalEl = { querySelector: selector => selector === '#autoCropBlackBarsControls' ? controls : checkbox };
  manager.videoSettings.autoCropBlackBars = true;
  for (const mode of ['auto', 'source', 'custom', 'auto']) {
    manager.videoSettings.heightMode = mode;
    manager.syncAutoCropControls();
    assert.equal(controls.style.display, mode === 'auto' ? '' : 'none');
    assert.equal(checkbox.disabled, mode !== 'auto');
    assert.equal(manager.getSettings().autoCropBlackBars, mode === 'auto');
  }
  const html = manager.getModalHTML();
  assert.match(html, /role="switch" id="autoCropBlackBarsCheckbox"/);
});

test('applying the modal includes the switch only for automatic height and every language has its labels', () => {
  const manager = new VideoSettingsManager({});
  for (const mode of ['auto', 'source', 'custom']) {
    manager.modalEl = { querySelector: selector => {
      if (selector === '#heightModeSelect') return { value: mode };
      if (selector === '#autoCropBlackBarsCheckbox') return { checked: true };
      return null;
    } };
    manager.syncStateFromModalUI();
    assert.equal(manager.videoSettings.autoCropBlackBars, mode === 'auto');
  }
  for (const language of ['tr', 'en', 'de', 'fr', 'es']) {
    const translations = JSON.parse(fs.readFileSync(new URL(`../public/lang/${language}.json`, import.meta.url), 'utf8'));
    assert.ok(translations['label.autoCropBlackBars']);
    assert.ok(translations['option.autoCropBlackBarsNote']);
    for (const key of ['log.video.blackBarsDetecting', 'log.video.blackBarsCropped', 'log.video.blackBarsUnchanged']) {
      assert.ok(translations[key]);
    }
  }
});

test('local conversion logs preserve translation keys and clear stale keys for plain text', () => {
  const source = fs.readFileSync(new URL('../modules/processor.js', import.meta.url), 'utf8');
  const handler = source.match(/const handleLyricsLog = (\(payload\) => \{[\s\S]*?\n  \});/);
  assert.ok(handler);
  const job = {};
  const context = vm.createContext({ job });
  const log = vm.runInContext(`(${handler[1]})`, context);
  const vars = { sourceWidth: 3840, sourceHeight: 2160, width: 3840, height: 1608 };
  log({ logKey: 'log.video.blackBarsCropped', logVars: vars, fallback: 'English fallback' });
  assert.equal(job.lastLogKey, 'log.video.blackBarsCropped');
  assert.deepEqual(job.lastLogVars, vars);
  log('Plain log');
  assert.equal(job.lastLogKey, null);
  assert.equal(job.lastLogVars, null);
});

function mockSpawn(calls, { failureAt = -1, hang = false } = {}) {
  return (_bin, args) => {
    const index = calls.length;
    calls.push(args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;
    child.kill = signal => { calls.signals ||= []; calls.signals.push(signal); queueMicrotask(() => child.emit('close', 255)); return true; };
    if (!hang) queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('[Parsed_cropdetect_1 @ 0x123] crop=640:264:0:48\n'));
      child.emit('close', index === failureAt ? 1 : 0);
    });
    return child;
  };
}

test('detector runs five short sequential samples with safe argument arrays and registered processes', async () => {
  const calls = [];
  let registered = 0;
  const crop = await detectBlackBars({
    ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie name.mkv', width: 640, height: 360, duration: 100,
    spawn: mockSpawn(calls), onProcess: () => registered++
  });
  assert.equal(crop.filter, 'crop=640:268:0:46');
  assert.equal(calls.length, 5);
  assert.equal(registered, 5);
  for (const args of calls) {
    assert.equal(args[args.indexOf('-i') + 1], '/fixture/movie name.mkv');
    assert.equal(args[args.indexOf('-threads') + 1], '2');
    assert.ok(Number(args[args.indexOf('-t') + 1]) <= 2);
  }
});

test('failed or timed-out crop probes preserve the original frame and stop analysis', async () => {
  const base = { ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie.mkv', width: 640, height: 360, duration: 100 };
  const calls = [];
  assert.equal(await detectBlackBars({ ...base, spawn: mockSpawn(calls, { failureAt: 1 }) }), null);
  assert.equal(calls.length, 2);
  const hung = [];
  assert.equal(await detectBlackBars({ ...base, spawn: mockSpawn(hung, { hang: true }), sampleTimeoutMs: 5 }), null);
  assert.deepEqual(hung.signals, ['SIGTERM']);
  const missing = await detectBlackBars({ ...base, spawn: () => { throw new Error('missing binary'); } });
  assert.equal(missing, null);
});

test('crop-like filenames and media tags are not detection results', async () => {
  let calls = 0;
  const spawn = () => {
    calls++;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from("Input #0, matroska, from 'crop=640:264:0:48.mkv':\n    title : crop=640:264:0:48\n"));
      child.emit('close', 0);
    });
    return child;
  };
  assert.equal(await detectBlackBars({ ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie.mkv',
    width: 640, height: 360, duration: 100, spawn }), null);
  assert.equal(calls, 1);
});

test('explicit clips keep accurate seeking and apply the same orientation before detection', async () => {
  const calls = [];
  await detectBlackBars({ ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie.mkv', width: 640, height: 360,
    duration: 100, start: 30, orientation: 'hflip', orientationFilter: 'hflip', spawn: mockSpawn(calls) });
  for (const args of calls) {
    assert.ok(!args.includes('-noaccurate_seek'));
    assert.ok(args.includes('-noautorotate'));
    assert.match(args[args.indexOf('-vf') + 1], /^hflip,fps=4,cropdetect=/);
  }
});

test('accurate clip probes allow a slow 4K seek without removing the timeout bound', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let calls = 0;
  const spawn = () => {
    calls++;
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('[Parsed_cropdetect_1 @ 0x123] crop=640:264:0:48\n'));
      child.emit('close', 0);
    }, 8_000);
    return child;
  };
  const result = detectBlackBars({ ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie.mkv',
    width: 640, height: 360, duration: 60, start: 1200, spawn });
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(8_001);
    await Promise.resolve();
  }
  assert.equal((await result).filter, 'crop=640:268:0:46');
  assert.equal(calls, 5);
});

test('canceling crop analysis rejects the job and does not start further samples', async () => {
  const base = { ffmpegBin: 'ffmpeg', inputPath: '/fixture/movie.mkv', width: 640, height: 360, duration: 100 };
  const calls = [];
  await assert.rejects(detectBlackBars({ ...base, spawn: mockSpawn(calls), isCanceled: () => true }), /CANCELED/);
  assert.equal(calls.length, 0);
  let canceled = false;
  await assert.rejects(detectBlackBars({ ...base, spawn: mockSpawn(calls, { hang: true }), onProcess: () => { canceled = true; }, isCanceled: () => canceled }), /CANCELED/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls.signals, ['SIGTERM']);
});

test('real conversion crops before scaling; disabled, source and custom height modes retain their behavior', async t => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  } catch { t.skip('FFmpeg and FFprobe are required'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gharmonize-auto-crop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/autoCrop.mjs', import.meta.url)), root
  ], { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, DATA_DIR: root, ENV_USER_PATH: path.join(root, '.env') } });
  assert.match(stdout, /AUTO_CROP_OK/);
});
