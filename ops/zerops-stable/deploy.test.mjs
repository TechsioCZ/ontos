import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { loadStableConfig } from './config.mjs';
import { assertReopenEvidence, installKind } from './deploy-evidence.mjs';
import { createFakeZerops } from './maintenance-fixture.mjs';
import { executeInstall, main, materializeRelease, planInstall, stageArtifacts, verifyArtifacts, verifyDeployment } from './deploy.mjs';
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

/** The fake stable Zerops project (every service ACTIVE) with workload statuses and active app versions as given; pushes recorded. */
function stable(config, activeVersions, { statuses = {}, failApp = false, origins = () => ({ status: 200 }) } = {}) {
  const zerops = createFakeZerops(config);
  for (const [name, status] of Object.entries(statuses)) zerops.byName(name).status = status;
  const calls = [];
  const fetchImpl = async (url) => {
    const name = Object.keys(config.services).find((key) => url.endsWith(`/${config.services[key]}`));
    if (!name) return origins(url);
    const service = zerops.byName(name);
    return { ok: true, json: async () => ({ ...service, activeAppVersion: activeVersions[name] ? { name: activeVersions[name] } : null }) };
  };
  const push = async (step) => {
    calls.push(`push ${step.service}`);
    if (step.service === 'app' && failApp) throw new Error('app build failed');
  };
  return { zerops, client: zerops.client, fetchImpl, push, calls };
}

const none = { app: null, storefront: null, shop: null, n1: null };
const plan = (r, z, extra = {}) =>
  planInstall({ repoRoot: r.repo, configPath: r.configPath, tag: r.tag, artifacts: r.artifacts, token: 't', checkTools: () => {}, client: z.client, fetchImpl: z.fetchImpl, work: temp('stable-plan-'), ...extra });
const steps = (planned) => planned.pushes.map((step) => `${step.service}:${step.setup}`);

test('the first install deploys the app alone, the next one only the fronts, every later one all four app first', async () => {
  const r = await release();
  const first = await plan(r, stable(r.config, none));
  assert.equal(first.kind, 'bootstrap-app');
  assert.equal(first.commit, r.release.commit);
  assert.deepEqual(steps(first), ['app:app']);
  const second = await plan(r, stable(r.config, { ...none, app: r.release.commit }));
  assert.equal(second.kind, 'bootstrap-fronts');
  assert.deepEqual(steps(second), ['storefront:storefront', 'shop:shop', 'n1:n1']);
  const old = 'e'.repeat(40);
  const update = await plan(r, stable(r.config, { app: old, storefront: old, shop: old, n1: old }));
  assert.equal(update.kind, 'update');
  assert.deepEqual(steps(update), ['app:app', 'storefront:storefront', 'shop:shop', 'n1:n1']);
});

test('an install refuses a service of the demo or another project, and artifacts of another config', async () => {
  const r = await release();
  const demo = stable(r.config, none);
  demo.zerops.byName('n1').projectId = r.config.demoProjectId;
  await assert.rejects(plan(r, demo), /demo project/u);
  const renamed = stable(r.config, none);
  renamed.zerops.byName('shop').name = 'storefront';
  await assert.rejects(plan(r, renamed), /services\.shop is the Zerops service named storefront/u);
  const otherConfig = join(r.root, 'other.config.json');
  writeFileSync(otherConfig, `${readFileSync(r.configPath, 'utf8')}\n`);
  await assert.rejects(plan(r, stable(r.config, none), { configPath: otherConfig }), /configDigest/u);
});

test('an install pushes in order and a failed push stops it, naming what was pushed', async () => {
  const r = await release();
  const old = 'e'.repeat(40);
  const z = stable(r.config, { app: old, storefront: old, shop: old, n1: old });
  const result = await executeInstall(await plan(r, z), { push: z.push });
  assert.deepEqual(result.pushed, ['app', 'storefront', 'shop', 'n1']);
  assert.deepEqual(z.calls, ['push app', 'push storefront', 'push shop', 'push n1']);
  const failing = stable(r.config, { app: old, storefront: old, shop: old, n1: old }, { failApp: true });
  await assert.rejects(executeInstall(await plan(r, failing), { push: failing.push }), /failed after no push: app build failed/u);
  assert.deepEqual(failing.calls, ['push app']);
});

test('verify passes only when every workload is ACTIVE on the tag and every origin answers', async () => {
  const r = await release();
  const { commit } = r.release;
  const all = { app: commit, storefront: commit, shop: commit, n1: commit };
  const verify = (z) => verifyDeployment({ repoRoot: r.repo, configPath: r.configPath, tag: r.tag, token: 't', client: z.client, fetchImpl: z.fetchImpl });
  const live = await verify(stable(r.config, all, { origins: (url) => ({ status: url.includes('ontos.') ? 302 : 200 }) }));
  assert.deepEqual(live.versions, all);
  assert.deepEqual(Object.values(live.origins), [302, 200, 200, 200]);
  await assert.rejects(verify(stable(r.config, { ...all, shop: 'e'.repeat(40) })), /shop runs e{40}, not/u);
  await assert.rejects(verify(stable(r.config, all, { statuses: { n1: 'STOPPED' } })), /n1 is STOPPED/u);
  await assert.rejects(verify(stable(r.config, all, { origins: (url) => ({ status: url.includes('akros') ? 502 : 200 }) })), /akros\.example\.com answered 502/u);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await assert.rejects(verify(stable(r.config, all, { origins: () => Promise.reject(refused) })), /unreachable \(ECONNREFUSED\)/u);
});

test('the CLI takes one command and never mixes their options', async () => {
  const env = { ZEROPS_TOKEN: 't' };
  await assert.rejects(main(['--config', 'c', '--tag', 't'], { env }), /usage/u);
  await assert.rejects(main(['build', '--config', 'c', '--tag', 't', '--output', 'o', '--execute'], { env }), /usage/u);
  await assert.rejects(main(['verify', '--config', 'c', '--tag', 't', '--artifacts', 'a'], { env }), /usage/u);
  await assert.rejects(main(['install', '--config', 'c', '--tag', 't'], { env }), /usage/u);
  await assert.rejects(main(['install', '--config', 'c', '--tag', 't', '--artifacts', 'a'], { env: {} }), /ZEROPS_TOKEN is required/u);
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
