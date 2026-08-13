import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {packageRelease} from '../scripts/package-release.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');

const centralEntries = archive => {
  const endOffset = archive.length - 22;
  assert.equal(archive.readUInt32LE(endOffset), 0x06054b50, 'archive must end with an EOCD record');
  const count = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'central directory signature');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      versionMadeBy: archive.readUInt16LE(offset + 4),
      method: archive.readUInt16LE(offset + 10),
      time: archive.readUInt16LE(offset + 12),
      date: archive.readUInt16LE(offset + 14),
      permissions: archive.readUInt32LE(offset + 38),
      size: archive.readUInt32LE(offset + 24),
      localOffset: archive.readUInt32LE(offset + 42)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const archiveEntry = (archive, name) => {
  const record = centralEntries(archive).find(candidate => candidate.name === name);
  assert.ok(record, `archive must contain ${name}`);
  assert.equal(record.method, 0, `${name} must use the stored ZIP method`);
  assert.equal(archive.readUInt32LE(record.localOffset), 0x04034b50, `${name}: local header signature`);
  const nameLength = archive.readUInt16LE(record.localOffset + 26);
  const extraLength = archive.readUInt16LE(record.localOffset + 28);
  const start = record.localOffset + 30 + nameLength + extraLength;
  return archive.subarray(start, start + record.size);
};

const lf = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

