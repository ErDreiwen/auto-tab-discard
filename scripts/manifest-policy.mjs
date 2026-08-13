import {readFile} from 'node:fs/promises';
import path from 'node:path';

const binaryCompare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedUnique = values => [...new Set(values || [])].sort(binaryCompare);
const difference = (left, right) => left.filter(item => !right.includes(item));

const localExtensionPath = value => typeof value === 'string' &&
  !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) &&
  !value.split(/[?#]/, 1)[0].split('/').includes('..');

export const createPermissionChangeReport = (manifest, baseline) => {
  const currentPermissions = sortedUnique(manifest.permissions);
  const currentHostPermissions = sortedUnique(manifest.host_permissions);
  const baselinePermissions = sortedUnique(baseline.permissions);
  const baselineHostPermissions = sortedUnique(baseline.hostPermissions);
  return {
    baselineVersion: baseline.version,
    releaseVersion: manifest.version,
    permissions: {
      added: difference(currentPermissions, baselinePermissions),
      removed: difference(baselinePermissions, currentPermissions),
      current: currentPermissions
    },
    hostPermissions: {
      added: difference(currentHostPermissions, baselineHostPermissions),
      removed: difference(baselineHostPermissions, currentHostPermissions),
      current: currentHostPermissions
    }
  };
};

const findRemoteCode = (value, keyPath = '') => {
  const findings = [];
  if (typeof value === 'string') {
    if (/^(?:https?:)?\/\//i.test(value) && /(?:script|worker|background|content_security_policy)/i.test(keyPath)) {
      findings.push(`${keyPath}: ${value}`);
    }
  }
  else if (Array.isArray(value)) {
    value.forEach((item, index) => findings.push(...findRemoteCode(item, `${keyPath}[${index}]`)));
  }
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      findings.push(...findRemoteCode(item, keyPath ? `${keyPath}.${key}` : key));
    }
  }
  return findings;
};

export const lintManifestPolicy = ({manifest, baseline, policy}) => {
  const errors = [];
  const blockers = [];
  if (manifest.manifest_version !== 3) {
    errors.push('manifest_version must be 3');
  }
  if (manifest.name !== policy.releaseName) {
    errors.push(`manifest name mismatch: expected ${policy.releaseName}, received ${manifest.name}`);
  }
  if (manifest.version !== policy.releaseVersion) {
    errors.push(`manifest version mismatch: expected ${policy.releaseVersion}, received ${manifest.version}`);
  }
  for (const key of policy.forbiddenManifestKeys) {
    if (Object.hasOwn(manifest, key)) {
      errors.push(`forbidden manifest key: ${key}`);
    }
  }
  const permissionReport = createPermissionChangeReport(manifest, baseline);
  const disallowedPermissions = difference(permissionReport.permissions.current, sortedUnique(policy.allowedPermissions));
  const disallowedHosts = difference(permissionReport.hostPermissions.current, sortedUnique(policy.allowedHostPermissions));
  if (disallowedPermissions.length) {
    errors.push(`permissions exceed release policy: ${disallowedPermissions.join(', ')}`);
  }
  if (disallowedHosts.length) {
    errors.push(`host_permissions exceed release policy: ${disallowedHosts.join(', ')}`);
  }
  if (!localExtensionPath(manifest.background?.service_worker) || manifest.background?.type !== 'module') {
    errors.push('background.service_worker must be a local ES module');
  }
  if (manifest.background?.page !== undefined && !localExtensionPath(manifest.background.page)) {
    errors.push('background.page must be local when present');
  }
  if (findRemoteCode(manifest).length) {
    errors.push(`manifest references remote executable code: ${findRemoteCode(manifest).join(', ')}`);
  }
  const collection = sortedUnique(manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required);
  if (collection.length !== 1 || collection[0] !== 'none') {
    errors.push('Firefox data_collection_permissions.required must explicitly be ["none"]');
  }
  if (!policy.independentSubmissionReady) {
    blockers.push('independent store submission is disabled by release policy');
  }
  if (manifest.browser_specific_settings?.gecko?.id === policy.upstreamGeckoId) {
    blockers.push('manifest still uses the upstream Gecko ID');
  }
  if (manifest.browser_specific_settings?.gecko?.id !== policy.forkGeckoId) {
    blockers.push('manifest does not use the release policy fork Gecko ID');
  }
  if (manifest.homepage_url !== policy.forkHomepage) {
    blockers.push('manifest does not use the release policy fork homepage');
  }
  return {
    blockers: sortedUnique(blockers),
    errors: sortedUnique(errors),
    independentSubmissionReady: blockers.length === 0,
    permissionReport
  };
};

export const loadAndLintManifestPolicy = async repositoryRoot => {
  const readJson = async relative => JSON.parse(await readFile(path.join(repositoryRoot, ...relative.split('/')), 'utf8'));
  const policy = await readJson('docs/release-policy.json');
  const manifest = await readJson('v3/manifest.json');
  const baseline = await readJson(policy.baselineManifest);
  return {baseline, manifest, policy, report: lintManifestPolicy({manifest, baseline, policy})};
};
