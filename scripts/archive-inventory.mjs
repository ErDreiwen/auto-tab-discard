import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = data => createHash('sha256').update(data).digest('hex');

const safeName = name => {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe archive entry path: ${JSON.stringify(name)}`);
  }
  return name;
};

const treeHash = entries => {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path, 'utf8');
    hash.update('\0');
    hash.update(entry.data);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const locateEnd = archive => {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('Archive has no ZIP end-of-central-directory record');
};

export const inspectArchive = async archivePath => {
  const archive = await readFile(archivePath);
  const endOffset = locateEnd(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const count = archive.readUInt16LE(endOffset + 10);
  if (disk !== 0 || centralDisk !== 0 || archive.readUInt16LE(endOffset + 8) !== count) {
    throw new Error('Multi-disk ZIP archives are forbidden');
  }
  let offset = archive.readUInt32LE(endOffset + 16);
  const centralBytes = archive.readUInt32LE(endOffset + 12);
  const centralEnd = offset + centralBytes;
  const seen = new Set();
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central-directory record ${index}`);
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedBytes = archive.readUInt32LE(offset + 20);
    const bytes = archive.readUInt32LE(offset + 24);
    const nameBytes = archive.readUInt16LE(offset + 28);
    const extraBytes = archive.readUInt16LE(offset + 30);
    const commentBytes = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = safeName(archive.subarray(offset + 46, offset + 46 + nameBytes).toString('utf8'));
    if (seen.has(name)) {
      throw new Error(`Duplicate archive entry: ${name}`);
    }
    seen.add(name);
    if (method !== 0 || compressedBytes !== bytes) {
      throw new Error(`Release archive entry must use the stored ZIP method: ${name}`);
    }
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid local ZIP header: ${name}`);
    }
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameBytes = archive.readUInt16LE(localOffset + 26);
    const localExtraBytes = archive.readUInt16LE(localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameBytes).toString('utf8');
    if (localMethod !== method || localName !== name) {
      throw new Error(`Central/local ZIP record mismatch: ${name}`);
    }
    const dataStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const data = archive.subarray(dataStart, dataStart + bytes);
    if (data.length !== bytes) {
      throw new Error(`Truncated ZIP entry: ${name}`);
    }
    entries.push({path: name, bytes, sha256: sha256(data), data: Buffer.from(data)});
    offset += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (offset !== centralEnd) {
    throw new Error('ZIP central-directory size does not match its records');
  }
  entries.sort((a, b) => binaryCompare(a.path, b.path));
  if (!seen.has('manifest.json') || entries.some(entry => entry.path.endsWith('/manifest.json') && entry.path !== 'manifest.json')) {
    throw new Error('Release archive must contain exactly one root manifest.json');
  }
  return {
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
    entries,
    inventory: entries.map(({path: entryPath, bytes: entryBytes, sha256: digest}) => ({
      path: entryPath,
      bytes: entryBytes,
      sha256: digest
    })),
    treeSha256: treeHash(entries)
  };
};

export const extractArchive = async (archivePath, destination) => {
  const inspected = await inspectArchive(archivePath);
  await mkdir(destination, {recursive: true});
  for (const entry of inspected.entries) {
    const target = path.resolve(destination, ...entry.path.split('/'));
    if (path.relative(path.resolve(destination), target).startsWith('..')) {
      throw new Error(`Archive entry escapes extraction root: ${entry.path}`);
    }
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, entry.data);
  }
  return inspected;
};

const directoryEntries = async (root, directory = '') => {
  const absolute = path.join(root, ...directory.split('/').filter(Boolean));
  const dirents = await readdir(absolute, {withFileTypes: true});
  dirents.sort((a, b) => binaryCompare(a.name, b.name));
  const entries = [];
  for (const dirent of dirents) {
    const relative = path.posix.join(directory, dirent.name);
    if (dirent.isSymbolicLink()) {
      throw new Error(`Extracted inventory contains a symbolic link: ${relative}`);
    }
    if (dirent.isDirectory()) {
      entries.push(...await directoryEntries(root, relative));
    }
    else if (dirent.isFile()) {
      const data = await readFile(path.join(root, ...relative.split('/')));
      entries.push({path: relative, bytes: data.length, sha256: sha256(data), data});
    }
  }
  return entries;
};

export const inspectDirectory = async root => {
  const entries = await directoryEntries(path.resolve(root));
  entries.sort((a, b) => binaryCompare(a.path, b.path));
  return {
    entries,
    inventory: entries.map(({path: entryPath, bytes, sha256: digest}) => ({path: entryPath, bytes, sha256: digest})),
    treeSha256: treeHash(entries)
  };
};

export const assertSameInventory = (expected, actual) => {
  if (JSON.stringify(expected.inventory) !== JSON.stringify(actual.inventory) ||
      expected.treeSha256 !== actual.treeSha256) {
    throw new Error('Extracted artifact inventory differs from the ZIP central-directory inventory');
  }
};
