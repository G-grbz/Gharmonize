// Opt-in real Electron smoke test using an isolated profile and loopback server.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gharmonize-timing-ui-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const root = path.resolve(__dirname, '../..');
const start = Date.now() - 12_000;
const rows = Array.from({ length: 120 }, (_, i) => ({ key: `track:${i}`,
  title: i === 0 ? '<img src=x onerror=alert(1)>' : `Test track ${i + 1}`, artist: 'Artist',
  startedAt: start, endedAt: null, phaseStartedAt: start + 4000, phase: 'converting',
  stageMs: { queued: 2000, downloading: 2000 } }));
let requests = 0;
const files = new Map([
  ['/ui/JobTimingView.js', ['public/ui/JobTimingView.js', 'text/javascript']],
  ['/style.css', ['public/style.css', 'text/css']],
  ['/tr.json', ['public/lang/tr.json', 'application/json']]
]);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset=utf-8><title>Timing test</title><link rel=stylesheet href="/style.css"><style>body{padding:20px}</style><main id=classic></main><main id=ytlive></main>');
  } else if (url.pathname === '/api/jobs/job_test/timing') {
    requests++;
    const offset = Number(url.searchParams.get('offset') || 0);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ timing: { version: 1, startedAt: start, endedAt: null,
      phase: 'converting', phaseStartedAt: start + 4000, stageMs: { queued: 2000, downloading: 2000 },
      serverNow: Date.now(), trackCount: 120, tracks: rows.slice(offset, offset + 50) } }));
  } else if (files.has(url.pathname)) {
    const [file, type] = files.get(url.pathname);
    res.setHeader('Content-Type', type);
    res.end(fs.readFileSync(path.join(root, file)));
  } else { res.statusCode = 404; res.end(); }
});
const run = async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: true, width: 1000, height: 850, webPreferences: { sandbox: true } });
  win.webContents.on('console-message', details => { if (details.level >= 2) console.error(details.message); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {jobTimingMarkup} = await import('/ui/JobTimingView.js');
    const messages = await (await fetch('/tr.json')).json();
    const t = key => messages[key] || key;
    const job = {id:'job_test', timing:{startedAt:${start}, endedAt:null, phase:'converting', phaseStartedAt:${start + 4000}, stageMs:{queued:2000,downloading:2000}, tracks:${JSON.stringify(rows.slice(0, 3))}}};
    const assert = (value, msg) => {if (!value) throw new Error(msg);};
    document.getElementById('classic').innerHTML = jobTimingMarkup(job,t);
    document.getElementById('ytlive').innerHTML = jobTimingMarkup(job,t);
    assert(!document.querySelector('img'), 'XSS title must remain text');
    const summary = document.querySelector('.job-timing');
    await new Promise(r=>setTimeout(r,1200));
    assert(document.querySelector('.job-timing')===summary, 'clock must not recreate cards');
    const waitRows = async count => {
      for(let i=0;i<100;i++) {if(document.querySelectorAll('[data-content] > .job-timing-row').length===count) return; await new Promise(r=>setTimeout(r,30));}
      throw new Error('timing rows failed to load');
    };
    document.querySelector('[data-job-timing]').click(); await waitRows(50);
    assert(document.querySelector('.job-timing-dialog').open,'dialog is open');
    assert(document.querySelector('[data-content]').textContent.includes('Dönüştürülüyor'),'Turkish phase labels');
    document.querySelector('[data-next]').click(); await waitRows(50);
    assert(document.querySelector('[data-page]').textContent==='51–100 / 120','page two');
    document.querySelector('[data-next]').click(); await waitRows(20);
    assert(document.querySelector('[data-next]').disabled,'last page');
    assert(!document.querySelector('img'),'modal also escapes titles');
    return {rows:document.querySelectorAll('[data-content] > .job-timing-row').length, page:document.querySelector('[data-page]').textContent};
  })()`);
  const before = requests;
  await new Promise(resolve => setTimeout(resolve, 1200));
  if (requests !== before) throw new Error('Unexpected automatic network polling');
  const screenshot = process.argv.find(arg => arg.endsWith('.png'));
  if (screenshot) fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(async()=>{
    const dialog=document.querySelector('.job-timing-dialog');
    await new Promise(resolve=>{dialog.addEventListener('close',resolve,{once:true}); dialog.querySelector('[data-close]').click();});
    if(document.querySelector('.job-timing-dialog')) throw new Error('dialog did not close');
  })()`);
  console.log(JSON.stringify({ ...result, requests, status: 'JOB_TIMING_UI_OK' }));
  win.destroy();
  server.close();
  app.exit(0);
};
run().catch(error => { console.error(error); server.close(); app.exit(1); });
