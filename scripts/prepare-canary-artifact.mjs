#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {writeBuilderProvenance} from './cross-builder-provenance.mjs';
import {packageRelease} from './package-release.mjs';
import {assertReleaseContext} from './release-context.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arguments_ = process.argv.slice(2);
const options = {};
for (let index = 0; index < arguments_.length; index += 2) {
  const name = arguments_[index];
  const value = arguments_[index + 1];
  if (!['--output', '--builder-id', '--runner-os', '--runner-image'].includes(name) ||
      !value || Object.hasOwn(options, name)) {
    throw new Error('Usage: node scripts/prepare-canary-artifact.mjs --output DIRECTORY --builder-id ID --runner-os OS --runner-image IMAGE');
  }
  options[name] = value;
}
if (Object.keys(options).length !== 4) {
  throw new Error('Usage: node scripts/prepare-canary-artifact.mjs --output DIRECTORY --builder-id ID --runner-os OS --runner-image IMAGE');
}

const sourceRoot = path.join(repositoryRoot, 'v3');
// This assertion runs inside each isolated builder before source bytes are
// collected. It records the actual checked-out commit/tree and rejects dirty,
// nested, transitional, symlinked, or forbidden release inputs.
const releaseContext = await assertReleaseContext({repositoryRoot, sourceRoot});
const outputDirectory = path.resolve(options['--output']);

const result = await packageRelease({
  baseName: 'auto-tab-discard-canary',
  outputDirectory,
  releaseMode: false,
  repositoryRoot,
  sourceRoot
});
const provenancePath = path.join(outputDirectory, 'builder-provenance.json');
const provenance = await writeBuilderProvenance({
  artifactPath: result.metadataPath,
  builderId: options['--builder-id'],
  commitSha: releaseContext.commitSha,
  gitTree: releaseContext.gitTree,
  output: provenancePath,
  runnerImage: options['--runner-image'],
  runnerOs: options['--runner-os']
});

process.stdout.write(`${JSON.stringify({
  archive: result.archives.find(item => item.file.endsWith('.zip')),
  builder: provenance.builder,
  extensionVersion: result.metadata.extensionVersion,
  metadataPath: result.metadataPath,
  provenancePath,
  sourceTreeSha256: result.metadata.sourceTreeSha256
}, null, 2)}\n`);
