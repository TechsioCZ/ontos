import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { closeEdge, edgeStatus, loadEdgeSettings, maintenanceRule, openEdge, validateEdgeSettings } from './edge.mjs';
import { createFakeCloudflare, fixtureConfig, fixtureEdge } from './maintenance-fixture.mjs';

const config = fixtureConfig();
const edge = fixtureEdge(config);
const writes = (calls) => calls.filter((call) => !call.startsWith('GET '));

test('edge settings: exact project, a zone id and literal verifier addresses only', async () => {
  assert.deepEqual(validateEdgeSettings(edge, config), edge);
  const cases = [
    [{ ...edge, projectId: config.demoProjectId }, /projectId is not the stable config projectId/u],
    [{ ...edge, zoneId: 'example.com' }, /zoneId/u],
    [{ ...edge, verifierIps: [] }, /at least one address/u],
    [{ ...edge, verifierIps: ['203.0.113.0/24'] }, /verifierIps\[0\] must be one literal/u],
    [{ ...edge, verifierIps: ['verifier.example.com'] }, /verifierIps\[0\]/u],
    [{ ...edge, verifierIps: ['2001:DB8::7', '2001:db8::7'] }, /unique/u],
    [{ ...edge, token: 'x' }, /unknown keys token/u],
    [{ ...edge, schemaVersion: 2 }, /schemaVersion/u],
  ];
  for (const [value, error] of cases) assert.throws(() => validateEdgeSettings(value, config), error);

  const directory = await mkdtemp(path.join(tmpdir(), 'ontos-edge-'));
  const file = path.join(directory, 'edge.json');
  await writeFile(file, JSON.stringify(edge), { mode: 0o644 });
  await assert.rejects(loadEdgeSettings(file, config), /readable by others/u);
});

test('the rule blocks the four stable hosts for everyone but the verifiers', () => {
  assert.deepEqual(maintenanceRule(config, edge, true), {
    ref: 'ontos-stable-maintenance-STABLEproject000000000',
    description: 'OntOS stable maintenance gate for Zerops project STABLEproject000000000',
    expression:
      '(http.host in {"ontos.example.com" "akros.example.com" "shop.example.com" "n1.example.com"} and not ip.src in {203.0.113.7 2001:db8::7})',
    action: 'block',
    enabled: true,
  });
});

test('close adds one rule to the existing entry point, leaves other rules alone, and is idempotent', async () => {
  const fake = createFakeCloudflare();
  const status = await closeEdge(config, edge, { cloudflare: fake.cloudflare });
  assert.equal(status.closed, true);
  assert.deepEqual(writes(fake.state.calls), [`POST /zones/${edge.zoneId}/rulesets/ruleset-1/rules`]);
  assert.deepEqual(fake.state.ruleset.rules[0], { id: 'other-rule', ref: 'someone-else', description: 'other', expression: 'ip.src eq 198.51.100.1', action: 'block', enabled: true });
  assert.equal(fake.state.ruleset.rules.length, 2);
  fake.state.calls.length = 0;
  await closeEdge(config, edge, { cloudflare: fake.cloudflare });
  assert.deepEqual(writes(fake.state.calls), []);
});

test('close creates the entry point when the zone has none', async () => {
  const fake = createFakeCloudflare({ entrypoint: false });
  await closeEdge(config, edge, { cloudflare: fake.cloudflare });
  assert.deepEqual(writes(fake.state.calls), [`POST /zones/${edge.zoneId}/rulesets`]);
  assert.equal(fake.ourRule(config).enabled, true);
});

test('close refuses unproxied or foreign hosts before writing anything', async () => {
  const fake = createFakeCloudflare();
  fake.state.records.get('shop.example.com')[1].proxied = false;
  await assert.rejects(closeEdge(config, edge, { cloudflare: fake.cloudflare }), /not proxied by Cloudflare, so the gate cannot hold: shop\.example\.com/u);
  fake.state.records.delete('n1.example.com');
  await assert.rejects(closeEdge(config, edge, { cloudflare: fake.cloudflare }), /n1\.example\.com/u);
  const foreign = { ...config, origins: { ...config.origins, n1: 'https://n1.other.test' } };
  await assert.rejects(closeEdge(foreign, edge, { cloudflare: fake.cloudflare }), /origins\.n1 is not in the configured Cloudflare zone/u);
  assert.deepEqual(writes(fake.state.calls), []);
});

test('open disables only the project rule; a changed verifier list redefines it on close', async () => {
  const fake = createFakeCloudflare();
  assert.equal((await openEdge(config, edge, { cloudflare: fake.cloudflare })).rule.state, 'missing');
  assert.deepEqual(writes(fake.state.calls), []);
  await closeEdge(config, edge, { cloudflare: fake.cloudflare });
  const ruleId = fake.ourRule(config).id;
  fake.state.calls.length = 0;
  const opened = await openEdge(config, edge, { cloudflare: fake.cloudflare });
  assert.equal(opened.rule.state, 'disabled');
  assert.equal(opened.closed, false);
  assert.deepEqual(writes(fake.state.calls), [`PATCH /zones/${edge.zoneId}/rulesets/ruleset-1/rules/${ruleId}`]);
  assert.equal(fake.state.ruleset.rules[0].enabled, true, 'the other rule stays enabled');

  const moved = { ...edge, verifierIps: ['198.51.100.9'] };
  assert.equal((await edgeStatus(config, moved, { cloudflare: fake.cloudflare })).rule.state, 'drifted');
  await closeEdge(config, moved, { cloudflare: fake.cloudflare });
  assert.match(fake.ourRule(config).expression, /not ip\.src in \{198\.51\.100\.9\}/u);
  assert.equal(fake.ourRule(config).id, ruleId);
});

test('Cloudflare failures name the status and codes, never the token', async () => {
  const fake = createFakeCloudflare();
  fake.state.ruleset.rules.push({ ...maintenanceRule(config, edge, true), id: 'a' }, { ...maintenanceRule(config, edge, true), id: 'b' });
  await assert.rejects(closeEdge(config, edge, { cloudflare: fake.cloudflare }), /holds the maintenance rule twice/u);
  const { cloudflare } = createFakeCloudflare();
  await assert.rejects(cloudflare.zone('b'.repeat(32)), (error) => /HTTP 404 codes 7003/u.test(error.message) && !error.message.includes('cloudflare-token'));
});
