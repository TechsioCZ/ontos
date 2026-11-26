import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createFakeGate, fixtureConfig } from './maintenance-fixture.mjs';
import {
  assertEdgeClosed,
  assertInMaintenance,
  assertProjectServices,
  enterMaintenance,
  leaveMaintenance,
  main,
  maintenanceStatus,
  startGated,
} from './maintenance.mjs';

const accepted = async () => {};
const zeropsWrites = (fake) => fake.zerops.state.calls.filter((call) => !call.startsWith('GET '));
const cloudflareWrites = (fake) => fake.edgeApi.state.calls.filter((call) => !call.startsWith('GET '));

test('an open project reads open', async () => {
  const fake = createFakeGate();
  const status = await maintenanceStatus(fake.config, fake.gate);
  assert.equal(status.state, 'open');
  assert.equal(status.gate.rule, 'missing');
});

test('ownership: a service of another project or under another name is refused before any change', async () => {
  const fake = createFakeGate();
  fake.zerops.byName('shop').projectId = fake.config.demoProjectId;
  await assert.rejects(enterMaintenance(fake.config, fake.gate), /services\.shop belongs to the demo project/u);
  assert.deepEqual([...zeropsWrites(fake), ...cloudflareWrites(fake)], []);

  const renamed = createFakeGate();
  renamed.zerops.byName('n1').name = 'storefront';
  await assert.rejects(assertProjectServices(renamed.config, { client: renamed.zerops.client }), /services\.n1 is the Zerops service named storefront/u);
  const demo = { ...fixtureConfig(), projectId: 'DEMOproject00000000000' };
  await assert.rejects(assertProjectServices(demo, { client: renamed.zerops.client }), /demo project id/u);
});

test('enter closes the gate, then stops the workloads and the migrator; datastores stay up; a rerun writes nothing', async () => {
  const fake = createFakeGate();
  const status = await enterMaintenance(fake.config, fake.gate);
  assert.equal(status.state, 'maintenance');
  assert.equal(status.gate.closed, true);
  assert.equal(fake.edgeApi.ourRule(fake.config).enabled, true);
  for (const name of ['app', 'storefront', 'shop', 'n1', 'migrator']) assert.equal(fake.zerops.byName(name).status, 'STOPPED', name);
  for (const name of ['app', 'storefront', 'shop', 'n1']) assert.equal(fake.zerops.byName(name).subdomainAccess, false, name);
  assert.equal(fake.zerops.byName('spicedb').status, 'ACTIVE');
  assert.equal(fake.zerops.byName('db18').status, 'ACTIVE');
  const writes = zeropsWrites(fake);
  assert.ok(writes.findIndex((call) => call.endsWith('/disable-subdomain-access')) < writes.findIndex((call) => call.endsWith('/stop')));
  assert.equal(writes.at(-1), `PUT /service-stack/${fake.config.services.migrator}/stop`);
  await assertInMaintenance(fake.config, fake.gate);

  fake.zerops.state.calls.length = 0;
  fake.edgeApi.state.calls.length = 0;
  await enterMaintenance(fake.config, fake.gate);
  assert.deepEqual([...zeropsWrites(fake), ...cloudflareWrites(fake)], []);
});

test('enter stops nothing when the gate cannot hold', async () => {
  const fake = createFakeGate();
  fake.edgeApi.state.records.get('akros.example.com')[0].proxied = false;
  await assert.rejects(enterMaintenance(fake.config, fake.gate), /not proxied by Cloudflare/u);
  assert.deepEqual([...zeropsWrites(fake), ...cloudflareWrites(fake)], []);
  assert.equal(fake.zerops.byName('app').status, 'ACTIVE');
});

test('a deploy that starts a workload stays behind the gate, and enter stops it again', async () => {
  const fake = createFakeGate();
  await enterMaintenance(fake.config, fake.gate);
  fake.zerops.byName('app').status = 'ACTIVE';
  assert.equal((await assertEdgeClosed(fake.config, fake.gate)).state, 'gated');
  await assert.rejects(assertInMaintenance(fake.config, fake.gate), /gated, not in maintenance/u);
  await enterMaintenance(fake.config, fake.gate);
  assert.equal(fake.zerops.byName('app').status, 'STOPPED');
});