test('two release builds are byte-identical, complete, and normalized', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'auto-tab-discard-release-'));
  t.after(() => rm(temporaryRoot, {recursive: true, force: true}));
  const sourceRoot = path.resolve(import.meta.dirname, '..', 'v3');
  const first = await packageRelease({sourceRoot, outputDirectory: path.join(temporaryRoot, 'first'), releaseMode: false});
  const second = await packageRelease({sourceRoot, outputDirectory: path.join(temporaryRoot, 'second'), releaseMode: false});

  assert.deepEqual(first.entries, [...first.entries].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.deepEqual(first.entries, second.entries);
  assert.ok(first.entries.includes('manifest.json'));
  assert.ok(first.entries.includes('worker/core.mjs'));
  assert.ok(first.entries.includes('worker/core/native-discard-state.mjs'));
  assert.ok(first.entries.includes('data/page.png'));
  assert.ok(first.entries.includes('LICENSE'));
  assert.ok(first.entries.includes('README.md'));
  assert.ok(first.entries.includes('FORK_NOTES.md'));
  assert.ok(first.entries.includes('docs/RELEASE_PACKAGING.md'));
  assert.ok(!first.entries.some(name => name.startsWith('data/icons/tmp/')));
  assert.ok(!first.entries.includes('data/icons/convert.txt'));
  assert.ok(first.excluded.includes('data/icons/tmp'));

  const zipName = first.archives.find(item => item.file.endsWith('.zip')).file;
  const xpiName = first.archives.find(item => item.file.endsWith('.xpi')).file;
  const firstZip = await readFile(path.join(first.outputDirectory, zipName));
  const firstXpi = await readFile(path.join(first.outputDirectory, xpiName));
  const secondZip = await readFile(path.join(second.outputDirectory, zipName));
  assert.deepEqual(firstZip, firstXpi, 'ZIP and XPI are aliases of the same deterministic package');
  assert.deepEqual(firstZip, secondZip, 'consecutive builds must be byte-identical');
  assert.equal(first.metadata.archives[0].sha256, sha256(firstZip));
  assert.deepEqual(first.metadata, second.metadata);
  assert.equal(first.metadata.formatVersion, 3);
  assert.deepEqual(first.metadata.provenance, {mode: 'programmatic-fixture'});
  assert.deepEqual(first.metadata.testEvidence, []);
  assert.deepEqual(first.metadata.inventory.map(item => item.path), first.entries);
  assert.ok(first.metadata.inventory.every(item => item.bytes >= 0 && /^[a-f\d]{64}$/.test(item.sha256)));
  assert.match(first.metadata.sourceTreeSha256, /^[a-f\d]{64}$/);
  assert.deepEqual(first.rootFiles, [
    'FORK_NOTES.md',
    'LICENSE',
    'README.md',
    'docs/MIGRATIONS.md',
    'docs/PERMISSION_CHANGES.md',
    'docs/RELEASE_PACKAGING.md',
    'docs/release-policy.json'
  ]);
  assert.equal(first.metadata.localeCount, first.locales.length);

  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const expectedReadme = lf(await readFile(path.join(repositoryRoot, 'README.md'), 'utf8'));
  const expectedLicense = lf(await readFile(path.join(repositoryRoot, 'LICENSE'), 'utf8'));
  const packagedReadme = archiveEntry(firstZip, 'README.md').toString('utf8');
  const packagedNotes = archiveEntry(firstZip, 'FORK_NOTES.md').toString('utf8');
  const packagedGuide = archiveEntry(firstZip, 'docs/RELEASE_PACKAGING.md').toString('utf8');
  assert.equal(packagedReadme, expectedReadme);
  assert.notEqual(packagedReadme.trim(), '../README.md');
  assert.equal(archiveEntry(firstZip, 'LICENSE').toString('utf8'), expectedLicense);
  assert.match(packagedReadme, /Edge 151\.0\.4129\.72 passed the 19-scenario popup matrix[\s\S]*current-tree direct-native matrix/);
  assert.match(packagedReadme, /native-frozen smoke[\s\S]*final generated artifact tree must pass that smoke and every other browser gate before release/);
  assert.match(packagedNotes, /popup matrix passed all 19 scenarios/);
  assert.match(packagedNotes, /direct physical discard with zero activation, scripting, loading, focus, or document requests/);
  assert.match(packagedNotes, /current-tree direct-native matrix passed all five release scopes, four cancellation boundaries, and three forced worker-loss boundaries/);
  assert.match(packagedNotes, /every Edge matrix pass against that exact generated artifact tree/);
  assert.doesNotMatch(packagedReadme, /Edge 151\.0\.4129\.72 verification/);
  assert.match(packagedGuide, /every gate, including the redesigned native-frozen smoke, passes against the final extracted artifact tree/);
  assert.doesNotMatch(packagedGuide, /including all 14 Edge popup scenarios and the frozen-tab smoke/);
  assert.match(packagedGuide, /fork-owned name, GitHub homepage, and Gecko ID/);
  assert.match(packagedGuide, /unsigned AMO submission input only/);
  assert.match(packagedGuide, /final generated artifact tree/);

  const records = centralEntries(firstZip);
  assert.deepEqual(records.map(record => record.name), first.entries);
  for (const record of records) {
    assert.equal(record.versionMadeBy, 0x0314, `${record.name}: Unix ZIP creator`);
    assert.equal(record.method, 0, `${record.name}: stored bytes avoid compressor drift`);
    assert.equal(record.time, 0, `${record.name}: fixed DOS time`);
    assert.equal(record.date, 0x0021, `${record.name}: fixed DOS date`);
    assert.equal(record.permissions, (0o100644 << 16) >>> 0, `${record.name}: normalized 0644 mode`);
  }

  const sums = await readFile(first.sumsPath, 'utf8');
  for (const archive of first.archives) {
    assert.match(sums, new RegExp(`^${archive.sha256}  ${archive.file}$`, 'm'));
  }
});

