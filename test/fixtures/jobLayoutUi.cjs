// Opt-in layout/theme checks against real styles and the real admin card renderer.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gharmonize-job-layout-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const root = path.resolve(__dirname, '../..');
const files = new Map([
  ['/style.css', 'public/style.css'], ['/ytlive.css', 'public/ytlive.css'],
  ['/ui/JobTimingView.js', 'public/ui/JobTimingView.js'],
  ['/ui/JobsPanelManager.js', 'public/ui/JobsPanelManager.js'],
  ['/ui/OutputExistenceClient.js', 'public/ui/OutputExistenceClient.js'],
  ['/tr.json', 'public/lang/tr.json']
]);
const startedAt = Date.now() - 15000;
const longTitle = 'Dilan Polat – Enercii (100 de 100 enerji) – Mezarımı Derin Kazın – O Yar Gelir (Sounds From Anatolian) '.repeat(4);
const timing = { version: 1, startedAt, endedAt: null, phase: 'converting', phaseStartedAt: startedAt + 2000,
  stageMs: { queued: 2000 }, trackCount: 3, counts: { downloading: 3 }, tracks: Array.from({ length: 3 }, (_, i) => ({
    key: `track:${i}`, title: i === 2 ? 'unbroken'.repeat(60) : longTitle, artist: 'Artist', phase: 'downloading',
    startedAt, phaseStartedAt: startedAt, endedAt: null, stageMs: {}
  })) };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    const classic = url.searchParams.get('ui') !== 'ytlive';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta charset=utf-8><link rel=stylesheet href="/${classic ? 'style' : 'ytlive'}.css"><style>body{padding:20px}#classic{max-width:500px}@media(max-width:700px){#classic{display:none}}</style>
      <main id=classic><div id=jobList></div></main><aside id=jobsPanel class=jobs-panel aria-hidden=false><header class=jobs-panel__header><div class=title>Aktif işler</div><div class=controls><button class=chip>Aktif</button><button class=chip>Tümü</button><button class=chip>Erişim istekleri</button><button id=jobsClose class=icon-btn>Kapat</button></div></header><div id=jobsList class=jobs-list></div></aside>`);
  } else if (url.pathname.startsWith('/api/jobs/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ timing: { ...timing, serverNow: Date.now() } }));
  } else if (files.has(url.pathname)) {
    res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.json') ? 'application/json' : 'text/javascript');
    res.end(fs.readFileSync(path.join(root, files.get(url.pathname))));
  } else { res.statusCode = 404; res.end(); }
});
(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: true, width: 1000, height: 850, webPreferences: { sandbox: true } });
  win.webContents.on('console-message', event => { if (event.level === 'error' || event.level >= 2) console.error(event.message); });
  // No font CDN or remote services are necessary for the isolated fixture.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['https://*/*'] }, (_, callback) => callback({ cancel: true }));
  const checks = [];
  const screenshot = process.argv.find(arg => arg.endsWith('.png'));
  for (const ui of ['classic', 'ytlive']) {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/?ui=${ui}`);
    await win.webContents.executeJavaScript(`(async()=>{
      const {jobTimingMarkup} = await import('/ui/JobTimingView.js');
      const {JobsPanelManager} = await import('/ui/JobsPanelManager.js');
      const messages=await(await fetch('/tr.json')).json(); const t=key=>messages[key]||key;
      const panel=new JobsPanelManager(); panel.panel=document.getElementById('jobsPanel'); panel.list=document.getElementById('jobsList'); panel.filter='all'; panel.t=t;
      panel.state.items=Array.from({length:6},(_,i)=>({id:'job_test'+i,status:'processing',currentPhase:'converting',format:'mp3',bitrate:'auto',metadata:{source:'spotify',spotifyTitle:${JSON.stringify(longTitle)}},timing:${JSON.stringify(timing)}}));
      if('${ui}'==='classic') {
        panel.render();
        document.getElementById('jobList').innerHTML='<div class="job-item"><div class="job-item-content"><strong>'+${JSON.stringify(longTitle)}+'</strong>'+jobTimingMarkup(panel.state.items[0],t)+'</div></div>';
      } else {
        document.getElementById('classic').remove();
        panel.panel.className='job-list'; panel.panel.removeAttribute('id');
        panel.panel.innerHTML='<article class="job-card">'+jobTimingMarkup(panel.state.items[0],t)+'</article>';
      }
    })()`);
    for (const theme of ['light', 'dark']) {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);
      for (const width of [1000, 360]) {
        win.setContentSize(width, 800);
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await win.webContents.executeJavaScript(`(()=>{
          const assert=(ok,msg)=>{if(!ok)throw new Error(msg);};
          const list=document.getElementById('jobsList')||document.querySelector('.job-list');
          if('${ui}'==='classic') {
            const panel=document.getElementById('jobsPanel');
            assert(panel.getBoundingClientRect().bottom<=innerHeight+1,'panel fits viewport: ${ui}/${theme}/${width}');
            assert(list.getBoundingClientRect().bottom<=panel.getBoundingClientRect().bottom+1,'scroll region fits variable header');
            const title=document.querySelector('.job-title > span:last-child');
            assert(title.getBoundingClientRect().height<=parseFloat(getComputedStyle(title).lineHeight)*2+1,'long title clamps to two lines: ${ui}/${theme}/${width}');
          }
          assert(list.scrollWidth<=list.clientWidth+1,'cards do not overflow horizontally');
          for(const el of document.querySelectorAll('.job-timing button')) assert(parseFloat(getComputedStyle(el).fontSize)<=12,'compact controls');
          return {ui:'${ui}',theme:'${theme}',width:${width},listHeight:list.clientHeight};
        })()`);
        checks.push(result);
        if (screenshot && width === 1000) {
          const out = path.parse(screenshot);
          fs.writeFileSync(path.join(out.dir, out.name + '-' + ui + '-' + theme + out.ext), (await win.webContents.capturePage()).toPNG());
        }
      }
      await win.webContents.executeJavaScript(`document.querySelector('[data-job-timing]').click()`);
      await new Promise(resolve => setTimeout(resolve, 500));
      const colors = await win.webContents.executeJavaScript(`(()=>{
        const d=document.querySelector('dialog'),c=d.querySelector('[data-content]');
        if(!d.open||d.getBoundingClientRect().bottom>innerHeight+1||c.scrollWidth>c.clientWidth+1)throw new Error('modal overflow');
        const s=getComputedStyle(d);return {background:s.backgroundColor,color:s.color,scheme:s.colorScheme};
      })()`);
      if (colors.scheme !== theme) throw new Error('Modal theme mismatch');
      await win.webContents.executeJavaScript(`(()=>{
        const name=document.querySelector('[data-content] > .job-timing-row .job-timing-row__identity');
        const before=name.getBoundingClientRect().height; name.querySelector('summary').click();
        if(!name.open||name.getBoundingClientRect().height<=before)throw new Error('long name must expand on click');
        name.open=false;
      })()`);
      checks.push({ ui, theme, ...colors });
      if (screenshot) {
        const out = path.parse(screenshot);
        fs.writeFileSync(path.join(out.dir, out.name + '-dialog-' + ui + '-' + theme + out.ext), (await win.webContents.capturePage()).toPNG());
      }
      await win.webContents.executeJavaScript(`document.querySelector('dialog').close()`);
    }
  }
  console.log(JSON.stringify({ status: 'JOB_LAYOUT_UI_OK', checks }));
  win.destroy(); server.close(); app.exit(0);
})().catch(error => { console.error(error); server.close(); app.exit(1); });
