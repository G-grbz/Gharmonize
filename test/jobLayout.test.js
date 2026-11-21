import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobTimingMarkup, timingRowsMarkup } from '../public/ui/JobTimingView.js';

// The stylesheets are reformatted (rule order, spacing) by tools, so the
// checks compare parsed rules, not text or positions.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeSelector(selector) {
  return selector.replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/\[([\w-]+)=(["'])([\w-]+)\2\]/g, '[$1=$3]').trim();
}

// "(width <= 880px)" and "(max-width: 880px)" are the same condition.
function normalizeCondition(condition) {
  return condition.replace(/\s+/g, ' ').trim()
    .replace(/\(\s*width\s*<=\s*([^)]+?)\s*\)/g, '(max-width:$1)')
    .replace(/\(\s*width\s*>=\s*([^)]+?)\s*\)/g, '(min-width:$1)')
    .replace(/\s*:\s*/g, ':');
}

function normalizeValue(value) {
  return value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/(^|[^\d.])0\.(\d)/g, '$1.$2').trim();
}

/** Style rules as { context, selectors, declarations } (context: enclosing at-rules). */
function parseRules(source) {
  const css = stripComments(source);
  const rules = [];
  const walk = (start, context) => {
    let head = '';
    for (let i = start; i < css.length; i += 1) {
      const char = css[i];
      if (char === '}') return i;
      if (char === ';' && head.trim().startsWith('@')) { head = ''; continue; }
      if (char !== '{') { head += char; continue; }
      const prelude = head.trim();
      head = '';
      if (/^@(media|supports|layer|container)\b/.test(prelude)) {
        i = walk(i + 1, [...context, normalizeCondition(prelude)]);
        continue;
      }
      let depth = 1;
      let end = i + 1;
      while (depth) {
        if (css[end] === '{') depth += 1;
        else if (css[end] === '}') depth -= 1;
        end += 1;
      }
      if (!prelude.startsWith('@')) {
        const declarations = new Map();
        for (const part of css.slice(i + 1, end - 1).split(';')) {
          const colon = part.indexOf(':');
          if (colon > 0) declarations.set(part.slice(0, colon).trim().toLowerCase(), normalizeValue(part.slice(colon + 1)));
        }
        rules.push({ context: context.join(' | '), selectors: normalizeSelector(prelude).split(','), declarations });
      }
      i = end - 1;
    }
    return css.length;
  };
  walk(0, []);
  return rules;
}

/** One entry per (context, selector, property) of the rules `pick` selects; later rules win. */
function ruleMap(rules, pick) {
  const map = new Map();
  for (const rule of rules) {
    for (const selector of rule.selectors.filter(pick)) {
      for (const [property, value] of rule.declarations) map.set(`${rule.context} :: ${selector} :: ${property}`, value);
    }
  }
  return map;
}

function declarationsOf(rules, selector, context = '') {
  const wanted = normalizeSelector(selector);
  const found = rules.filter((rule) => rule.context === context &&
    (rule.selectors.join(',') === wanted || rule.selectors.includes(wanted)));
  assert.ok(found.length, `missing CSS rule: ${selector}`);
  return new Map(found.flatMap((rule) => [...rule.declarations]));
}

function assertRule(rules, selector, expected) {
  const declarations = declarationsOf(rules, selector);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(declarations.get(property), value, `${selector}: ${property}`);
  }
}

test('timing surfaces use both interface palettes and scope explicit color schemes to the selected theme', () => {
  const timingRules = ['style.css', 'ytlive.css'].map(file => {
    const css = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const rules = parseRules(css);
    const shared = declarationsOf(rules, '.job-timing,.job-timing-dialog');
    assert.match(shared.get('--timing-surface') || '', /^var\(--surface,var\(--bg-elev/);
    assert.match(shared.get('--timing-text') || '', /^var\(--text,/);
    assertRule(rules, 'html[data-theme="light"] .job-timing-dialog', { 'color-scheme': 'light' });
    assertRule(rules, 'html[data-theme="dark"] .job-timing-dialog', { 'color-scheme': 'dark' });
    assertRule(rules, '.job-timing-dialog [data-content]', { 'min-height': '0', overflow: 'auto' });
    return ruleMap(rules, (selector) => selector.includes('job-timing'));
  });
  assert.ok(timingRules[0].size > 0, 'shared timing rules are present');
  assert.deepEqual(Object.fromEntries(timingRules[0]), Object.fromEntries(timingRules[1]),
    'both interfaces include the same shared timing rules');
});

test('Classic job layout has a flexible scroll region and scoped long-title rules without changing global typography', () => {
  const rules = parseRules(fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'));
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="style.css"/);
  assertRule(rules, '#jobsPanel .jobs-list', { flex: '1 1 auto', 'min-height': '0', height: 'auto' });
  assertRule(rules, '#jobsPanel .job-title > span:last-child', { '-webkit-line-clamp': '2' });
  assertRule(rules, '#jobList .job-item-content > strong', { '-webkit-line-clamp': '3' });
  // No job panel rule (#jobsPanel, #jobList…) also styles the whole page,
  // every button or the root.
  const jobRules = rules.filter((r) => r.selectors.some((s) => /#job/.test(s)))
  assert.ok(jobRules.length)
  for (const rule of jobRules) {
    for (const selector of rule.selectors) {
      assert.doesNotMatch(selector, /^(?:html|body|button|:root|\*)$/, `job layout rule also styles ${selector}`);
    }
  }
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
