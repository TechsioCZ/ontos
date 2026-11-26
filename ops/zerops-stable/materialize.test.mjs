import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { parse, stringify } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

import { STABLE_VARIABLES } from './config.mjs';
import { StableMaterializationError, materializeStableSetup, materializeStableZerops } from './materialize.mjs';

const script = fileURLToPath(new URL('materialize.mjs', import.meta.url));
const examplePath = fileURLToPath(new URL('example.config.json', import.meta.url));
const canonicalPath = fileURLToPath(new URL('../../app/zerops.yaml', import.meta.url));
const canonicalText = readFileSync(canonicalPath, 'utf8');
const canonical = Object.fromEntries(parse(canonicalText).zerops.map((setup) => [setup.setup, setup]));
const example = () => JSON.parse(readFileSync(examplePath, 'utf8'));
const ORIGINS = ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN'];
const SOURCES = { app: 'app', storefront: 'storefront', shop: 'storefront', n1: 'n1', spicedb: 'spicedb' };
const stageHosts = [
  ...new Set(ORIGINS.flatMap((name) => ['build', 'run'].map((phase) => new URL(canonical.app[phase].envVariables[name]).hostname))),
];
const setupsOf = (text) => Object.fromEntries(parse(text).zerops.map((setup) => [setup.setup, setup]));

test('stable disables demo fixture bootstraps and admits its own N1 origin without changing feature mode', () => {
  const config = example();
  const { app } = setupsOf(materializeStableZerops(canonicalText, config).combined);
  assert.equal(app.run.envVariables.ONTOS_DEMO_FIXTURES_ENABLED, 'false');
  assert.equal(app.run.envVariables.ONTOS_N1_STOREFRONT_ORIGIN, config.origins.n1);
  assert.equal(app.run.envVariables.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT, 'stage');
  assert.equal(app.build.envVariables.ONTOS_INTERNAL_SYMMY_INGRESS, '1');
});
const withCanonical = (change) => {
  const document = parse(canonicalText);
  change(Object.fromEntries(document.zerops.map((setup) => [setup.setup, setup])), document);
  return stringify(document, { lineWidth: 0 });
};
const failsWith = (run, pattern) =>
  assert.throws(run, (error) => error instanceof StableMaterializationError && pattern.test(error.message));

test('writes every stable setup combined and one per file, each under 50 kB', () => {
  const { combined, setups } = materializeStableZerops(canonicalText, example());
  assert.deepEqual(Object.keys(setupsOf(combined)), ['app', 'storefront', 'shop', 'n1', 'spicedb']);
  assert.ok(Buffer.byteLength(combined) < 50_000);
  for (const { setup, service, serviceId, file } of setups) {
    assert.ok(Buffer.byteLength(file) < 50_000);
    assert.equal(service, setup);
    assert.equal(serviceId, example().services[setup]);
    assert.deepEqual(parse(file).zerops, [setupsOf(combined)[setup]]);
    assert.equal(materializeStableSetup(canonicalText, example(), setup), file);
  }
});

test('the app builds and runs with the stable origins, mail and Symmy policies in stage mode', () => {
  const config = example();
  const { app } = setupsOf(materializeStableZerops(canonicalText, config).combined);
  for (const phase of ['build', 'run']) {
    assert.equal(app[phase].envVariables.ONTOS_PUBLIC_ORIGIN, config.origins.shell);
    assert.equal(app[phase].envVariables.ONTOS_STOREFRONT_ORIGIN, config.origins.storefront);
    assert.equal(app[phase].envVariables.ONTOS_SHOP_STOREFRONT_ORIGIN, config.origins.shop);
    assert.equal(app[phase].envVariables.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT, 'stage');
  }
  assert.equal(app.build.envVariables.ONTOS_INTERNAL_SYMMY_INGRESS, '1');
  for (const [key, value] of Object.entries(config.variables.app)) assert.equal(app.run.envVariables[key], value);
});

