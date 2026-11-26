#!/usr/bin/env node
// The launch gate of one sales-stable candidate: drives the stable environment the way staff, customers, the ERP and
// an external MCP client use it, and writes one evidence document bound to the tag, its tag object and commit, the
// config bytes and the installed artifact manifest.
//
//   STABLE_VERIFICATION_FILE=PRIVATE_MANIFEST ZEROPS_TOKEN=… node ops/zerops-stable/verify.mjs --config CONFIG \
//     --output EVIDENCE --tag sales-stable/YYYY-MM-DD[-N] --access public|maintenance-allowlist \
//     --artifact-manifest RELEASE_ARTIFACTS/manifest.json --backup BACKUP_DIR \
//     --migration-evidence REHEARSAL_JSON --walkthrough-evidence WALKTHROUGH_JSON [--phase candidate|deployed]
//
// The commit is the tag's, proven by release.mjs, never a value the caller passes; deployed-build then proves the
// stable services run exactly that commit. Every check in REQUIRED_CHECK_IDS runs or fails: a missing manifest,
// evidence file or journey input is a failed check, never a skipped one. The ERP, e-mail and MCP journeys write; they
// run only against the targets the manifest opts in to, and only once deployed-build passed. The journeys use the
// public origins of the config: during maintenance only the verifier IPs of the edge.mjs WAF rule reach them
// (--access maintenance-allowlist), and an unreachable origin fails its checks. The evidence is written whatever the
// outcome; the exit code is 0 only when every check passed, 2 when nothing could be bound. Needs the app workspace
// installed (app/): the journeys run its proofs and reuse its contracts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadStableConfig } from './config.mjs';
import { ARTIFACTS_KIND } from './deploy.mjs';
import { readActiveVersions, sha256File } from './deploy-evidence.mjs';
import { configFileDigest, inspectDeployableRelease } from './release.mjs';
import { migrationRehearsalCheck, salesWalkthroughCheck } from './verify-evidence.mjs';
import { createHttp, createRedactor, spawnProcess } from './verify-http.mjs';
import {
  controlEmail,
  customerLogin,
  deployedBuild,
  erpSyntheticImport,
  mcpOAuth,
  staffSalesLogin,
  storefrontHome,
  tenantSwitching,
} from './verify-journeys.mjs';
import { loadVerificationManifest, manifestSecrets } from './verify-manifest.mjs';

export const EVIDENCE_KIND = 'ontos.stable.verification-evidence';
export const PHASES = Object.freeze(['candidate', 'deployed']);
/**
 * How this run reached the stable origins, recorded in the evidence. `public`: the edge is open to everyone.
 * `maintenance-allowlist`: the maintenance WAF rule (edge.mjs) blocks the origins for everyone but the verifier IPs,
 * and this run comes from one of them. verify.mjs opens nothing itself; an unreachable origin fails its checks.
 */
export const ACCESS_MODES = Object.freeze(['public', 'maintenance-allowlist']);
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_ROOT = path.join(REPO_ROOT, 'app');

/** Journeys that write; they run only against opted-in targets and only on the proven candidate build. */
const MUTATING = new Set(['erp-synthetic-import', 'control-email', 'mcp-oauth']);
/** Journeys that need the manifest. */
const NEEDS_MANIFEST = new Set([
  'staff-sales-login',
  'tenant-switching',
  'customer-login',
  'erp-synthetic-import',
  'control-email',
  'mcp-oauth',
]);

const JOURNEYS = [
  ['deployed-build', deployedBuild],
  ['staff-sales-login', staffSalesLogin],
  ['tenant-switching', tenantSwitching],
  ['storefront-home:storefront', storefrontHome('storefront')],
  ['storefront-home:shop', storefrontHome('shop')],
  ['storefront-home:n1', storefrontHome('n1')],
  ['customer-login', customerLogin],
  ['erp-synthetic-import', erpSyntheticImport],
  ['control-email', controlEmail],
  ['mcp-oauth', mcpOAuth],
  ['migration-rehearsal', (check, context) => migrationRehearsalCheck(check, { ...context, path: context.migrationEvidencePath })],
  ['sales-walkthrough', (check, context) => salesWalkthroughCheck(check, { now: context.now(), path: context.walkthroughEvidencePath, release: context.release })],
];

