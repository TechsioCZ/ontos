import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import {
  applySecrets,
  generateTlsMaterial,
  initializeSecrets,
  readSecretBundle,
  validateSecretBundle,
  mergeOwnerSecrets,
} from './secrets.mjs';

const config = {
  projectId: 'stable-project',
  services: { app: 'app-id', spicedb: 'spicedb-id' },
};
const tls = async ({ name }) => ({ certificate: `${name}-certificate`, key: `${name}-private-key` });
const bundle = () => ({
  projectId: config.projectId,
  schemaVersion: 1,
  services: { app: { SMTP_PASSWORD: 'never-log-this' } },
});

test('real OpenSSL output is a pinned server certificate with the in-project service name', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stable-tls-test-'));
  try {
    const material = await generateTlsMaterial({
      directory,
      name: 'grpc',
      names: 'DNS:spicedb,DNS:localhost,IP:127.0.0.1',
    });
    const certificate = new X509Certificate(material.certificate);
    assert.equal(certificate.checkHost('spicedb'), 'spicedb');
    assert.equal(certificate.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(certificate.ca, false);
    assert.equal(certificate.checkPrivateKey(createPrivateKey(material.key)), true);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('initialization creates fresh private credentials without overwriting an existing bundle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stable-secrets-test-'));
  try {
    const first = path.join(directory, 'first.json');
    const second = path.join(directory, 'second.json');
    await initializeSecrets({ config, generateTls: tls, output: first });
    await initializeSecrets({ config, generateTls: tls, output: second });
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    const a = await readSecretBundle(first, config);
    const b = await readSecretBundle(second, config);
    assert.notEqual(a.services.app.ONTOS_OWNER_SECRETS_JSON, b.services.app.ONTOS_OWNER_SECRETS_JSON);
    const owners = JSON.parse(a.services.app.ONTOS_OWNER_SECRETS_JSON);
    assert.ok(owners['shell-super-app'].ONTOS_EMAIL_DISPATCH_SECRET.length >= 32);
    for (const key of ['REF', 'VERSION', 'LINEAGE_REF']) assert.ok(owners.pricing[`ONTOS_PRICING_CONFIRMATION_KEY_${key}`]);
    assert.deepEqual(Object.keys(a.services).sort(), ['app', 'spicedb']);
    for (const key of ['PARTY_REGISTRY_DATABASE_PASSWORD', 'PARTY_REGISTRY_WORKER_DATABASE_PASSWORD', 'SHELL_GATEWAY_ISSUER_DATABASE_PASSWORD']) {
      assert.ok(a.services.app[key].length >= 32, key);
      assert.notEqual(a.services.app[key], b.services.app[key]);
    }
    assert.notEqual(a.services.spicedb.SPICEDB_DATABASE_PASSWORD, b.services.spicedb.SPICEDB_DATABASE_PASSWORD);
    const before = await readFile(first, 'utf-8');
    await assert.rejects(initializeSecrets({ config, generateTls: tls, output: first }), { code: 'EEXIST' });
    assert.equal(await readFile(first, 'utf-8'), before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects cross-project and malformed bundles without echoing secret values', () => {
  for (const value of [
    { ...bundle(), projectId: 'demo-project' },
    { ...bundle(), services: { unknown: { TOKEN: 'never-log-this' } } },
    { ...bundle(), services: { migrator: { SHELL_GATEWAY_ISSUER_DATABASE_PASSWORD: 'never-log-this' } } },
    { ...bundle(), services: { app: { TOKEN: '' } } },
    { ...bundle(), services: { app: { 'bad-key': 'never-log-this' } } },
    { ...bundle(), services: {} },
  ]) {
    assert.throws(
      () => validateSecretBundle(value, config),
      (error) => !error.message.includes('never-log-this'),
    );
  }
});

test('private file validation rejects public permissions and symbolic links', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'stable-secrets-test-'));
  try {
    const file = path.join(directory, 'bundle.json');
    await writeFile(file, JSON.stringify(bundle()), { mode: 0o600 });
    await chmod(file, 0o644);
    await assert.rejects(readSecretBundle(file, config), /private file/u);
    await chmod(file, 0o600);
    const link = path.join(directory, 'link.json');
    await symlink(file, link);
    await assert.rejects(readSecretBundle(link, config), /private file/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('default sync plans without touching live services or including values', async () => {
  const result = await applySecrets({
    assertServices: () => assert.fail('must not contact services'),
    bundle: bundle(),
    config,
    env: {},
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.changes, [{ key: 'SMTP_PASSWORD', service: 'app', action: 'not-inspected' }]);
  assert.ok(!JSON.stringify(result).includes('never-log-this'));
});

test('apply proves project ownership before secret inspection and mutation', async () => {
  const calls = [];
  const result = await applySecrets({
    apply: true,
    assertServices: async (value) => {
      assert.equal(value, config);
      calls.push('ownership');
    },
    bundle: bundle(),
    config,
    env: { ZEROPS_TOKEN: 'token' },
    store: {
      list: async (service) => {
        assert.equal(calls[0], 'ownership');
        assert.equal(service, 'app-id');
        return [];
      },
      create: async (service, key, content) => {
        assert.deepEqual([service, key, content], ['app-id', 'SMTP_PASSWORD', 'never-log-this']);
        calls.push('sync');
      },
      remove: () => assert.fail('new value does not delete anything'),
    },
  });
  assert.deepEqual(calls, ['ownership', 'sync']);
  assert.equal(result.applied, true);
});

test('ownership refusal prevents every mutation', async () => {
  await assert.rejects(
    applySecrets({
      apply: true,
      assertServices: async () => {
        throw new Error('wrong project');
      },
      bundle: bundle(),
      config,
      env: { ZEROPS_TOKEN: 'token' },
      store: { list: () => assert.fail('must not inspect another project') },
    }),
    /wrong project/u,
  );
});

test('adding per-tenant commerce credentials preserves generated authentication and other owner settings', () => {
  const original = JSON.stringify({
    'shell-super-app': { BETTER_AUTH_SECRET: 'original-auth', ONTOS_EMAIL_DISPATCH_SECRET: 'original-email' },
    pricing: { ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET: 'original-signing' },
  });
  const addition = JSON.stringify({ 'commerce-customer-context': { COMMERCE_TENANT_CREDENTIALS: '{"tenant":{}}' } });
  const merged = JSON.parse(mergeOwnerSecrets(original, addition));
  assert.deepEqual(merged['shell-super-app'], JSON.parse(original)['shell-super-app']);
  assert.deepEqual(merged.pricing, JSON.parse(original).pricing);
  assert.equal(merged['commerce-customer-context'].COMMERCE_TENANT_CREDENTIALS, '{"tenant":{}}');
});

const liveStore = (content, { failNew = false } = {}) => {
  let current = [{ id: 'existing', key: 'SMTP_PASSWORD', content }];
  const changes = [];
  return {
    changes,
    get current() { return current; },
    list: async () => current.map((entry) => ({ ...entry })),
    remove: async (id) => { changes.push('delete'); current = current.filter((entry) => entry.id !== id); },
    create: async (_service, key, value) => {
      changes.push('create');
      if (failNew && value !== content) throw new Error('provider failed with an untrusted secret body');
      current = [{ id: 'created', key, content: value }];
    },
  };
};

test('storing the app secrets on a project that already holds them changes nothing', async () => {
  const passwords = { PARTY_REGISTRY_DATABASE_PASSWORD: 'party', SHELL_GATEWAY_ISSUER_DATABASE_PASSWORD: 'issuer', SMTP_PASSWORD: 'smtp' };
  const stored = Object.entries(passwords).map(([key, content], index) => ({ content, id: String(index), key }));
  const result = await applySecrets({
    apply: true,
    assertServices: async () => {},
    bundle: { ...bundle(), services: { app: passwords } },
    config,
    store: {
      create: () => assert.fail('nothing is created'),
      list: async () => stored,
      remove: () => assert.fail('nothing is removed'),
    },
  });
  assert.deepEqual(
    result.changes.map(({ action, key, service }) => `${service}.${key} ${action}`),
    Object.keys(passwords).map((key) => `app.${key} unchanged`),
  );
});

test('a second fresh bundle cannot silently rotate any existing live secret', async () => {
  const store = liveStore('old-private-value');
  const input = { config, bundle: bundle(), assertServices: async () => {}, store };
  const plan = await applySecrets(input);
  assert.deepEqual(plan.changes, [{ service: 'app', key: 'SMTP_PASSWORD', action: 'replace' }]);
  await assert.rejects(applySecrets({ ...input, apply: true }), /confirm-rotation/u);
  assert.deepEqual(store.changes, []);
  assert.ok(!JSON.stringify(plan).includes('old-private-value'));
  await applySecrets({ ...input, apply: true, confirmRotation: true });
  assert.equal(store.current[0].content, 'never-log-this');
});

test('a failed explicit replacement restores the old value and still reports failure', async () => {
  const store = liveStore('old-private-value', { failNew: true });
  await assert.rejects(applySecrets({
    config, bundle: bundle(), assertServices: async () => {}, store, apply: true, confirmRotation: true,
  }), /previous value was restored/u);
  assert.equal(store.current[0].content, 'old-private-value');
  assert.deepEqual(store.changes, ['delete', 'create', 'create']);
});
