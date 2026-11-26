import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAccountsFile, loadCatalog, storefrontServiceVariables } from './bootstrap.mjs';
import { validateStableConfig } from './config.mjs';
import {
  accountsScript,
  afterApp,
  beforeApp,
  ensureCommercePortal,
  ensureStorefrontSecrets,
  modulesScript,
  parseBootstrapBundle,
  portalOwnerSecrets,
  runRemote,
  salesDataInput,
  seededId,
  withPortalWorkloads,
  workloadsScript,
} from './gha-bootstrap.mjs';

const catalog = loadCatalog();
const readExample = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));
const spec = readExample('bootstrap-spec.example.json');
spec.tenants[1].accounts[0].email = 'owner@akros.example';
spec.tenants[1].legalEntity.registrationNumber = 'STABLE-AKROS';
spec.tenants[2].accounts[0].email = 'owner@n1.example';
spec.tenants[2].legalEntity.registrationNumber = 'STABLE-N1';
const emails = spec.tenants.flatMap(({ accounts }) => accounts.map(({ email }) => email));
const passwords = new Map(emails.map((email) => [email, `secret-password-of-${email}`]));
let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String((counter += 1)).padStart(12, '0')}`;
const accounts = buildAccountsFile(
  { schemaVersion: 1, tenants: spec.tenants.map((tenant) => ({ ...tenant, storefronts: tenant.storefronts ?? [] })) },
  passwords,
  undefined,
  { demoIdentities: new Set(), newId },
);
const derived = storefrontServiceVariables(
  { tenants: spec.tenants.map((tenant) => ({ ...tenant, storefronts: tenant.storefronts ?? [] })) },
  accounts,
);
const example = readExample('example.config.json');
const config = validateStableConfig({
  ...example,
  variables: {
    ...example.variables,
    n1: { ...derived.n1, STOREFRONT_IMAGE_HOSTS: 'n1.example.com' },
    shop: derived.shop,
    storefront: derived.storefront,
  },
});
const secrets = {
  projectId: config.projectId,
  schemaVersion: 1,
  services: {
    app: { ONTOS_OWNER_SECRETS_JSON: '{"shell-super-app":{"BETTER_AUTH_SECRET":"auth-secret-value"}}' },
    migrator: { PARTY_REGISTRY_DB_PASSWORD: 'db-password-value' },
    spicedb: { SPICEDB_DATABASE_PASSWORD: 'spicedb-password-value' },
  },
};
const bundleValue = (overrides = {}) => ({
  accounts,
  databaseAdminUrl: 'postgresql://db18:admin-password-value@db18:5432/db18',
  kind: 'ontos.stable.bootstrap',
  modules: { sroubshop: ['demo.merchandise', 'commerce.market-catalog', 'commerce.storefront-registry', 'commerce.tax'] },
  projectId: config.projectId,
  salesData: ['sroubshop'],
  schemaVersion: 1,
  secrets,
  spec,
  ...overrides,
});
const parse = (value) => parseBootstrapBundle(JSON.stringify(value), { catalog, config });
const refusal = (value) => {
  try {
    parse(value);
  } catch (error) {
    return error.message;
  }
  return assert.fail('the bundle was accepted');
};

test('the bundle parses against the stable config and carries every account password', () => {
  const bundle = parse(bundleValue());
  assert.equal(bundle.passwords.get('obchod@sroubshop.example'), 'secret-password-of-obchod@sroubshop.example');
  assert.deepEqual(bundle.salesData, ['sroubshop']);
  assert.deepEqual(parse(bundleValue({ modules: undefined, salesData: undefined })).modules, {});
});

test('a bundle of another project, identity or module set is refused without echoing a secret', () => {
  const messages = [
    refusal(bundleValue({ projectId: 'OTHERproject0000000000' })),
    refusal(bundleValue({ accounts: { ...accounts, tenants: accounts.tenants.slice(1) } })),
    refusal(bundleValue({ modules: { sroubshop: ['demo.nonexistent'] } })),
    refusal(bundleValue({ modules: {}, salesData: ['sroubshop'] })),
    refusal(bundleValue({ databaseAdminUrl: 'https://db18' })),
  ];
  const swapped = structuredClone(accounts);
  swapped.tenants[0].legalEntity.legalEntityId = '11111111-1111-4111-8111-111111111111';
  messages.push(refusal(bundleValue({ accounts: swapped })));
  assert.match(messages.at(-1), /variables\.shop\.ONTOS_STOREFRONT_LEGAL_ENTITY_ID/u);
  for (const message of messages) assert.doesNotMatch(message, /password-value|secret-password/u);
  assert.equal(
    (() => {
      try {
        parseBootstrapBundle('{"databaseAdminUrl": "secret-password-of', { catalog, config });
      } catch (error) {
        return error.message;
      }
      return '';
    })(),
    'STABLE_BOOTSTRAP_JSON is not JSON',
  );
});

const services = (status) =>
  Object.fromEntries(['app', 'storefront', 'shop', 'n1', 'spicedb', 'db18', 'migrator'].map((name) => [name, { status: name === 'app' ? status : 'READY_TO_DEPLOY' }]));

test('before-app stores the secrets with the SMTP password first, then initializes', async () => {
  const calls = [];
  const deps = (status, changes) => ({
    applySecrets: async ({ apply, bundle }) => {
      calls.push(['secrets', apply, bundle.services.app.SMTP_PASSWORD]);
      return { changes };
    },
    assertServices: async () => services(status),
    initialize: async ({ apply, bundle }) => {
      calls.push(['initialize', apply, bundle.services.app.SMTP_PASSWORD]);
      return { applied: apply, plan: {} };
    },
  });
  const run = (apply, status, changes) =>
    beforeApp({ apply, bundle: parse(bundleValue()), config, deps: deps(status, changes), log: () => {}, smtpPassword: 'smtp', tag: 'sales-stable/2026-11-26' });
  assert.equal((await run(true, 'READY_TO_DEPLOY', [{ action: 'create', key: 'K', service: 'app' }])).initialized, true);
  assert.deepEqual(calls.splice(0), [['secrets', true, 'smtp'], ['initialize', true, 'smtp']]);
  await run(false, 'READY_TO_DEPLOY', [{ action: 'create', key: 'K', service: 'app' }]);
  assert.deepEqual(calls.splice(0), [['secrets', false, 'smtp']]);
  await run(true, 'ACTIVE', [{ action: 'unchanged', key: 'K', service: 'app' }]);
  assert.deepEqual(calls.splice(0), [['secrets', true, 'smtp']]);
  await assert.rejects(
    beforeApp({ apply: true, bundle: parse(bundleValue()), config, deps: deps('READY_TO_DEPLOY', []), log: () => {}, smtpPassword: '', tag: 't' }),
    /STAGE_SMTP_PASSWORD is required/u,
  );
});

test('app container steps carry secrets only on ssh stdin, never as an argument', () => {
  const bundle = parse(bundleValue());
  const script = [
    accountsScript(bundle.accounts, true),
    modulesScript({ email: 'obchod@sroubshop.example', moduleKeys: ['demo.merchandise'], password: "it's-secret-password-value", tenantId: accounts.tenants[0].tenantId }, true),
  ].join('\n');
  assert.doesNotMatch(script, /secret-password|password-value/u);
  assert.match(script, /bootstrap-stage-accounts\.mts --commit/u);
  assert.match(script, /activate-tenant-modules\.mts --tenant-id \S+ --modules demo\.merchandise --mode apply/u);
  const seen = [];
  runRemote(script, {
    run: (command, args, options) => {
      seen.push({ args, command, input: options.input });
      return { status: 0 };
    },
  });
  assert.deepEqual(seen.map(({ command }) => command), ['ssh-keygen', 'ssh']);
  const [keygen, ssh] = seen;
  // The runner has no SSH identity: each call presents the throwaway key it just made, and runs POSIX sh, not bash.
  assert.equal(ssh.args[ssh.args.indexOf('-i') + 1], keygen.args[keygen.args.indexOf('-f') + 1]);
  assert.deepEqual(ssh.args.slice(-2), ['app', 'sh -l -s']);
  assert.equal(ssh.input, script);
  assert.doesNotMatch(ssh.args.join(' '), /password|base64/u);
  const failing = (failed) => (command) => ({ status: command === failed ? 255 : 0 });
  assert.throws(() => runRemote('exit 1', { run: failing('ssh') }), /app container failed/u);
  assert.throws(() => runRemote('exit 1', { run: failing('ssh-keygen') }), /ssh-keygen could not create/u);
});

test('the remote steps are POSIX sh, and a failed workload dry run stops the script', () => {
  const bundle = parse(bundleValue());
  for (const script of [accountsScript(bundle.accounts, true), workloadsScript({ schemaVersion: 1, tenants: [] }, true)]) {
    assert.equal(spawnSync('sh', ['-n'], { encoding: 'utf8', input: script }).status, 0);
  }
  const lines = workloadsScript({ schemaVersion: 1, tenants: [] }, true).split('\n');
  const from = lines.findIndex((line) => line.includes('--mode dry-run'));
  const bin = mkdtempSync(`${tmpdir()}/gha-node-`);
  writeFileSync(`${bin}/node`, '#!/bin/sh\necho "dry run refused" >&2\nexit 3\n', { mode: 0o755 });
  const result = spawnSync('sh', ['-c', ['set -eu', 'private="$(mktemp -d)"', ...lines.slice(from, from + 2), 'echo reached'].join('\n')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 3);
  assert.doesNotMatch(result.stdout, /reached/u);
});

test('the workload plan fingerprint is read from the dry run output', () => {
  const fingerprint = 'ab'.repeat(32);
  const line = workloadsScript({ schemaVersion: 1, tenants: [] }, true)
    .split('\n')
    .find((entry) => entry.startsWith('fingerprint='));
  const result = spawnSync('bash', ['-c', `private="$(mktemp -d)"; printf '%s\\n' "{ mode: 'dry-run', x: 1 }" "{ fingerprint: '${fingerprint}', mode: 'dry-run' }" >"$private/plan.txt"; ${line}; printf %s "$fingerprint"`], { encoding: 'utf8' });
  assert.equal(result.stdout, fingerprint);
});

test('storefront keys already on Zerops are reused, new ones go straight to their service', async () => {
  const bundle = parse(bundleValue());
  const principals = new Map([
    ['sroubshop-storefront', { displayName: 'sroubshop-storefront', key: { bindingStatus: 'active' }, kind: 'service', principalId: newId(), principalStatus: 'active' }],
  ]);
  const shellClient = {
    createServicePrincipal: async (cookie, displayName) => {
      const principalId = newId();
      principals.set(displayName, { displayName, key: null, kind: 'service', principalId, principalStatus: 'active' });
      return principalId;
    },
    issueManagedKey: async (cookie, principalId, name) => {
      principals.get(name).key = { bindingStatus: 'active' };
      return `issued-${name}`;
    },
    listManaged: async () => [...principals.values()],
    signIn: async () => 'session',
  };
  const stored = [];
  const store = {
    create: async (serviceId, key, content) => stored.push([serviceId, key, content]),
    list: async (serviceId) => (serviceId === config.services.shop ? [{ content: 'held-shop-key', id: 'x', key: 'ONTOS_AKROS_STOREFRONT_API_KEY' }] : []),
  };
  const keysDir = mkdtempSync(`${tmpdir()}/gha-keys-`);
  const registrations = await ensureStorefrontSecrets({ apply: true, bundle, config, keysDir, log: () => {}, shellClient, store });
  assert.deepEqual(stored, [
    [config.services.storefront, 'ONTOS_AKROS_STOREFRONT_API_KEY', 'issued-akros-storefront'],
    [config.services.n1, 'ONTOS_N1_STOREFRONT_API_KEY', 'issued-n1-storefront'],
  ]);
  assert.equal(registrations.tenants.length, 3);
});

test('after-app dry run reads the accounts plan only; sales data addresses stable records', async () => {
  const bundle = parse(bundleValue());
  const scripts = [];
  const result = await afterApp({
    apply: false,
    bundle,
    config,
    deps: { assertServices: async () => services('ACTIVE'), remote: (script) => scripts.push(script) },
    log: () => {},
  });
  assert.equal(result.applied, false);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0], /--commit/u);
  await assert.rejects(
    afterApp({ apply: true, bundle, config, deps: { assertServices: async () => services('READY_TO_DEPLOY') }, log: () => {} }),
    /deploy the app before after-app/u,
  );
  const input = salesDataInput({ apply: true, bundle, config, slug: 'sroubshop' });
  assert.equal(input.marketId, seededId(accounts.tenants[0].tenantId, 'market:SROUBSHOP-CZ'));
  assert.equal(input.storefrontAppId, 'sroubshop-storefront');
  assert.equal(input.email, 'obchod@sroubshop.example');
  assert.match(input.marketId, /^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
});

test('each storefront tenant gets one native Commerce portal key, kept in the app owner secrets', async () => {
  const bundle = parse(bundleValue());
  const principals = new Map();
  const issued = [];
  const shellClient = {
    createServicePrincipal: async (cookie, displayName) => {
      const principalId = newId();
      principals.set(cookie, [{ displayName, key: null, kind: 'service', principalId, principalStatus: 'active' }]);
      return principalId;
    },
    issueManagedKey: async (cookie, principalId, name) => {
      principals.get(cookie)[0].key = { bindingStatus: 'active' };
      issued.push(name);
      return `portal-key-${cookie}`;
    },
    listManaged: async (cookie) => principals.get(cookie) ?? [],
    signIn: async (email) => email,
  };
  let owners = { 'shell-super-app': { BETTER_AUTH_SECRET: 'auth' } };
  const store = { list: async () => [{ content: JSON.stringify(owners), id: 'o', key: 'ONTOS_OWNER_SECRETS_JSON' }] };
  const persisted = [];
  const persist = async (credentials) => persisted.push(Object.keys(credentials).length);
  const first = await ensureCommercePortal({ bundle, config, log: () => {}, persist, shellClient, store });
  assert.equal(issued.length, 3);
  assert.deepEqual(persisted, [1, 2, 3], 'each key is stored as soon as it is issued');
  assert.deepEqual(first.credentials[accounts.tenants[0].tenantId], {
    coreIdentityApiKey: 'portal-key-obchod@sroubshop.example',
    gatewayApiKey: 'portal-key-obchod@sroubshop.example',
  });
  const secrets = portalOwnerSecrets(first.credentials, { deployment: { d: 1 }, verification: { v: 1 } });
  owners = { ...owners, ...secrets };
  const again = await ensureCommercePortal({ bundle, config, log: () => {}, persist, shellClient, store });
  assert.equal(issued.length, 3);
  assert.deepEqual(persisted, [1, 2, 3]);
  assert.deepEqual(again.credentials, first.credentials);
  owners = { 'shell-super-app': { BETTER_AUTH_SECRET: 'auth' } };
  await assert.rejects(ensureCommercePortal({ bundle, config, log: () => {}, persist, shellClient, store }), /rotate it deliberately/u);
  const registrations = withPortalWorkloads(
    { schemaVersion: 1, tenants: [{ ownerPrincipalId: 'o', tenantId: accounts.tenants[0].tenantId, workloads: [] }] },
    first.workloads,
  );
  assert.deepEqual(
    registrations.tenants[0].workloads.map(({ workloadKey }) => workloadKey),
    ['commerce.storefront-client', 'core.identity-provider'],
  );
});

test('a Commerce portal key issued before a failure is stored, so the rerun goes on instead of refusing it', async () => {
  const bundle = parse(bundleValue());
  const principals = new Map();
  let failOn = 'owner@akros.example';
  const shellClient = {
    createServicePrincipal: async (cookie, displayName) => {
      const principalId = newId();
      principals.set(cookie, [{ displayName, key: null, kind: 'service', principalId, principalStatus: 'active' }]);
      return principalId;
    },
    issueManagedKey: async (cookie) => {
      if (cookie === failOn) throw new Error('Shell answered HTTP 503');
      principals.get(cookie)[0].key = { bindingStatus: 'active' };
      return `portal-key-${cookie}`;
    },
    listManaged: async (cookie) => principals.get(cookie) ?? [],
    signIn: async (email) => email,
  };
  let owners = { 'shell-super-app': { BETTER_AUTH_SECRET: 'auth' } };
  const store = { list: async () => [{ content: JSON.stringify(owners), id: 'o', key: 'ONTOS_OWNER_SECRETS_JSON' }] };
  const persist = async (credentials) => {
    owners = { ...owners, 'commerce-customer-context': { COMMERCE_TENANT_CREDENTIALS: JSON.stringify(credentials) } };
  };
  const run = () => ensureCommercePortal({ bundle, config, log: () => {}, persist, shellClient, store });
  await assert.rejects(run(), /HTTP 503/u);
  failOn = undefined;
  const rerun = await run();
  assert.deepEqual(Object.keys(rerun.credentials).sort(), accounts.tenants.map(({ tenantId }) => tenantId).sort());
});

test('storefront keys issued before a failure reach their services', async () => {
  const bundle = parse(bundleValue());
  const shellClient = {
    createServicePrincipal: async () => newId(),
    issueManagedKey: async (cookie, principalId, name) => {
      if (name === 'akros-storefront') throw new Error('Shell answered HTTP 503');
      return `issued-${name}`;
    },
    listManaged: async () => [],
    signIn: async () => 'session',
  };
  const stored = [];
  const store = { create: async (serviceId, key, content) => stored.push([serviceId, key, content]), list: async () => [] };
  const keysDir = mkdtempSync(`${tmpdir()}/gha-keys-`);
  await assert.rejects(ensureStorefrontSecrets({ apply: true, bundle, config, keysDir, log: () => {}, shellClient, store }), /HTTP 503/u);
  assert.deepEqual(stored, [[config.services.shop, 'ONTOS_AKROS_STOREFRONT_API_KEY', 'issued-sroubshop-storefront']]);
});

test('after-app restarts the app even when this run stored nothing new, before the steps that need it', async () => {
  const bundle = parse(bundleValue());
  const calls = [];
  const owners = JSON.stringify({ 'shell-super-app': { BETTER_AUTH_SECRET: 'auth' } });
  const principal = (displayName) => ({ displayName, key: { bindingStatus: 'active' }, kind: 'service', principalId: newId(), principalStatus: 'active' });
  const result = await afterApp({
    apply: true,
    bundle,
    config,
    deps: {
      applySecrets: async () => {
        calls.push('secrets');
        return { changes: [{ action: 'unchanged', key: 'ONTOS_OWNER_SECRETS_JSON', service: 'app' }] };
      },
      assertServices: async () => services('ACTIVE'),
      portalDeployment: () => ({ deployment: {}, verification: {} }),
      remote: (script) => calls.push(script.includes('register-stage-workloads') ? 'workloads' : 'remote'),
      restartApp: async () => calls.push('restart'),
      salesData: () => {
        calls.push('sales');
        return { pending: [] };
      },
      shellClient: {
        listManaged: async (cookie) => [principal('commerce-portal'), principal('sroubshop-storefront'), principal('akros-storefront'), principal('n1-storefront')].filter(() => cookie),
        signIn: async () => 'session',
      },
      store: {
        list: async (serviceId) =>
          serviceId === config.services.app
            ? [{ content: JSON.stringify({ ...JSON.parse(owners), 'commerce-customer-context': { COMMERCE_TENANT_CREDENTIALS: JSON.stringify(Object.fromEntries(accounts.tenants.map(({ tenantId }) => [tenantId, { coreIdentityApiKey: 'k', gatewayApiKey: 'k' }]))) } }), id: 'o', key: 'ONTOS_OWNER_SECRETS_JSON' }]
            : [{ content: 'held', id: 'x', key: serviceId === config.services.n1 ? 'ONTOS_N1_STOREFRONT_API_KEY' : 'ONTOS_AKROS_STOREFRONT_API_KEY' }],
      },
      taxBaseline: ({ mode }) => {
        calls.push(`tax ${mode}`);
        return { fingerprint: 'f' };
      },
      waitForShell: async () => calls.push('shell'),
    },
    log: () => {},
  });
  assert.equal(result.applied, true);
  const at = (step) => calls.indexOf(step);
  assert.ok(at('secrets') < at('workloads') && at('workloads') < at('restart') && at('restart') < at('shell'), calls.join(','));
  assert.ok(at('shell') < at('tax dry-run') && at('tax verify') < at('sales'), calls.join(','));
});
