// The gates of a stable release. deploy.mjs installs behind the closed edge after the release window, the data.mjs
// backup and migration rehearsal, and a read-only read of each workload's active app version. maintenance.mjs leave
// reopens only through assertReopenEvidence: complete passed verify.mjs evidence of the release every workload runs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertRehearsalEvidence, backupManifestDigest, readRehearsalEvidence, verifyBackup } from './data.mjs';
import { ZEROPS_PUBLIC_API_URL } from './maintenance.mjs';
import { DEFAULT_DEMO_REF, DEFAULT_REMOTE, configFileDigest, inspectDeployableRelease, pragueDay } from './release.mjs';

export class GateError extends Error {
  name = 'GateError';
}

export const DEPLOYED_WORKLOADS = Object.freeze(['app', 'storefront', 'shop', 'n1']);
export const BACKUP_MAX_AGE_HOURS = 12;

const fail = (message) => {
  throw new GateError(message);
};

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`${what} ${path} is not readable JSON (${error.code ?? error.name})`);
  }
};

/** Saturday and Sunday in Prague are release days; any other day needs the emergency reason, which is recorded. */
export function assertReleaseWindow(now, emergencyReason) {
  const { weekday, date } = pragueDay(now);
  const reason = typeof emergencyReason === 'string' ? emergencyReason.trim() : '';
  if (weekday === 'Sat' || weekday === 'Sun') return { weekday, date, emergencyReason: reason || null };
  if (!reason) fail(`${weekday} ${date} in Prague is not a release day; a weekday deploy needs --emergency-reason`);
  return { weekday, date, emergencyReason: reason };
}

/**
 * An update's data prerequisites, through data.mjs: a verified backup of this project taken from the release that
 * runs now and in the last BACKUP_MAX_AGE_HOURS, and a passed migration rehearsal of exactly this tag and commit on
 * that backup.
 */
export async function assertInstallData({ backupDirectory, rehearsalPath, config, release, runningRevision, now }) {
  const backup = await verifyBackup(backupDirectory, { projectId: config.projectId });
  if (backup.sourceRevision !== runningRevision) {
    fail(`the backup was taken from ${backup.sourceRevision}; the app runs ${runningRevision}`);
  }
  const age = now.getTime() - Date.parse(backup.createdAt);
  if (!(age >= 0 && age <= BACKUP_MAX_AGE_HOURS * 3_600_000)) {
    fail(`the backup was created ${backup.createdAt}; an update needs one from the last ${BACKUP_MAX_AGE_HOURS} hours`);
  }
  const backupManifestSha256 = await backupManifestDigest(backupDirectory);
  const rehearsal = assertRehearsalEvidence(await readRehearsalEvidence(rehearsalPath), {
    config,
    backupManifestSha256,
    tag: release.tag,
    commit: release.commit,
  });
  return { backupCreatedAt: backup.createdAt, backupManifestSha256, rehearsalFinishedAt: rehearsal.finishedAt };
}

/** The name of each workload's active app version (null when the service never deployed), read-only. */
export async function readActiveVersions(config, { token, fetchImpl = fetch, apiUrl = ZEROPS_PUBLIC_API_URL }) {
  if (typeof token !== 'string' || token === '') fail('ZEROPS_TOKEN is required');
  const versions = {};
  for (const name of DEPLOYED_WORKLOADS) {
    const id = config.services[name];
    const response = await fetchImpl(`${apiUrl}/service-stack/${encodeURIComponent(id)}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) fail(`Zerops service read of ${name} failed: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.id !== id || body.projectId !== config.projectId) fail(`Zerops returned another service for ${name}`);
    const version = body.activeAppVersion ?? null;
    versions[name] = version === null ? null : String(version.name ?? '');
  }
  return versions;
}

/**
 * What an install of <commit> is, from the live active app versions:
 *   bootstrap-app     no app version was ever active: no migration ran and no customer data exists. Only the app
 *                     deploys (--bootstrap-app), so the live app can issue the storefront keys and seed the accounts.
 *   bootstrap-fronts  the app runs <commit> and no front ever deployed: the fronts deploy, the app is not touched.
 *   update            anything else: every workload deploys, after a backup and a migration rehearsal of <commit>.
 */
export function installKind(versions, commit) {
  if (versions.app === null) return 'bootstrap-app';
  const fronts = DEPLOYED_WORKLOADS.filter((name) => name !== 'app');
  if (versions.app === commit && fronts.every((name) => versions[name] === null)) return 'bootstrap-fronts';
  return 'update';
}

