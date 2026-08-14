import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const relativeImports = source => [
  ...[...source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]),
  ...[...source.matchAll(/^\s*import\s*['"](\.[^'"]+)['"]/gm)].map(match => match[1])
];

const workerGraph = async entry => {
  const pending = [entry];
  const modules = new Map();
  while (pending.length) {
    const url = pending.pop();
    if (modules.has(url.href)) {
      continue;
    }
    const source = await readFile(url, 'utf8');
    modules.set(url.href, source);
    for (const specifier of relativeImports(source)) {
      pending.push(new URL(specifier, url));
    }
  }
  return modules;
};

test('packaged service-worker graph contains no unsupported dynamic imports', async () => {
  const graph = await workerGraph(new URL('../v3/worker/core.mjs', import.meta.url));
  assert.ok([...graph.keys()].some(url => url.endsWith('/core/helper-registry.mjs')),
    'the compatibility scan must reach blank-helper recovery');

  const violations = [...graph]
    .filter(([, source]) => /\bimport\s*\(/.test(source))
    .map(([url]) => new URL(url).pathname.split('/').slice(-4).join('/'));
  assert.deepEqual(violations, [],
    'Chrome 102 cannot evaluate import() in an extension service worker');
});
