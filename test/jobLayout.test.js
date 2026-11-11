import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobTimingMarkup, timingRowsMarkup } from '../public/ui/JobTimingView.js';

const timingStart = /\.job-timing\s*,\s*\.job-timing-dialog\s*\{/;

function assertDeclarations(css, rule, expected) {
  const block = css.match(rule)?.[1];
  assert.ok(block, `missing CSS rule: ${rule}`);
  const declarations = new Map(block.split(';').filter(part => part.trim()).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' ')];
  }));
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(declarations.get(property), value, `${rule}: ${property}`);
  }
}

test('timing surfaces use both interface palettes and scope explicit color schemes to the selected theme', () => {
  const sections = ['style.css', 'ytlive.css'].map(file => {
    const css = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(css, /--timing-surface:\s*var\(--surface,\s*var\(--bg-elev/);
    assert.match(css, /--timing-text:\s*var\(--text,/);
    assertDeclarations(css, /html\[data-theme=["']?light["']?\]\s+\.job-timing-dialog\s*\{([^}]*)\}/, { 'color-scheme': 'light' });
    assertDeclarations(css, /html\[data-theme=["']?dark["']?\]\s+\.job-timing-dialog\s*\{([^}]*)\}/, { 'color-scheme': 'dark' });
    assertDeclarations(css, /\.job-timing-dialog\s+\[data-content\]\s*\{([^}]*)\}/, { 'min-height': '0', overflow: 'auto' });
    const start = css.search(timingStart);
    assert.notEqual(start, -1, 'shared timing rules are present');
    return css.slice(start);
  });
  assert.equal(sections[0], sections[1], 'both interfaces include the same shared timing rules');
});

test('Classic job layout has a flexible scroll region and scoped long-title rules without changing global typography', () => {
  const stylesheet = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const start = stylesheet.search(/#jobsPanel\s*\{/);
  const end = stylesheet.search(timingStart);
  assert.ok(start >= 0 && end > start, 'Classic job rules precede the shared timing rules');
  const css = stylesheet.slice(start, end);
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="style.css"/);
  assertDeclarations(css, /#jobsPanel\s+\.jobs-list\s*\{([^}]*)\}/, { flex: '1 1 auto', 'min-height': '0', height: 'auto' });
  assertDeclarations(css, /#jobsPanel\s+\.job-title\s*>\s*span:last-child\s*\{([^}]*)\}/, { '-webkit-line-clamp': '2' });
  assertDeclarations(css, /#jobList\s+\.job-item-content\s*>\s*strong\s*\{([^}]*)\}/, { '-webkit-line-clamp': '3' });
  assert.doesNotMatch(css, /(?:^|[{}])\s*(?:body|button|:root)\s*\{/);
});

test('job styles are bundled in the existing stylesheets, not loaded as extra files', () => {
  for (const file of ['index.html', 'ytlive.html', 'ui/JobTimingView.js']) {
    const source = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /job-(?:layout|timing)\.css/);
  }
  for (const file of ['job-layout.css', 'job-timing.css']) {
    assert.equal(fs.existsSync(new URL(`../public/${file}`, import.meta.url)), false);
  }
});

test('compact rows separate name, phase and elapsed time; detailed names expand safely', () => {
  const timing = { startedAt: 1000, endedAt: 2000, phase: 'completed', phaseStartedAt: 2000, stageMs: {},
    tracks: [{ key: 'single', title: 'Long <img src=x> "title"', artist: 'Artist', startedAt: 1000,
      endedAt: 2000, phase: 'completed', phaseStartedAt: 2000, stageMs: { converting: 1000 } }] };
  const card = jobTimingMarkup({ id: 'fixture', timing }, key => key);
  for (const name of ['job-timing__name', 'job-timing__phase', 'job-timing__elapsed']) assert.ok(card.includes(name));
  const detail = timingRowsMarkup(timing, key => key);
  assert.match(detail, /<details class="job-timing-row__identity">/);
  assert.ok(detail.includes('&lt;img'));
  assert.ok(detail.includes('&quot;title&quot;'));
  assert.ok(!detail.includes('<img'));
});
