#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';

import {assertReleaseContext} from './release-context.mjs';
import {deriveReleaseManifests} from './manifest-policy.mjs';

const ZIP_EPOCH = '1980-01-01T00:00:00.000Z';
const ZIP_DOS_DATE = 0x0021;
const ZIP_DOS_TIME = 0;
const UTF8_FLAG = 0x0800;
const REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;
const UTF8 = new TextDecoder('utf-8', {fatal: true});
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt'
]);
const TEXT_FILENAMES = new Set(['LICENSE']);

const binaryPathCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const sortedJson = value => Array.isArray(value) ? value.map(sortedJson) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value)
    .sort(binaryPathCompare)
    .map(key => [key, sortedJson(value[key])])) : value;

const normalizedJsonData = value => Buffer.from(`${JSON.stringify(sortedJson(value), null, 2)}\n`, 'utf8');

const crcTable = Array.from({length: 256}, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = data => {
  let value = 0xffffffff;
  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const normalizedEntryData = (name, data) => {
  const extension = path.posix.extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && !TEXT_FILENAMES.has(path.posix.basename(name))) {
    return data;
  }
  let text;
  try {
    text = UTF8.decode(data);
  }
  catch (error) {
    throw new Error(`Release text input is not valid UTF-8: ${name}`, {cause: error});
  }
  return Buffer.from(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), 'utf8');
};

const hashEntries = entries => {
  const hash = createHash('sha256');
  for (const {name, data} of entries) {
    hash.update(name, 'utf8');
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const excludedPath = relativePath => {
  const parts = relativePath.split('/');
  const name = parts.at(-1);
  return parts.some(part => part === '.git' || part === 'node_modules') ||
    relativePath === 'data/icons/convert.txt' ||
    (relativePath === 'data/icons/tmp' || relativePath.startsWith('data/icons/tmp/')) ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name.endsWith('~') ||
    name.endsWith('.bak') ||
    name.endsWith('.orig') ||
    name.endsWith('.rej');
};

const walk = async (root, directory = '') => {
  const absolute = path.join(root, directory);
  const dirents = await readdir(absolute, {withFileTypes: true});
  dirents.sort((a, b) => binaryPathCompare(a.name, b.name));
  const files = [];
  const excluded = [];

  for (const dirent of dirents) {
    const relativePath = path.posix.join(directory.split(path.sep).join('/'), dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new Error(`Release source contains a symbolic link: ${relativePath}`);
    }
    if (excludedPath(relativePath)) {
      excluded.push(relativePath);
      continue;
    }
    if (dirent.isDirectory()) {
      const nested = await walk(root, relativePath);
      files.push(...nested.files);
      excluded.push(...nested.excluded);
    }
    else if (dirent.isFile()) {
      files.push(relativePath);
    }
    else {
      throw new Error(`Release source contains an unsupported entry: ${relativePath}`);
    }
  }

  return {files, excluded};
};

const parseJson = (data, relativePath) => {
  try {
    return JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''));
  }
  catch (error) {
    throw new Error(`Invalid JSON in ${relativePath}: ${error.message}`, {cause: error});
  }
};

