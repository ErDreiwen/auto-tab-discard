import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const matrixUrl = new URL('../docs/RELIABILITY_ISSUE_MATRIX.md', import.meta.url);
const source = fs.readFileSync(fileURLToPath(matrixUrl), 'utf8');

test('reliability matrix contains exactly 25 current and 35 potential issues', () => {
  const headingPattern = /^### ([CP])(\d{2}) — (.+)$/gm;
  const headings = [...source.matchAll(headingPattern)];

  assert.equal(headings.length, 60);

  for (const [kind, expected] of [['C', 25], ['P', 35]]) {
    const numbers = headings
      .filter(match => match[1] === kind)
      .map(match => Number(match[2]));

    assert.deepEqual(numbers, Array.from({length: expected}, (_, index) => index + 1));
  }
});

test('every reliability issue has a GitHub record and four to seven subissues', () => {
  const headingPattern = /^### ([CP])(\d{2}) — (.+)$/gm;
  const headings = [...source.matchAll(headingPattern)];

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? source.indexOf('\n## Mechanical contract');
    const body = source.slice(start, end);
    const checklist = body.match(/^- \[[ xX]\] .+$/gm) || [];
    const checked = checklist.filter(item => /^- \[[xX]\]/.test(item)).length;
    const declared = body.match(/Checklist: (\d+)\/(\d+)/);

    assert.match(body, /GitHub: \[#\d+\]\(https:\/\/github\.com\/ErDreiwen\/auto-tab-discard\/issues\/\d+\)/);
    assert.ok(checklist.length >= 4 && checklist.length <= 7,
      `${heading[1]}${heading[2]} has ${checklist.length} subissues`);
    assert.deepEqual(declared?.slice(1).map(Number), [checked, checklist.length],
      `${heading[1]}${heading[2]} summary does not match its checklist`);
  }
});

test('matrix binds the audited green browser-canary baseline', () => {
  assert.match(source, /a47b3ed9a4afe9cde3e4df18d66d93fdb116fe2b/);
  assert.match(source, /actions\/runs\/31770690573/);
  assert.match(source, /seven browser lanes, and aggregate browser gate all passed/);
});
