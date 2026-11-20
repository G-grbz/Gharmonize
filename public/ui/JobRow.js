// Compact job row shared by the classic page's job list and the jobs panel.
// One line says what the job is and where it stands; everything else
// (format details, logs, timings, per-track downloads) sits behind "›".

const TERMINAL = new Set(['completed', 'error', 'canceled', 'cancelled']);

export function isTerminalStatus(status) {
  return TERMINAL.has(String(status || '').toLowerCase());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// active | done | warn (finished with skipped items) | error | canceled
export function jobRowState(status, { skipped = 0 } = {}) {
  const s = String(status || '').toLowerCase();
  if (s === 'error') return 'error';
  if (s === 'canceled' || s === 'cancelled') return 'canceled';
  if (s === 'completed') return skipped > 0 ? 'warn' : 'done';
  return 'active';
}

// "3:07" / "1:02:05" — language neutral.
export function formatElapsed(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function jobTimeMs(value) {
  if (value == null || value === '') return 0;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

// today | yesterday | older, by local calendar day.
export function jobDayGroup(timeMs, now = Date.now()) {
  if (!timeMs) return 'older';
  const day = (ms) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(timeMs)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return 'older';
}

export function jobDayLabel(group, t) {
  const fallback = { today: 'Today', yesterday: 'Yesterday', older: 'Earlier' }[group];
  const text = t?.(`jobs.group.${group}`);
  return text && text !== `jobs.group.${group}` ? text : fallback;
}

// Text of a compact summary: non-empty parts joined with " · ".
export function joinSummary(parts = []) {
  return parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(' · ');
}

/**
 * Markup of one row.
 * @param {object} o
 * @param {string} o.id           job id (for the details toggle)
 * @param {string} o.state        jobRowState()
 * @param {string} o.title        plain text
 * @param {string} o.summary      plain text (see joinSummary)
 * @param {number|null} o.progress  0..100 for running jobs, null otherwise
 * @param {string} o.actionsHtml  trusted markup (download / stop buttons)
 * @param {string} o.detailsHtml  trusted markup shown when expanded
 * @param {boolean} o.expanded
 * @param {string} o.moreLabel    tooltip of the details toggle
 */
export function jobRowMarkup(o) {
  const progress = Number.isFinite(o.progress) ? Math.max(0, Math.min(100, o.progress)) : null;
  const expanded = !!o.expanded;
  return `
    <div class="jrow__head">
      <span class="jrow__dot" aria-hidden="true"></span>
      <div class="jrow__text">
        <div class="jrow__title" title="${escapeHtml(o.title)}">${escapeHtml(o.title)}</div>
        ${o.summary ? `<div class="jrow__sub">${escapeHtml(o.summary)}</div>` : ''}
      </div>
      <div class="jrow__actions">
        ${o.actionsHtml || ''}
        ${o.detailsHtml ? `<button type="button" class="jrow__more" data-job-toggle="${escapeHtml(o.id)}"
          aria-expanded="${expanded}" title="${escapeHtml(o.moreLabel || 'Details')}" aria-label="${escapeHtml(o.moreLabel || 'Details')}">›</button>` : ''}
      </div>
    </div>
    ${progress !== null ? `<div class="jrow__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${progress}%"></span></div>` : ''}
    ${o.detailsHtml ? `<div class="jrow__details"${expanded ? '' : ' hidden'}>${o.detailsHtml}</div>` : ''}
  `;
}

// One delegated listener per list: "›" opens/closes the details and the
// caller remembers which rows are open across re-renders.
export function bindJobRowToggles(root, expandedSet) {
  if (!root || root.dataset.jobRowToggles) return;
  root.dataset.jobRowToggles = '1';
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-job-toggle]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const row = button.closest('.jrow');
    const details = row?.querySelector('.jrow__details');
    if (!details) return;
    const open = details.hidden;
    details.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    const id = button.getAttribute('data-job-toggle');
    if (open) expandedSet.add(id); else expandedSet.delete(id);
  });
}

// Sorts finished rows (newest first) under Today / Yesterday / Earlier
// headers. Rows carry data-time; `keepFirst` elements (a toolbar) stay on top.
export function regroupFinishedRows(container, t, { rowSelector = '.jrow', keepFirst = '.jrow-toolbar' } = {}) {
  if (!container) return;
  container.querySelectorAll(':scope > .jrow-day').forEach((el) => el.remove());
  const rows = Array.from(container.querySelectorAll(`:scope > ${rowSelector}`));
  rows.sort((a, b) => Number(b.dataset.time || 0) - Number(a.dataset.time || 0));
  const anchor = container.querySelector(`:scope > ${keepFirst}`);
  let last = null;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const group = jobDayGroup(Number(row.dataset.time || 0));
    if (group !== last) {
      const header = document.createElement('div');
      header.className = 'jrow-day';
      header.textContent = jobDayLabel(group, t);
      frag.appendChild(header);
      last = group;
    }
    frag.appendChild(row);
  }
  if (anchor) anchor.after(frag);
  else container.prepend(frag);
}