test('a failed stop throws and starts or opens nothing', async () => {
  const fake = createFakeGate();
  fake.zerops.state.failProcess.add('stop:shop');
  await assert.rejects(enterMaintenance(fake.config, fake.gate), /process ended as FAILED/u);
  assert.ok(!zeropsWrites(fake).some((call) => call.endsWith('/start')));
  assert.equal(fake.edgeApi.ourRule(fake.config).enabled, true);
  assert.equal((await maintenanceStatus(fake.config, fake.gate)).state, 'gated');
});

test('start-gated starts the app first, then the fronts, never the migrator, and only behind the gate', async () => {
  const fake = createFakeGate();
  await assert.rejects(startGated(fake.config, fake.gate), /gate is not closed/u);
  await enterMaintenance(fake.config, fake.gate);
  fake.zerops.state.calls.length = 0;
  const status = await startGated(fake.config, fake.gate);
  assert.equal(status.state, 'gated');
  const starts = zeropsWrites(fake).map((call) => call.split('/')[2]);
  const { services } = fake.config;
  assert.deepEqual(starts, [services.app, services.n1, services.shop, services.storefront]);
  assert.equal(fake.zerops.byName('migrator').status, 'STOPPED');
});

test('leave opens only after the reopen evidence check accepts, disables only the project rule and starts nothing', async () => {
  const fake = createFakeGate();
  await enterMaintenance(fake.config, fake.gate);
  await assert.rejects(leaveMaintenance(fake.config, { ...fake.gate, evidence: {}, assertReopenEvidence: accepted }), /not ACTIVE; run start-gated/u);
  await startGated(fake.config, fake.gate);
  await assert.rejects(
    leaveMaintenance(fake.config, {
      ...fake.gate,
      evidence: { status: 'failed' },
      assertReopenEvidence: async () => {
        throw new Error('the evidence status is failed, not passed');
      },
    }),
    /not passed/u,
  );
  assert.equal(fake.edgeApi.ourRule(fake.config).enabled, true);

  const seen = [];
  fake.zerops.state.calls.length = 0;
  const status = await leaveMaintenance(fake.config, {
    ...fake.gate,
    evidence: { status: 'passed' },
    configPath: '/stable/config.json',
    assertReopenEvidence: async (evidence, context) => {
      seen.push([evidence.status, context.config.projectId, context.configPath, context.status.state, typeof context.client.service]);
    },
  });
  assert.deepEqual(seen, [['passed', fake.config.projectId, '/stable/config.json', 'gated', 'function']]);
  assert.equal(status.state, 'open');
  assert.equal(fake.edgeApi.ourRule(fake.config).enabled, false);
  assert.equal(fake.edgeApi.state.ruleset.rules.find((rule) => rule.id === 'other-rule').enabled, true);
  assert.deepEqual(zeropsWrites(fake), []);
  assert.equal(fake.zerops.byName('migrator').status, 'STOPPED');
  assert.equal(fake.zerops.byName('app').subdomainAccess, false);
});

test('the CLI refuses leave without evidence and enter without the project id, before any API call', async () => {
  const fake = createFakeGate();
  const config = new URL('./example.config.json', import.meta.url).pathname;
  const io = { ...fake.gate, stdout: { write: () => true }, stderr: { write: () => true } };
  await assert.rejects(main(['leave', '--config', config, '--confirm-project', 'STABLEproject000000000'], io), /leave requires --evidence/u);
  await assert.rejects(main(['enter', '--config', config], io), /--confirm-project/u);
  await assert.rejects(main(['expose', '--config', config], io), /unknown command expose/u);
  assert.deepEqual([...fake.zerops.state.calls, ...fake.edgeApi.state.calls], []);
});