test('keeps every other canonical value, including in-project service and secret references', () => {
  const config = example();
  const setups = setupsOf(materializeStableZerops(canonicalText, config).combined);
  for (const [setup, source] of Object.entries(SOURCES)) {
    const replaced = new Set([...Object.keys(STABLE_VARIABLES[setup].required), ...Object.keys(STABLE_VARIABLES[setup].optional)]);
    if (setup === 'app') {
      for (const name of [...ORIGINS, 'ONTOS_DEMO_FIXTURES_ENABLED', 'ONTOS_N1_STOREFRONT_ORIGIN']) replaced.add(name);
    }
    const { envVariables: canonicalRun, ...canonicalRest } = canonical[source].run;
    const { envVariables: run, ...rest } = setups[setup].run;
    assert.deepEqual(rest, canonicalRest);
    assert.deepEqual(setups[setup].deploy, canonical[source].deploy);
    assert.deepEqual(setups[setup].build.buildCommands, canonical[source].build.buildCommands);
    for (const [key, value] of Object.entries(canonicalRun)) {
      if (!replaced.has(key)) assert.equal(run[key], value, `${setup} run.envVariables.${key}`);
    }
  }
  assert.equal(setups.app.run.envVariables.CLOUDFLARE_EMAIL_API_TOKEN, '${SMTP_PASSWORD}');
  assert.match(setups.app.run.envVariables.PARTY_REGISTRY_DB_PASSWORD, /^\$\{migrator_/u);
  assert.equal(setups.app.run.envVariables.SPICEDB_ENDPOINT, 'spicedb:50051');
});

test('storefront, shop and N1 carry only the identities the config states', () => {
  const config = example();
  const setups = setupsOf(materializeStableZerops(canonicalText, config).combined);
  for (const setup of ['storefront', 'shop', 'n1']) {
    for (const [key, value] of Object.entries(config.variables[setup])) assert.equal(setups[setup].run.envVariables[key], value);
  }
  assert.equal(setups.shop.run.envVariables.ONTOS_STOREFRONT_ERP_OFFERS, undefined);
  assert.equal(setups.shop.run.start, canonical.storefront.run.start);
});

test('inherits no stage host, policy or identity the config does not state', () => {
  const config = example();
  delete config.variables.app.ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED;
  delete config.variables.storefront.ONTOS_STOREFRONT_ERP_OFFERS;
  const { combined } = materializeStableZerops(canonicalText, config);
  const { app, storefront } = setupsOf(combined);
  assert.equal(app.run.envVariables.ONTOS_PRIVACY_SOURCE_SYNC_PROCESSING_ENABLED, undefined);
  assert.equal(storefront.run.envVariables.ONTOS_STOREFRONT_ERP_OFFERS, undefined);
  for (const host of stageHosts) assert.ok(!combined.includes(host), host);
  for (const value of [canonical.app.run.envVariables.CLOUDFLARE_EMAIL_ACCOUNT_ID, canonical.n1.run.envVariables.ONTOS_STOREFRONT_TENANT_ID]) {
    assert.ok(!combined.includes(value));
  }
  assert.doesNotMatch(combined, /^\s*#(?! Generated)/mu);
});

test('a stage value the config states explicitly is kept', () => {
  const config = example();
  config.variables.n1.STOREFRONT_IMAGE_HOSTS = canonical.n1.run.envVariables.STOREFRONT_IMAGE_HOSTS.split(',').at(-1);
  const { n1 } = setupsOf(materializeStableZerops(canonicalText, config).combined);
  assert.equal(n1.run.envVariables.STOREFRONT_IMAGE_HOSTS, config.variables.n1.STOREFRONT_IMAGE_HOSTS);
});

test('refuses a stage origin', () => {
  const config = example();
  config.origins.shop = canonical.app.run.envVariables.ONTOS_SHOP_STOREFRONT_ORIGIN;
  failsWith(() => materializeStableZerops(canonicalText, config), /origins\.shop is a stage host/u);
});

test('refuses a stage value the canonical file hardcodes outside the replaced variables', () => {
  const input = withCanonical((setups) => {
    setups.app.run.envVariables.EXTRA_LINK = `${setups.app.run.envVariables.ONTOS_PUBLIC_ORIGIN}/help`;
  });
  failsWith(() => materializeStableZerops(input, example()), /setup app\.run\.envVariables\.EXTRA_LINK still carries a stage value/u);
});

test('refuses a reference to a service the stable project does not have', () => {
  const input = withCanonical((setups) => {
    setups.app.run.envVariables.CACHE_URL = 'redis://${valkey_hostname}:6379';
  });
  failsWith(() => materializeStableZerops(input, example()), /references service "valkey"/u);
});

test('refuses a canonical file whose setups do not match the stable setups', () => {
  const input = withCanonical((_, document) => {
    document.zerops.push({ setup: 'worker', run: { envVariables: {} } });
  });
  failsWith(() => materializeStableZerops(input, example()), /exactly the setups app, n1, spicedb, storefront/u);
  const renamed = withCanonical((setups) => {
    delete setups.app.build.envVariables.ONTOS_SHOP_STOREFRONT_ORIGIN;
  });
  failsWith(() => materializeStableZerops(renamed, example()), /build\.envVariables\.ONTOS_SHOP_STOREFRONT_ORIGIN/u);
});

test('CLI writes the combined and per-setup files and never prints config values', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-zerops-'));
  const output = path.join(directory, 'out');
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const written = run(['--config', examplePath, '--input', canonicalPath, '--output-directory', output]);
  assert.equal(written.status, 0, written.stderr);
  const summary = JSON.parse(written.stdout);
  assert.deepEqual(summary.map((entry) => path.basename(entry.path)), ['zerops.yaml', 'app.yaml', 'storefront.yaml', 'shop.yaml', 'n1.yaml', 'spicedb.yaml']);
  assert.equal(readFileSync(path.join(output, 'zerops.yaml'), 'utf8'), materializeStableZerops(canonicalText, example()).combined);
  assert.ok(!written.stdout.includes(example().variables.app.SMTP_FROM));

  const single = run(['--config', examplePath, '--input', canonicalPath, '--setup', 'shop', '--output', path.join(directory, 'shop.yaml')]);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(readFileSync(path.join(directory, 'shop.yaml'), 'utf8'), materializeStableSetup(canonicalText, example(), 'shop'));

  const broken = example();
  broken.variables.app.SMTP_FROM = 'hunter2-not-for-logs';
  const brokenPath = path.join(directory, 'broken.json');
  writeFileSync(brokenPath, JSON.stringify(broken));
  const refused = run(['--config', brokenPath, '--input', canonicalPath, '--output-directory', output]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /variables\.app\.SMTP_FROM/u);
  assert.ok(!refused.stderr.includes('hunter2'));

  assert.equal(run(['--config', examplePath]).status, 1);
  const defaulted = run(['--config', examplePath, '--setup', 'app', '--output', path.join(directory, 'app.yaml')]);
  assert.equal(defaulted.status, 0, defaulted.stderr);
  assert.equal(readFileSync(path.join(directory, 'app.yaml'), 'utf8'), materializeStableSetup(canonicalText, example(), 'app'));
});
