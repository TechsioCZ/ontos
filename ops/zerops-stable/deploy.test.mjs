import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { loadStableConfig } from './config.mjs';
import { assertReleaseWindow, assertReopenEvidence, installKind } from './deploy-evidence.mjs';
import { enterMaintenance } from './maintenance.mjs';
import { createFakeGate } from './maintenance-fixture.mjs';
import { executeInstall, materializeRelease, planInstall, stageArtifacts, verifyArtifacts } from './deploy.mjs';
import { configFileDigest, inspectRelease } from './release.mjs';

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const temp = (name) => {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
};
const run = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const saturday = new Date('2026-11-28T09:00:00Z');
const COMMIT = 'a'.repeat(40);

test('Saturday and Sunday in Prague are release days; a weekday needs an emergency reason', () => {
  assert.equal(assertReleaseWindow(saturday).weekday, 'Sat');
  assert.equal(assertReleaseWindow(new Date('2026-11-27T23:30:00Z')).weekday, 'Sat');
  assert.throws(() => assertReleaseWindow(new Date('2026-11-25T12:00:00Z'), '  '), /emergency-reason/u);
  assert.equal(assertReleaseWindow(new Date('2026-11-25T12:00:00Z'), 'orders fail').emergencyReason, 'orders fail');
});

test('the live app versions decide what an install deploys', () => {
  const none = { app: null, storefront: null, shop: null, n1: null };
  assert.equal(installKind({ ...none, storefront: COMMIT }, COMMIT), 'bootstrap-app');
  assert.equal(installKind({ ...none, app: COMMIT }, COMMIT), 'bootstrap-fronts');
  assert.equal(installKind({ ...none, app: 'e'.repeat(40) }, COMMIT), 'update');
  assert.equal(installKind({ ...none, app: COMMIT, n1: COMMIT }, COMMIT), 'update');
});

