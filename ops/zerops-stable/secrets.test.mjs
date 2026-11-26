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
} from './secrets.mjs';

const config = {
  projectId: 'stable-project',
  services: { app: 'app-id', migrator: 'migrator-id', spicedb: 'spicedb-id' },
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
    assert.notEqual(a.services.migrator.PARTY_REGISTRY_DB_PASSWORD, b.services.migrator.PARTY_REGISTRY_DB_PASSWORD);
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
    runCommand: () => assert.fail('must not mutate services'),
  });
  assert.equal(result.applied, false);
  assert.deepEqual(result.changes, [{ key: 'SMTP_PASSWORD', service: 'app' }]);
  assert.ok(!JSON.stringify(result).includes('never-log-this'));
});

test('apply proves project ownership first and passes values only through the child environment', async () => {
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
    runCommand: (command, args, options) => {
      assert.equal(calls[0], 'ownership');
      assert.equal(command, 'bash');
      assert.equal(options.env.STABLE_SECRET_VALUE, 'never-log-this');
      assert.ok(!args.join(' ').includes('never-log-this'));
      assert.deepEqual(args.slice(-3), ['app-id', 'SMTP_PASSWORD', 'STABLE_SECRET_VALUE']);
      calls.push('sync');
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
      runCommand: () => assert.fail('must not mutate services'),
    }),
    /wrong project/u,
  );
});