/** Every check a passing verification contains, in evidence order. A deploy gate requires each to be `passed`. */
export const REQUIRED_CHECK_IDS = Object.freeze(['verification-manifest', ...JOURNEYS.map(([id]) => id)]);

class CheckStopped extends Error {}

/** Runs one check in isolation: a throw fails this check only, and a check that asserted nothing fails. */
const runCheck = async (id, body, { now, redact }) => {
  const startedAt = now().toISOString();
  const assertions = [];
  const failures = [];
  const check = {
    expect(condition, passed, failed) {
      (condition ? assertions : failures).push(condition ? passed : failed);
      return condition;
    },
    fail(message) {
      failures.push(message);
    },
    pass(message) {
      assertions.push(message);
    },
    require(condition, failed) {
      if (!condition) throw new CheckStopped(failed);
    },
  };
  try {
    await body(check);
  } catch (error) {
    failures.push(error instanceof CheckStopped ? error.message : `stopped: ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
  }
  if (assertions.length === 0 && failures.length === 0) failures.push('the check asserted nothing');
  return {
    assertions: assertions.map(redact),
    failures: failures.map(redact),
    finishedAt: now().toISOString(),
    id,
    startedAt,
    status: failures.length === 0 ? 'passed' : 'failed',
  };
};

const notRun = (id, reason, now) => {
  const at = now().toISOString();
  return { assertions: [], failures: [`not run: ${reason}`], finishedAt: at, id, startedAt: at, status: 'failed' };
};

/** The app's own rules and contracts the journeys reuse, loaded from the installed app workspace. */
export const loadAppModules = async (appRoot = APP_ROOT) => {
  const load = (file) => import(pathToFileURL(path.join(appRoot, file)).href);
  const [verify, recipients] = await Promise.all([
    load('scripts/ops/stage-demo-verify.mjs'),
    load('packages/email-delivery/src/dispatcher/recipients.ts'),
  ]);
  return {
    isTestRecipient: recipients.isTestRecipient,
    judgeStorefrontHome: verify.storefrontHomeProblems,
    resolvePlaywright: () =>
      createRequire(path.join(appRoot, 'apps/shell-super-app/package.json')).resolve('@playwright/test'),
  };
};

/**
 * The installed release artifacts (deploy.mjs): their manifest must name this tag, tag object, commit, config and
 * project. Its digest goes into the evidence, which binds the verification to exactly what was installed.
 */
const bindArtifacts = async (file, { config, configDigest, release }) => {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`artifact manifest ${file} is not readable JSON (${error.code ?? error.name})`);
  }
  const expected = { kind: ARTIFACTS_KIND, schemaVersion: 1, tag: release.tag, tagObject: release.tagObject, commit: release.commit, configDigest, projectId: config.projectId };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest?.[key] !== value) throw new Error(`the artifact manifest ${key} is ${String(manifest?.[key])}, not ${String(value)}`);
  }
  return sha256File(file);
};

/**
 * One verification run. Throws only when it cannot bind anything (an invalid config or tag); every other problem is
 * a failed check in the returned evidence.
 */
export const runVerification = async ({
  configPath,
  manifestPath,
  tag,
  phase = 'candidate',
  access,
  artifactManifestPath,
  backupDirectory,
  migrationEvidencePath,
  walkthroughEvidencePath,
  repoRoot = REPO_ROOT,
  appRoot = APP_ROOT,
  zeropsToken,
  fetchImpl = fetch,
  runProcess = spawnProcess,
  inspectRelease = inspectDeployableRelease,
  appModules,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  inboxTimeoutMs = 3 * 60_000,
  inboxPollMs = 5000,
}) => {
  if (!PHASES.includes(phase)) throw new Error(`--phase must be one of ${PHASES.join(', ')}`);
  if (!ACCESS_MODES.includes(access)) throw new Error(`--access must be one of ${ACCESS_MODES.join(', ')}`);
  const startedAt = now().toISOString();
  const config = await loadStableConfig(configPath);
  const configDigest = configFileDigest(configPath);
  const release = inspectRelease({ cwd: repoRoot, tag });
  const manifestDigest = await bindArtifacts(artifactManifestPath, { config, configDigest, release });
  const redactor = createRedactor(zeropsToken === undefined ? [] : [zeropsToken]);
  const app = appModules ?? (await loadAppModules(appRoot));

  const checks = [];
  let manifest;
  checks.push(
    await runCheck(
      'verification-manifest',
      async (check) => {
        manifest = await loadVerificationManifest(manifestPath, config, app);
        for (const secret of manifestSecrets(manifest)) redactor.add(secret);
        check.pass(`the manifest opts in to ${Object.keys(manifest.mutations).join(', ')} on their exact targets`);
      },
      { now, redact: redactor.redact },
    ),
  );

  const context = {
    ...app,
    appRoot,
    config,
    http: createHttp(fetchImpl),
    inboxPollMs,
    inboxTimeoutMs,
    manifest,
    backupDirectory,
    migrationEvidencePath,
    now,
    redactor,
    release,
    runProcess,
    sleep,
    walkthroughEvidencePath,
    readVersions: () => readActiveVersions(config, { fetchImpl, token: zeropsToken }),
  };
  for (const [id, journey] of JOURNEYS) {
    const buildFailed = checks.find((entry) => entry.id === 'deployed-build')?.status !== 'passed';
    if (NEEDS_MANIFEST.has(id) && manifest === undefined) {
      checks.push(notRun(id, 'the verification manifest is missing or invalid', now));
    } else if (MUTATING.has(id) && buildFailed) {
      checks.push(notRun(id, 'the stable services do not serve the candidate commit; no write runs against them', now));
    } else {
      checks.push(await runCheck(id, (check) => journey(check, context), { now, redact: redactor.redact }));
    }
  }

  return {
    schemaVersion: 1,
    kind: EVIDENCE_KIND,
    phase,
    tag: release.tag,
    tagObject: release.tagObject,
    commit: release.commit,
    configDigest,
    manifestDigest,
    projectId: config.projectId,
    origins: config.origins,
    access,
    startedAt,
    finishedAt: now().toISOString(),
    status: checks.every((entry) => entry.status === 'passed') ? 'passed' : 'failed',
    checks,
  };
};

const USAGE =
  'usage: verify.mjs --config CONFIG --output EVIDENCE --tag sales-stable/YYYY-MM-DD[-N] --access public|maintenance-allowlist ' +
  '--artifact-manifest RELEASE_ARTIFACTS/manifest.json --backup BACKUP_DIR --migration-evidence REHEARSAL_JSON ' +
  '--walkthrough-evidence WALKTHROUGH_JSON [--phase candidate|deployed]  (env: STABLE_VERIFICATION_FILE, ZEROPS_TOKEN)';

export const parseCli = (argv) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      access: { type: 'string' },
      'artifact-manifest': { type: 'string' },
      backup: { type: 'string' },
      config: { type: 'string' },
      'migration-evidence': { type: 'string' },
      output: { type: 'string' },
      phase: { type: 'string', default: 'candidate' },
      tag: { type: 'string' },
      'walkthrough-evidence': { type: 'string' },
    },
    strict: true,
  });
  const bound = values.config && values.output && values.tag && values['artifact-manifest'];
  if (!bound || !PHASES.includes(values.phase) || !ACCESS_MODES.includes(values.access)) throw new Error(USAGE);
  return values;
};

export const main = async (argv, env = process.env) => {
  const values = parseCli(argv);
  const evidence = await runVerification({
    access: values.access,
    artifactManifestPath: values['artifact-manifest'],
    backupDirectory: values.backup,
    configPath: values.config,
    manifestPath: env.STABLE_VERIFICATION_FILE,
    migrationEvidencePath: values['migration-evidence'],
    phase: values.phase,
    tag: values.tag,
    walkthroughEvidencePath: values['walkthrough-evidence'],
    zeropsToken: env.ZEROPS_TOKEN,
  });
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  for (const check of evidence.checks) {
    process.stdout.write(`${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.id}${check.failures.length > 0 ? `: ${check.failures.join('; ')}` : ''}\n`);
  }
  process.stdout.write(`stable verification ${evidence.status.toUpperCase()} ${evidence.tag} ${evidence.commit} -> ${values.output}\n`);
  return evidence.status === 'passed' ? 0 : 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`Stable verification: ${error.message}\n`);
      process.exitCode = 2;
    },
  );
}