/** The workloads an install of each kind deploys. */
export const INSTALLED_WORKLOADS = Object.freeze({
  'bootstrap-app': Object.freeze(['app']),
  'bootstrap-fronts': Object.freeze(DEPLOYED_WORKLOADS.filter((name) => name !== 'app')),
  update: DEPLOYED_WORKLOADS,
});

/** How old verification evidence may be when the project reopens: one weekend (Saturday tests, Sunday reopen). */
export const REOPEN_EVIDENCE_MAX_AGE_HOURS = 48;

export const EVIDENCE_KIND = 'ontos.stable.verification-evidence';
const EVIDENCE_PHASES = ['candidate', 'deployed'];

/**
 * Complete passed verification evidence (verify.mjs) of one release: every check of <requiredCheckIds> present once
 * and passed and no other, bound to the tag, tag object, commit, config digest and project of <expected>.
 */
export function assertVerificationEvidence(evidence, expected, requiredCheckIds) {
  if (evidence?.kind !== EVIDENCE_KIND || evidence.schemaVersion !== 1) fail(`the evidence is not ${EVIDENCE_KIND} schemaVersion 1`);
  if (!EVIDENCE_PHASES.includes(evidence.phase)) fail(`the evidence phase is ${evidence.phase}`);
  for (const key of ['tag', 'tagObject', 'commit', 'configDigest', 'projectId']) {
    if (evidence[key] !== expected[key]) fail(`the evidence ${key} is ${evidence[key]}, not ${expected[key]}`);
  }
  if (!/^[\da-f]{64}$/u.test(String(evidence.manifestDigest))) fail('the evidence names no artifact manifest');
  if (!Array.isArray(requiredCheckIds) || requiredCheckIds.length === 0) fail('no required check ids are defined');
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const ids = checks.map((check) => check?.id);
  if (new Set(ids).size !== ids.length) fail('an evidence check appears twice');
  const missing = requiredCheckIds.filter((id) => !ids.includes(id));
  const unknown = ids.filter((id) => !requiredCheckIds.includes(id));
  const failed = checks.filter((check) => check.status !== 'passed').map((check) => `${check.id} (${check.status})`);
  if (missing.length > 0) fail(`the evidence lacks checks: ${missing.join(', ')}`);
  if (unknown.length > 0) fail(`the evidence has unknown checks: ${unknown.join(', ')}`);
  if (failed.length > 0) fail(`evidence checks did not pass: ${failed.join(', ')}`);
  if (evidence.status !== 'passed') fail(`the evidence status is ${evidence.status}, not passed`);
  return { checks: ids.length };
}

/**
 * maintenance.mjs leave's gate, assertReopenEvidence(evidence, { config, configPath, status, client }): the evidence
 * passes assertVerificationEvidence against verify.mjs's REQUIRED_CHECK_IDS, for the config file at <configPath>, of
 * the tag as it is now (published, unmoved, on the demo line), finished within REOPEN_EVIDENCE_MAX_AGE_HOURS, and every
 * workload runs its commit now (read with ZEROPS_TOKEN). `status` and `client` are maintenance.mjs's; unused here.
 */
export async function assertReopenEvidence(
  evidence,
  {
    config,
    configPath,
    token = process.env.ZEROPS_TOKEN,
    fetchImpl = fetch,
    now = new Date(),
    repoRoot = fileURLToPath(new URL('../..', import.meta.url)),
    demoRef = DEFAULT_DEMO_REF,
    remote = DEFAULT_REMOTE,
  },
) {
  if (typeof configPath !== 'string') fail('the reopen gate needs the config path its evidence digest binds');
  const { REQUIRED_CHECK_IDS } = await import('./verify.mjs');
  const release = inspectDeployableRelease({ cwd: repoRoot, tag: evidence?.tag, demoRef, remote });
  const { checks } = assertVerificationEvidence(
    evidence,
    { tag: release.tag, tagObject: release.tagObject, commit: release.commit, configDigest: configFileDigest(configPath), projectId: config.projectId },
    REQUIRED_CHECK_IDS,
  );
  const age = now.getTime() - Date.parse(evidence.finishedAt);
  if (!(age >= 0 && age <= REOPEN_EVIDENCE_MAX_AGE_HOURS * 3_600_000)) {
    fail(`the evidence finished ${evidence.finishedAt}; reopening needs evidence from the last ${REOPEN_EVIDENCE_MAX_AGE_HOURS} hours`);
  }
  const versions = await readActiveVersions(config, { token, fetchImpl });
  const stale = DEPLOYED_WORKLOADS.filter((name) => versions[name] !== release.commit);
  if (stale.length > 0) fail(`not every workload runs ${release.commit}: ${stale.map((name) => `${name}=${versions[name]}`).join(', ')}`);
  return { tag: release.tag, commit: release.commit, checks };
}