/** A published candidate whose app/zerops.yaml is the real canonical file, with built outputs faked. */
async function release() {
  const root = temp('stable-deploy-');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  run(root, 'init', '--quiet', '--bare', origin);
  run(root, 'init', '--quiet', '--initial-branch', 'demo/sales-crm', repo);
  for (const [key, value] of [['user.email', 't@example.invalid'], ['user.name', 't'], ['commit.gpgSign', 'false'], ['tag.gpgSign', 'false']]) {
    run(repo, 'config', key, value);
  }
  mkdirSync(join(repo, 'app/scripts/zerops'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('../../app/zerops.yaml', import.meta.url)), join(repo, 'app/zerops.yaml'));
  writeFileSync(join(repo, 'app/scripts/zerops/push-service.sh'), '#!/usr/bin/env bash\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '--quiet', '-m', 'candidate');
  run(repo, 'remote', 'add', 'origin', origin);
  run(repo, 'push', '--quiet', 'origin', 'demo/sales-crm');
  run(repo, 'fetch', '--quiet', 'origin');
  const tag = 'sales-stable/2026-11-27';
  run(repo, 'tag', '--annotate', '--message', 'candidate', tag, 'HEAD');
  run(repo, 'push', '--quiet', 'origin', `refs/tags/${tag}`);
  const configPath = join(root, 'stable.config.json');
  copyFileSync(fileURLToPath(new URL('example.config.json', import.meta.url)), configPath);
  const config = await loadStableConfig(configPath);
  const inspected = inspectRelease({ cwd: repo, tag });
  const yaml = materializeRelease(repo, inspected.commit, config);
  const storefronts = join(root, 'storefront-push');
  for (const [kind, pkg] of [['storefront', 'akros-storefront'], ['n1', 'n1-storefront']]) {
    const archive = randomBytes(64);
    mkdirSync(join(storefronts, kind, 'app'), { recursive: true });
    writeFileSync(join(storefronts, kind, 'app/.zerops-storefront.tar.gz'), archive);
    writeFileSync(
      join(storefronts, kind, 'app/.zerops-storefront.json'),
      JSON.stringify({ setup: kind, package: pkg, sourceRevision: inspected.commit, archiveSha256: sha256(archive) }),
    );
  }
  const prebuilt = join(root, 'units.tar.zst');
  writeFileSync(prebuilt, randomBytes(64));
  const artifacts = join(root, 'artifacts');
  const configDigest = configFileDigest(configPath);
  const work = temp('stable-stage-');
  stageArtifacts({ repoRoot: repo, release: inspected, config, configDigest, yaml, output: artifacts, storefronts, prebuilt, work, now: saturday });
  return { root, repo, tag, configPath, config, configDigest, release: inspected, yaml, artifacts };
}

test('staged artifacts verify against the release and config, and any change is refused', async () => {
  const r = await release();
  const expected = { release: r.release, configDigest: r.configDigest, projectId: r.config.projectId, yaml: r.yaml };
  assert.match(verifyArtifacts(r.artifacts, expected).manifestDigest, /^[\da-f]{64}$/u);
  assert.throws(() => verifyArtifacts(r.artifacts, { ...expected, configDigest: '0'.repeat(64) }), /configDigest/u);
  writeFileSync(join(r.artifacts, 'shop/app/.zerops-storefront.tar.gz'), 'x');
  assert.throws(() => verifyArtifacts(r.artifacts, expected), /shop\/app\/\.zerops-storefront\.tar\.gz changed/u);
});

/**
 * maintenance.mjs's own fake Zerops and Cloudflare gate, the project entered into maintenance by enterMaintenance;
 * workload statuses then as given, active app versions as given, pushes and stops recorded.
 */
async function stable(config, statuses, activeVersions, { failApp = false } = {}) {
  const fake = createFakeGate(config);
  await enterMaintenance(config, fake.gate);
  for (const [name, status] of Object.entries(statuses)) fake.zerops.byName(name).status = status;
  const calls = [];
  const fetchImpl = async (url) => {
    const service = fake.zerops.byName(Object.keys(config.services).find((name) => url.endsWith(`/${config.services[name]}`)));
    const name = service.name;
    return { ok: true, json: async () => ({ ...service, activeAppVersion: activeVersions[name] ? { name: activeVersions[name] } : null }) };
  };
  const push = async (step) => {
    calls.push(`push ${step.service}`);
    fake.zerops.byName(step.service).status = 'ACTIVE';
    if (step.service === 'app' && failApp) throw new Error('app build failed');
  };
  const stops = () => fake.zerops.state.calls.filter((call) => call.endsWith('/stop')).map((call) => Object.keys(config.services).find((name) => call.includes(config.services[name])));
  return { ...fake, fetchImpl, push, calls, stops };
}

const fronts = (status) => ({ storefront: status, shop: status, n1: status });
const commonInstall = (r) => ({ repoRoot: r.repo, configPath: r.configPath, tag: r.tag, artifacts: r.artifacts, maintenanceConfirmed: true, now: saturday, token: 't', checkTools: () => {} });
const plan = (r, z, extra = {}) => planInstall({ ...commonInstall(r), gate: z.gate, fetchImpl: z.fetchImpl, work: temp('stable-plan-'), ...extra });
const steps = (planned) => planned.pushes.map((step) => `${step.service}:${step.setup}`);

test('the first install deploys the app alone, explicitly; the next one only the fronts', async () => {
  const r = await release();
  const fresh = await stable(r.config, { app: 'READY_TO_DEPLOY', ...fronts('READY_TO_DEPLOY') }, {});
  await assert.rejects(plan(r, fresh), /--bootstrap-app/u);
  const first = await plan(r, fresh, { bootstrapApp: true });
  assert.equal(first.kind, 'bootstrap-app');
  assert.equal(first.commit, r.release.commit);
  assert.deepEqual(steps(first), ['app:app']);

  const appOnly = await stable(r.config, { app: 'ACTIVE', ...fronts('READY_TO_DEPLOY') }, { app: r.release.commit });
  await assert.rejects(plan(r, appOnly, { bootstrapApp: true }), /never ran/u);
  const second = await plan(r, appOnly);
  assert.equal(second.kind, 'bootstrap-fronts');
  assert.equal(second.maintenance, 'gated');
  assert.deepEqual(steps(second), ['storefront:storefront', 'shop:shop', 'n1:n1']);
});

test('an update needs every workload stopped behind the gate and data.mjs backup and rehearsal', async () => {
  const r = await release();
  const previous = { app: 'e'.repeat(40), storefront: 'e'.repeat(40), shop: 'e'.repeat(40), n1: 'e'.repeat(40) };
  const backupPath = join(r.root, 'backup');
  const rehearsalPath = join(r.root, 'rehearsal.json');
  const checked = [];
  const checkData = async (input) => {
    checked.push(input);
    return { backupManifestSha256: '0'.repeat(64) };
  };
  const stopped = await stable(r.config, {}, previous);
  await assert.rejects(plan(r, stopped), /--backup DIR and --rehearsal FILE/u);
  await assert.rejects(plan(r, stopped, { maintenanceConfirmed: false }), /maintenance-confirmed/u);
  const planned = await plan(r, stopped, { backupPath, rehearsalPath, checkData });
  assert.equal(planned.kind, 'update');
  assert.equal(planned.maintenance, 'maintenance');
  assert.deepEqual(steps(planned), ['app:app', 'storefront:storefront', 'shop:shop', 'n1:n1']);
  assert.equal(checked[0].runningRevision, 'e'.repeat(40));
  assert.equal(checked[0].release.commit, r.release.commit);
  await assert.rejects(plan(r, stopped, { backupPath, rehearsalPath, checkData, now: new Date('2026-11-25T12:00:00Z') }), /emergency-reason/u);

  const running = await stable(r.config, { app: 'ACTIVE' }, previous);
  await assert.rejects(plan(r, running, { backupPath, rehearsalPath, checkData }), /not in maintenance/u);
  const opened = await stable(r.config, {}, previous);
  opened.edgeApi.ourRule(r.config).enabled = false;
  await assert.rejects(plan(r, opened, { backupPath, rehearsalPath, checkData }), /not in maintenance/u);
  const demo = await stable(r.config, {}, previous);
  demo.zerops.byName('n1').projectId = r.config.demoProjectId;
  await assert.rejects(plan(r, demo, { backupPath, rehearsalPath, checkData }), /demo project/u);
  const fresh = await stable(r.config, { app: 'READY_TO_DEPLOY', ...fronts('READY_TO_DEPLOY') }, {});
  await assert.rejects(plan(r, fresh, { bootstrapApp: true, backupPath, rehearsalPath }), /takes no --backup/u);
});

test('an install leaves the candidate running behind the gate; a failure stops every workload', async () => {
  const r = await release();
  const fresh = await stable(r.config, { app: 'READY_TO_DEPLOY', ...fronts('READY_TO_DEPLOY') }, {});
  const first = await plan(r, fresh, { bootstrapApp: true });
  const before = fresh.stops().length;
  const result = await executeInstall(first, { gate: fresh.gate, push: fresh.push });
  assert.deepEqual(fresh.calls, ['push app']);
  assert.equal(fresh.stops().length, before);
  assert.equal(result.maintenance.workloads.app.status, 'ACTIVE');
  assert.equal(result.maintenance.state, 'gated');

  const failing = await stable(r.config, { app: 'READY_TO_DEPLOY', ...fronts('READY_TO_DEPLOY') }, {}, { failApp: true });
  const failingPlan = await plan(r, failing, { bootstrapApp: true });
  const stopsBefore = failing.stops().length;
  await assert.rejects(executeInstall(failingPlan, { gate: failing.gate, push: failing.push }), /Every workload is stopped\. The project is unsafe/u);
  assert.deepEqual(failing.stops().slice(stopsBefore), ['app']);
});

test('reopening needs complete passed evidence of the release every workload runs, under this config', async () => {
  const { EVIDENCE_KIND, REQUIRED_CHECK_IDS } = await import('./verify.mjs');
  const r = await release();
  const { commit } = r.release;
  const evidence = (overrides = {}) => ({
    kind: EVIDENCE_KIND,
    schemaVersion: 1,
    phase: 'candidate',
    status: 'passed',
    tag: r.tag,
    tagObject: r.release.tagObject,
    commit,
    configDigest: r.configDigest,
    manifestDigest: '0'.repeat(64),
    projectId: r.config.projectId,
    finishedAt: '2026-11-28T08:00:00Z',
    checks: REQUIRED_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
    ...overrides,
  });
  const running = (versions) => async (url) => {
    const name = Object.keys(r.config.services).find((key) => url.endsWith(`/${r.config.services[key]}`));
    return { ok: true, json: async () => ({ id: r.config.services[name], projectId: r.config.projectId, activeAppVersion: { name: versions[name] } }) };
  };
  const all = { app: commit, storefront: commit, shop: commit, n1: commit };
  const gate = (value, extra = {}) =>
    assertReopenEvidence(value, { config: r.config, configPath: r.configPath, token: 't', fetchImpl: running(all), now: saturday, repoRoot: r.repo, ...extra });
  assert.equal((await gate(evidence())).checks, REQUIRED_CHECK_IDS.length);
  const [first, ...rest] = REQUIRED_CHECK_IDS;
  await assert.rejects(gate(evidence({ checks: rest.map((id) => ({ id, status: 'passed' })) })), new RegExp(`lacks checks: ${first}`, 'u'));
  await assert.rejects(gate(evidence({ checks: REQUIRED_CHECK_IDS.map((id) => ({ id, status: id === first ? 'failed' : 'passed' })) })), /did not pass/u);
  await assert.rejects(gate(evidence({ status: 'failed' })), /status is failed/u);
  await assert.rejects(gate(evidence({ checks: [...REQUIRED_CHECK_IDS, first].map((id) => ({ id, status: 'passed' })) })), /twice/u);
  await assert.rejects(gate(evidence({ tagObject: 'f'.repeat(40) })), /tagObject/u);
  await assert.rejects(gate(evidence({ configDigest: '1'.repeat(64) })), /configDigest/u);
  await assert.rejects(gate(evidence({ finishedAt: '2026-11-25T08:00:00Z' })), /48 hours/u);
  await assert.rejects(gate(evidence(), { fetchImpl: running({ ...all, shop: 'e'.repeat(40) }) }), /shop=e/u);
  await assert.rejects(gate(evidence(), { configPath: undefined }), /config path/u);
});