const resourcePath = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Manifest resource ${label} must be a non-empty string`);
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
    throw new Error(`Manifest resource ${label} must be local: ${value}`);
  }
  const normalized = value.replace(/^\/+/, '').replaceAll('\\', '/').split(/[?#]/, 1)[0];
  if (!normalized || normalized.split('/').some(part => part === '..')) {
    throw new Error(`Manifest resource ${label} escapes the extension root: ${value}`);
  }
  return normalized;
};

const globRegex = pattern => new RegExp(`^${pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replaceAll('**', '\u0000')
  .replaceAll('*', '[^/]*')
  .replaceAll('?', '[^/]')
  .replaceAll('\u0000', '.*')}$`);

const validateManifest = (manifest, availablePaths) => {
  const references = [];
  const add = (label, value) => {
    if (value === undefined) {
      return;
    }
    const resource = resourcePath(value, label);
    references.push({label, resource});
  };
  const addMany = (label, values) => {
    if (values === undefined) {
      return;
    }
    if (!Array.isArray(values)) {
      throw new Error(`Manifest resource list ${label} must be an array`);
    }
    values.forEach((value, index) => add(`${label}[${index}]`, value));
  };
  const addIcons = (label, icons) => {
    if (icons === undefined) {
      return;
    }
    if (typeof icons === 'string') {
      add(label, icons);
      return;
    }
    for (const [size, value] of Object.entries(icons)) {
      add(`${label}.${size}`, value);
    }
  };

  addIcons('icons', manifest.icons);
  add('storage.managed_schema', manifest.storage?.managed_schema);
  add('background.page', manifest.background?.page);
  add('background.service_worker', manifest.background?.service_worker);
  addMany('background.scripts', manifest.background?.scripts);
  for (const [index, script] of (manifest.content_scripts || []).entries()) {
    addMany(`content_scripts[${index}].js`, script.js);
    addMany(`content_scripts[${index}].css`, script.css);
  }
  for (const [label, action] of [
    ['action', manifest.action],
    ['browser_action', manifest.browser_action],
    ['page_action', manifest.page_action]
  ]) {
    add(`${label}.default_popup`, action?.default_popup);
    addIcons(`${label}.default_icon`, action?.default_icon);
  }
  add('options_page', manifest.options_page);
  add('options_ui.page', manifest.options_ui?.page);
  add('devtools_page', manifest.devtools_page);
  add('side_panel.default_path', manifest.side_panel?.default_path);
  add('sidebar_action.default_panel', manifest.sidebar_action?.default_panel);
  addIcons('sidebar_action.default_icon', manifest.sidebar_action?.default_icon);
  addMany('sandbox.pages', manifest.sandbox?.pages);
  for (const [name, value] of Object.entries(manifest.chrome_url_overrides || {})) {
    add(`chrome_url_overrides.${name}`, value);
  }
  for (const [name, value] of Object.entries(manifest.dictionaries || {})) {
    add(`dictionaries.${name}`, value);
  }
  for (const [index, module] of (manifest.nacl_modules || []).entries()) {
    add(`nacl_modules[${index}].path`, module.path);
  }
  for (const [name, value] of Object.entries(manifest.theme?.images || {})) {
    const values = Array.isArray(value) ? value : [value];
    values.forEach((item, index) => add(`theme.images.${name}[${index}]`, item));
  }
  const accessible = manifest.web_accessible_resources || [];
  if (manifest.manifest_version === 2) {
    addMany('web_accessible_resources', accessible);
  }
  else {
    for (const [index, entry] of accessible.entries()) {
      addMany(`web_accessible_resources[${index}].resources`, entry.resources);
    }
  }

  const files = new Set(availablePaths);
  for (const {label, resource} of references) {
    if (resource.includes('*') || resource.includes('?')) {
      const regex = globRegex(resource);
      if (!availablePaths.some(candidate => regex.test(candidate))) {
        throw new Error(`Manifest resource ${label} matches no packaged file: ${resource}`);
      }
    }
    else if (!files.has(resource)) {
      throw new Error(`Manifest resource ${label} is missing from the package: ${resource}`);
    }
  }

  if (manifest.default_locale) {
    const localePath = `_locales/${manifest.default_locale}/messages.json`;
    if (!files.has(localePath)) {
      throw new Error(`Manifest default_locale is missing ${localePath}`);
    }
  }

  return references.sort((a, b) => binaryPathCompare(a.label, b.label));
};

const targetEntries = (entries, manifest) => entries.map(entry => entry.name === 'manifest.json' ? {
  name: entry.name,
  data: normalizedJsonData(manifest)
} : entry);

const validateFirefoxBackgroundLoader = entries => {
  const byName = new Map(entries.map(entry => [entry.name, entry.data]));
  for (const required of ['firefox/background.html', 'firefox/compatibility.mjs', 'worker/core.mjs']) {
    if (!byName.has(required)) {
      throw new Error(`Firefox background loader dependency is missing from the package: ${required}`);
    }
  }
  const html = byName.get('firefox/background.html').toString('utf8');
  const compatibilityTag = '<script type="module" src="compatibility.mjs"></script>';
  const coreTag = '<script type="module" src="/worker/core.mjs"></script>';
  const compatibilityIndex = html.indexOf(compatibilityTag);
  const coreIndex = html.indexOf(coreTag);
  if (compatibilityIndex < 0 || coreIndex < 0 || compatibilityIndex >= coreIndex ||
      html.indexOf(compatibilityTag, compatibilityIndex + compatibilityTag.length) >= 0 ||
      html.indexOf(coreTag, coreIndex + coreTag.length) >= 0) {
    throw new Error('Firefox background page must load compatibility.mjs exactly once before worker/core.mjs');
  }
};

const assertManifestOnlyTargetDifference = (chromium, firefox) => {
  if (chromium.length !== firefox.length) {
    throw new Error('Chromium and Firefox package inventories must contain the same paths');
  }
  const differences = [];
  for (let index = 0; index < chromium.length; index += 1) {
    const left = chromium[index];
    const right = firefox[index];
    if (left.name !== right.name) {
      throw new Error('Chromium and Firefox package inventories must contain the same ordered paths');
    }
    if (!left.data.equals(right.data)) {
      differences.push(left.name);
    }
  }
  if (differences.length !== 1 || differences[0] !== 'manifest.json') {
    throw new Error(`Chromium and Firefox packages must differ only at manifest.json; received: ${differences.join(', ') || '(none)'}`);
  }
};

const collectMessageKeys = value => {
  const keys = new Set();
  const visit = item => {
    if (typeof item === 'string') {
      const match = /^__MSG_(.+)__$/.exec(item);
      if (match) {
        keys.add(match[1]);
      }
    }
    else if (Array.isArray(item)) {
      item.forEach(visit);
    }
    else if (item && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return [...keys].sort(binaryPathCompare);
};

const validateMessageCatalog = (messages, relativePath) => {
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
    throw new Error(`Locale catalog must be a JSON object: ${relativePath}`);
  }
  const keys = Object.keys(messages).sort(binaryPathCompare);
  for (const key of keys) {
    const entry = messages[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.message !== 'string' || entry.message.length === 0) {
      throw new Error(`Locale message must contain a non-empty string at ${relativePath}: ${key}`);
    }
  }
  return keys;
};

const validateLocales = (manifest, json, availablePaths) => {
  if (!manifest.default_locale) {
    return [];
  }
  const defaultPath = `_locales/${manifest.default_locale}/messages.json`;
  const defaultMessages = json.get(defaultPath);
  const defaultKeys = validateMessageCatalog(defaultMessages, defaultPath);
  for (const key of collectMessageKeys(manifest)) {
    if (!Object.hasOwn(defaultMessages, key)) {
      throw new Error(`Manifest localization key is missing from ${defaultPath}: ${key}`);
    }
  }

  const localePaths = availablePaths
    .filter(name => /^_locales\/[^/]+\/messages\.json$/.test(name))
    .sort(binaryPathCompare);
  for (const localePath of localePaths) {
    const messages = json.get(localePath);
    const keys = new Set(validateMessageCatalog(messages, localePath));
    const missing = defaultKeys.filter(key => !keys.has(key));
    if (missing.length) {
      throw new Error(`Locale catalog ${localePath} is missing default messages: ${missing.join(', ')}`);
    }
  }
  return localePaths;
};

const createZip = entries => {
  if (entries.length > 0xffff) {
    throw new Error('ZIP64 is not supported: too many release entries');
  }
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const {name, data} of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    if (data.length > 0xffffffff || localOffset > 0xffffffff) {
      throw new Error('ZIP64 is not supported: release is larger than 4 GiB');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(ZIP_DOS_TIME, 10);
    local.writeUInt16LE(ZIP_DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(ZIP_DOS_TIME, 12);
    central.writeUInt16LE(ZIP_DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(REGULAR_FILE_0644, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);

    localOffset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const sha256 = data => createHash('sha256').update(data).digest('hex');

export const packageRelease = async ({
  sourceRoot,
  outputDirectory,
  baseName,
  repositoryRoot: suppliedRepositoryRoot,
  releaseMode = true,
  testEvidence = []
} = {}) => {
  const repositoryRoot = path.resolve(suppliedRepositoryRoot ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  sourceRoot = path.resolve(sourceRoot || path.join(repositoryRoot, 'v3'));
  outputDirectory = path.resolve(outputDirectory || path.join(repositoryRoot, 'build', 'results'));

  const releaseContext = releaseMode ? await assertReleaseContext({repositoryRoot, sourceRoot}) : undefined;
  let releasePolicy;
  if (releaseMode) {
    releasePolicy = parseJson(await readFile(path.join(repositoryRoot, 'docs', 'release-policy.json')), 'docs/release-policy.json');
    if (!Array.isArray(testEvidence) || testEvidence.length === 0) {
      throw new Error('Release mode requires explicit passed test-evidence references');
    }
  }

  const {files, excluded} = await walk(sourceRoot);
  files.sort(binaryPathCompare);
  excluded.sort(binaryPathCompare);
  if (!files.includes('manifest.json')) {
    throw new Error(`Release source has no manifest.json: ${sourceRoot}`);
  }

  const inputs = new Map();
  for (const name of files) {
    inputs.set(name, await readFile(path.join(sourceRoot, ...name.split('/'))));
  }

  const rootFiles = [];
  if (sourceRoot === path.resolve(repositoryRoot, 'v3')) {
    const releaseRootInputs = [
      {name: 'FORK_NOTES.md', required: releaseMode, nonempty: releaseMode},
      {name: 'LICENSE', required: true},
      {name: 'README.md', required: true},
      {name: 'docs/MIGRATIONS.md', required: releaseMode, nonempty: releaseMode},
      {name: 'docs/PERMISSION_CHANGES.md', required: releaseMode, nonempty: releaseMode},
      {name: 'docs/RELEASE_PACKAGING.md', required: false},
      {name: 'docs/release-policy.json', required: false}
    ];
    for (const {name, required, nonempty = false} of releaseRootInputs) {
      const source = path.join(repositoryRoot, ...name.split('/'));
      let data;
      try {
        data = await readFile(source);
      }
      catch (error) {
        if (!required && error?.code === 'ENOENT') {
          continue;
        }
        throw new Error(`${required ? 'Required' : 'Configured'} release root file is unavailable: ${source}`, {
          cause: error
        });
      }
      const normalized = normalizedEntryData(name, data);
      if (nonempty && normalized.toString('utf8').trim().length === 0) {
        throw new Error(`Required release note is empty after normalization: ${name}`);
      }
      inputs.set(name, data);
      rootFiles.push(name);
    }
  }

  const entries = [...inputs]
    .map(([name, data]) => ({name, data: normalizedEntryData(name, data)}))
    .sort((a, b) => binaryPathCompare(a.name, b.name));
  const availablePaths = entries.map(entry => entry.name);
  const json = new Map();
  for (const {name, data} of entries) {
    if (name.endsWith('.json')) {
      json.set(name, parseJson(data, name));
    }
  }

  const manifest = json.get('manifest.json');
  const manifests = deriveReleaseManifests(manifest);
  const entriesByTarget = {
    chromium: targetEntries(entries, manifests.chromium),
    firefox: targetEntries(entries, manifests.firefox)
  };
  validateFirefoxBackgroundLoader(entries);
  assertManifestOnlyTargetDifference(entriesByTarget.chromium, entriesByTarget.firefox);
  const resources = {
    chromium: validateManifest(manifests.chromium, availablePaths),
    firefox: validateManifest(manifests.firefox, availablePaths)
  };
  const locales = validateLocales(manifests.chromium, json, availablePaths);
  const firefoxLocales = validateLocales(manifests.firefox, json, availablePaths);
  if (JSON.stringify(locales) !== JSON.stringify(firefoxLocales)) {
    throw new Error('Chromium and Firefox locale inventories differ');
  }

  baseName ||= `auto-tab-discard-${manifest.version}`;
  if (!/^[a-z\d][a-z\d._-]*$/i.test(baseName)) {
    throw new Error(`Unsafe release base name: ${baseName}`);
  }
  if (releaseMode) {
    if (manifest.name !== releasePolicy.releaseName) {
      throw new Error(`Release manifest name mismatch: expected ${releasePolicy.releaseName}, received ${manifest.name}`);
    }
    if (manifest.version !== releasePolicy.releaseVersion) {
      throw new Error(`Release manifest version mismatch: expected ${releasePolicy.releaseVersion}, received ${manifest.version}`);
    }
    if (baseName !== releasePolicy.archiveBaseName) {
      throw new Error(`Release archive name mismatch: expected ${releasePolicy.archiveBaseName}, received ${baseName}`);
    }
  }

  const normalizedEvidence = [];
  for (const [index, item] of [...testEvidence].entries()) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.path !== 'string' || !item.path ||
        !['passed', 'blocked'].includes(item.status)) {
      throw new Error(`Invalid test-evidence reference at index ${index}`);
    }
    if (path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) {
      throw new Error(`Test-evidence path must be repository-relative: ${item.path}`);
    }
    if (releaseMode && item.status !== 'passed') {
      throw new Error(`Release test evidence is not passed: ${item.id}`);
    }
    const evidencePath = item.path.replaceAll('\\', '/');
    const normalized = {id: item.id, path: evidencePath, status: item.status};
    if (releaseMode) {
      let evidenceData;
      try {
        evidenceData = await readFile(path.join(repositoryRoot, ...evidencePath.split('/')));
      }
      catch (error) {
        throw new Error(`Release test evidence is unavailable: ${evidencePath}`, {cause: error});
      }
      normalized.bytes = evidenceData.length;
      normalized.sha256 = sha256(evidenceData);
    }
    normalizedEvidence.push(normalized);
  }
  normalizedEvidence.sort((a, b) => binaryPathCompare(a.id, b.id));

  await mkdir(outputDirectory, {recursive: true});
  const targetFiles = {
    chromium: `${baseName}.zip`,
    firefox: `${baseName}.xpi`
  };
  const artifacts = {};
  for (const target of ['chromium', 'firefox']) {
    const targetEntryList = entriesByTarget[target];
    const archive = createZip(targetEntryList);
    const file = targetFiles[target];
    await writeFile(path.join(outputDirectory, file), archive);
    artifacts[target] = {
      file,
      bytes: archive.length,
      sha256: sha256(archive),
      treeSha256: hashEntries(targetEntryList),
      entryCount: targetEntryList.length,
      inventory: targetEntryList.map(entry => ({
        path: entry.name,
        bytes: entry.data.length,
        sha256: sha256(entry.data)
      }))
    };
  }
  const archives = Object.entries(artifacts).map(([target, artifact]) => ({target, ...artifact}));
  const provenanceNotePaths = [
    'FORK_NOTES.md',
    'docs/MIGRATIONS.md',
    'docs/PERMISSION_CHANGES.md'
  ];
  const provenanceNotes = Object.fromEntries(provenanceNotePaths.map(notePath => {
    const note = entries.find(entry => entry.name === notePath);
    return [notePath, note ? {bytes: note.data.length, sha256: sha256(note.data)} : null];
  }));
  const releaseNotes = entries.find(entry => entry.name === 'FORK_NOTES.md');
  const metadata = {
    formatVersion: 4,
    source: path.basename(sourceRoot),
    extensionVersion: manifest.version,
    zipEpoch: ZIP_EPOCH,
    localeCount: locales.length,
    rootFiles,
    provenance: releaseMode ? {
      commitSha: releaseContext.commitSha,
      gitTree: releaseContext.gitTree,
      notes: provenanceNotes,
      releaseNotes: releaseNotes ? {path: 'FORK_NOTES.md', sha256: sha256(releaseNotes.data)} : null
    } : {
      mode: 'programmatic-fixture'
    },
    testEvidence: normalizedEvidence,
    artifacts
  };
  const metadataPath = path.join(outputDirectory, 'checksums.json');
  const sumsPath = path.join(outputDirectory, 'SHA256SUMS');
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeFile(sumsPath, `${[...archives]
    .sort((a, b) => binaryPathCompare(a.file, b.file))
    .map(item => `${item.sha256}  ${item.file}`).join('\n')}\n`, 'utf8');

  return {
    archives,
    artifacts,
    entries: Object.fromEntries(Object.entries(entriesByTarget)
      .map(([target, targetEntryList]) => [target, targetEntryList.map(entry => entry.name)])),
    excluded,
    locales,
    manifest,
    manifests,
    metadata,
    metadataPath,
    outputDirectory,
    resources,
    releaseContext,
    rootFiles,
    sumsPath
  };
};

const parseArguments = arguments_ => {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!['--source', '--output', '--base-name', '--evidence'].includes(name) || !value) {
      throw new Error(`Usage: node scripts/package-release.mjs [--source v3] [--output build/results] [--base-name NAME] --evidence FILE`);
    }
    options[name] = value;
    index += 1;
  }
  return {
    sourceRoot: options['--source'],
    outputDirectory: options['--output'],
    baseName: options['--base-name'],
    evidencePath: options['--evidence']
  };
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  const evidencePath = parsed.evidencePath;
  delete parsed.evidencePath;
  Promise.resolve().then(async () => {
    if (!evidencePath) {
      throw new Error('Release packaging requires --evidence FILE; use scripts/release-gate.mjs for the complete gate');
    }
    parsed.testEvidence = parseJson(await readFile(path.resolve(evidencePath)), evidencePath);
    return packageRelease(parsed);
  }).then(result => {
    for (const archive of result.archives) {
      process.stdout.write(`${archive.sha256}  ${path.join(result.outputDirectory, archive.file)}\n`);
    }
    process.stdout.write(`Validated ${result.entries.chromium.length} Chromium files and ${result.entries.firefox.length} Firefox files, and wrote ${result.metadataPath}\n`);
  }).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
