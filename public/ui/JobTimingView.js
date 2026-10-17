export const escapeTimingHtml = value => String(value ?? '').replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function formatTimingDuration(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const label = (t, key) => t(`timing.${key}`);
const phaseLabel = (t, phase) => label(t, `phase.${phase}`);
function clock(row, offset = 0) {
  const now = row.endedAt || Date.now() - offset;
  return `<span ${row.endedAt ? '' : `data-timing-clock="${Number(row.startedAt) || now}" data-timing-offset="${offset}"`}>${formatTimingDuration(now - row.startedAt)}</span>`;
}

let installed = false;
let timer = null;
function tick() {
  timer = null;
  if (document.hidden) return;
  let active = false;
  for (const el of document.querySelectorAll('[data-timing-clock]')) {
    if (el.closest('[aria-hidden="true"], [hidden]')) continue;
    if (el.closest('dialog') && !el.closest('dialog').open) continue;
    const value = formatTimingDuration(Date.now() - Number(el.dataset.timingOffset || 0) - Number(el.dataset.timingClock));
    if (el.textContent !== value) el.textContent = value;
    active = true;
  }
  if (active) timer = setTimeout(tick, 1000);
}
function startClock() {
  if (!timer && !document.hidden) timer = setTimeout(tick, 1000);
}

// SSE already supplies active rows. Do not add background network polling or
// repaint complete job cards just to advance a clock.
export function jobTimingMarkup(job, t) {
  if (!job?.timing?.startedAt) return '';
  if (typeof document !== 'undefined') install(t);
  const timing = job.timing;
  const rows = (timing.tracks || []).slice(0, 3).map(row =>
    `<div class="job-timing__active"><span class="job-timing__name" title="${escapeTimingHtml(row.artist ? `${row.artist} — ${row.title}` : row.title || row.key)}">${escapeTimingHtml(row.artist ? `${row.artist} — ${row.title}` : row.title || row.key)}</span><span class="job-timing__phase">${escapeTimingHtml(phaseLabel(t, row.phase))}</span><span class="job-timing__elapsed">${clock({ ...row, startedAt: row.phaseStartedAt })}</span></div>`).join('');
  return `<div class="job-timing"><div class="job-timing__summary"><span class="job-timing__total"><span aria-hidden="true">⏱</span> ${escapeTimingHtml(label(t, 'total'))}: ${clock(timing)}</span>
    <button type="button" data-job-timing="${escapeTimingHtml(job.id)}">${escapeTimingHtml(label(t, 'details'))}</button></div>${rows || (!timing.endedAt ? `<div class="job-timing__fallback">${escapeTimingHtml(phaseLabel(t, timing.phase))}</div>` : '')}</div>`;
}

export function timingRowsMarkup(timing, t, offset = 0) {
  return (timing.tracks || []).map(row => {
    const phases = { ...row.stageMs };
    const name = escapeTimingHtml(row.artist ? `${row.artist} — ${row.title}` : row.title || row.key);
    if (!row.endedAt) phases[row.phase] = (phases[row.phase] || 0) + Math.max(0, Date.now() - offset - row.phaseStartedAt);
    return `<article class="job-timing-row"><div class="job-timing-row__header"><details class="job-timing-row__identity"><summary title="${name}"><strong>${name}</strong></summary></details>
      <span class="job-timing-row__state">${escapeTimingHtml(phaseLabel(t, row.phase))} · ${clock(row, offset)}</span></div>
      <dl>${Object.entries(phases).map(([phase, ms]) => `<div><dt>${escapeTimingHtml(phaseLabel(t, phase))}</dt><dd>${phase === row.phase && !row.endedAt
        ? clock({ startedAt: row.phaseStartedAt - (row.stageMs[phase] || 0), endedAt: null }, offset)
        : formatTimingDuration(ms)}</dd></div>`).join('')}</dl></article>`;
  }).join('');
}

function install(t) {
  startClock();
  if (installed) return;
  installed = true;
  document.addEventListener('visibilitychange', startClock);
  document.addEventListener('click', startClock);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-job-timing]');
    if (!button) return;
    openTiming(button.dataset.jobTiming, t);
  });
}

function openTiming(id, t) {
  document.querySelector('.job-timing-dialog')?.close();
  const dialog = document.createElement('dialog');
  dialog.className = 'job-timing-dialog';
  dialog.innerHTML = `<header><h2>${escapeTimingHtml(label(t, 'details'))}</h2><button type="button" data-close>${escapeTimingHtml(label(t, 'close'))}</button></header>
    <p>${escapeTimingHtml(label(t, 'note'))}</p><div data-content></div><footer>
    <button type="button" data-prev>${escapeTimingHtml(label(t, 'previous'))}</button>
    <span data-page></span><button type="button" data-next>${escapeTimingHtml(label(t, 'next'))}</button>
    <button type="button" data-refresh>${escapeTimingHtml(label(t, 'refresh'))}</button></footer>`;
  document.body.append(dialog);
  let offset = 0;
  let request = null;
  const load = async () => {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    dialog.querySelector('[data-prev]').disabled = true;
    dialog.querySelector('[data-next]').disabled = true;
    dialog.querySelector('[data-content]').textContent = label(t, 'loading');
    try {
      const headers = {};
      try { const token = localStorage.getItem('gharmonize_admin_token'); if (token) headers.Authorization = `Bearer ${token}`; } catch {}
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/timing?offset=${offset}&limit=50`, { signal: controller.signal, headers, cache: 'no-store' });
      if (!response.ok) throw new Error('Timing request failed');
      const { timing } = await response.json();
      if (controller.signal.aborted || !dialog.open) return;
      if (!timing) { dialog.querySelector('[data-content]').textContent = label(t, 'unavailable'); return; }
      const clockOffset = Date.now() - timing.serverNow;
      dialog.querySelector('[data-content]').innerHTML = `<section class="job-timing-overall">${timingRowsMarkup({ tracks: [{ ...timing, title: label(t, 'total'), artist: '' }] }, t, clockOffset)}</section>
        ${timingRowsMarkup(timing, t, clockOffset)}${!timing.tracks.length ? `<p>${escapeTimingHtml(label(t, 'noTracks'))}</p>` : ''}
        ${timing.truncated ? `<p>${escapeTimingHtml(label(t, 'limited'))}</p>` : ''}`;
      dialog.querySelector('[data-page]').textContent = timing.trackCount ? `${Math.min(offset + 1, timing.trackCount)}–${Math.min(offset + 50, timing.trackCount)} / ${timing.trackCount}` : '0 / 0';
      dialog.querySelector('[data-prev]').disabled = offset === 0;
      dialog.querySelector('[data-next]').disabled = offset + 50 >= timing.trackCount;
      startClock();
    } catch (error) {
      if (!controller.signal.aborted && dialog.open) dialog.querySelector('[data-content]').textContent = label(t, 'error');
    }
  };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.querySelector('[data-prev]').onclick = () => { offset = Math.max(0, offset - 50); load(); };
  dialog.querySelector('[data-next]').onclick = () => { offset += 50; load(); };
  dialog.querySelector('[data-refresh]').onclick = load;
  dialog.addEventListener('close', () => { request?.abort(); dialog.remove(); }, { once: true });
  dialog.showModal();
  load();
}
