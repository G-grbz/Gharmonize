import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobTimingMarkup, timingRowsMarkup } from '../public/ui/JobTimingView.js';

test('timing surfaces use both interface palettes and scope explicit color schemes to the selected theme', () => {
  const sections = ['style.css', 'ytlive.css'].map(file => {
    const css = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(css, /--timing-surface:\s*var\(--surface, var\(--bg-elev/);
    assert.match(css, /--timing-text:\s*var\(--text,/);
    assert.match(css, /html\[data-theme="light"\] \.job-timing-dialog \{\s*color-scheme: light;/);
    assert.match(css, /html\[data-theme="dark"\] \.job-timing-dialog \{\s*color-scheme: dark;/);
    assert.match(css, /\.job-timing-dialog \[data-content\] \{\s*min-height: 0;\s*overflow: auto;/);
    return css.split('/* Shared timing UI')[1];
  });
  assert.equal(sections[0], sections[1], 'both interfaces include the same shared timing rules');
});

test('Classic job layout has a flexible scroll region and scoped long-title rules without changing global typography', () => {
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8')
    .split('/* Classic job surfaces only.')[1].split('/* Shared timing UI')[0];
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="style.css"/);
  assert.match(css, /#jobsPanel \.jobs-list \{\s*flex: 1 1 auto;\s*min-height: 0;\s*height: auto;/);
  assert.match(css, /#jobsPanel \.job-title > span:last-child \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /#jobList \.job-item-content > strong \{[^}]*-webkit-line-clamp: 3;/);
  assert.ok(!/(?:^|\n)(?:body|button|:root)\s*\{/.test(css));
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