test('release validation fails closed for missing resources and invalid JSON', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'auto-tab-discard-invalid-release-'));
  t.after(() => rm(temporaryRoot, {recursive: true, force: true}));
  const sourceRoot = path.join(temporaryRoot, 'v3');
  await mkdir(path.join(sourceRoot, '_locales', 'en'), {recursive: true});
  await writeFile(path.join(sourceRoot, '_locales', 'en', 'messages.json'), '{}\n');
  await writeFile(path.join(sourceRoot, 'manifest.json'), `${JSON.stringify({
    manifest_version: 3,
    version: '1.0.0',
    name: 'Fixture',
    default_locale: 'en',
    icons: {'16': '/missing.png'}
  }, null, 2)}\n`);

  await assert.rejects(
    packageRelease({sourceRoot, outputDirectory: path.join(temporaryRoot, 'missing-output'), releaseMode: false}),
    /icons\.16 is missing from the package: missing\.png/
  );

  await writeFile(path.join(sourceRoot, 'missing.png'), 'fixture');
  await writeFile(path.join(sourceRoot, 'broken.json'), '{not-json}\n');
  await assert.rejects(
    packageRelease({sourceRoot, outputDirectory: path.join(temporaryRoot, 'json-output'), releaseMode: false}),
    /Invalid JSON in broken\.json/
  );

  await rm(path.join(sourceRoot, 'broken.json'));
  await writeFile(path.join(sourceRoot, '_locales', 'en', 'messages.json'), `${JSON.stringify({
    required: {message: 'Required message'}
  }, null, 2)}\n`);
  await mkdir(path.join(sourceRoot, '_locales', 'fr'), {recursive: true});
  await writeFile(path.join(sourceRoot, '_locales', 'fr', 'messages.json'), '{}\n');
  await assert.rejects(
    packageRelease({sourceRoot, outputDirectory: path.join(temporaryRoot, 'locale-output'), releaseMode: false}),
    /_locales\/fr\/messages\.json is missing default messages: required/
  );
});

test('logical text inputs produce identical archives across LF and CRLF checkouts', async t => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'auto-tab-discard-cross-checkout-'));
  t.after(() => rm(temporaryRoot, {recursive: true, force: true}));

  const createCheckout = async (root, newline) => {
    const sourceRoot = path.join(root, 'v3');
    await mkdir(path.join(sourceRoot, '_locales', 'en'), {recursive: true});
    await mkdir(path.join(sourceRoot, 'worker'), {recursive: true});
    const writeText = (target, text) => writeFile(target, text.replaceAll('\n', newline), 'utf8');
    await writeText(path.join(root, 'README.md'), '# Fixture\n\nPortable release input.\n');
    await writeText(path.join(root, 'LICENSE'), 'Mozilla Public License Version 2.0\n');
    await writeText(path.join(sourceRoot, 'README.md'), '../README.md\n');
    await writeText(path.join(sourceRoot, 'manifest.json'), `${JSON.stringify({
      manifest_version: 3,
      version: '1.2.3',
      name: '__MSG_name__',
      default_locale: 'en',
      background: {service_worker: 'worker/core.mjs', type: 'module'}
    }, null, 2)}\n`);
    await writeText(path.join(sourceRoot, '_locales', 'en', 'messages.json'), `${JSON.stringify({
      name: {message: 'Fixture'}
    }, null, 2)}\n`);
    await writeText(path.join(sourceRoot, 'worker', 'core.mjs'), "export const fixture = true;\n");
  };

  const lfRoot = path.join(temporaryRoot, 'lf');
  const crlfRoot = path.join(temporaryRoot, 'crlf');
  await createCheckout(lfRoot, '\n');
  await createCheckout(crlfRoot, '\r\n');
  const first = await packageRelease({
    repositoryRoot: lfRoot,
    outputDirectory: path.join(temporaryRoot, 'out-lf'),
    releaseMode: false
  });
  const second = await packageRelease({
    repositoryRoot: crlfRoot,
    outputDirectory: path.join(temporaryRoot, 'out-crlf'),
    releaseMode: false
  });
  const firstZip = await readFile(path.join(first.outputDirectory, 'auto-tab-discard-1.2.3.zip'));
  const secondZip = await readFile(path.join(second.outputDirectory, 'auto-tab-discard-1.2.3.zip'));

  assert.deepEqual(firstZip, secondZip);
  assert.equal(first.metadata.sourceTreeSha256, second.metadata.sourceTreeSha256);
  assert.equal(archiveEntry(firstZip, 'README.md').toString('utf8'), '# Fixture\n\nPortable release input.\n');
  assert.equal(archiveEntry(firstZip, 'LICENSE').toString('utf8'), 'Mozilla Public License Version 2.0\n');
});
