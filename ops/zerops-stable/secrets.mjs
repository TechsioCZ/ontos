#!/usr/bin/env node
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSecretStore } from './secret-store.mjs';

const secret = () => randomBytes(48).toString('base64url');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'ignore'], ...options });
  if (result.error || result.status !== 0)
    {throw new Error(`${path.basename(command)} failed; no secret values were logged`);}
}

export async function generateTlsMaterial({ directory, name, names, runCommand = run }) {
  const key = path.join(directory, `${name}.key`);
  const certificate = path.join(directory, `${name}.crt`);
  runCommand('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-pkeyopt',
    'ec_param_enc:named_curve',
    '-nodes',
    '-days',
    '3650',
    '-subj',
    '/CN=spicedb',
    '-addext',
    `subjectAltName=${names}`,
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-keyout',
    key,
    '-out',
    certificate,
  ]);
  return { certificate: await readFile(certificate, 'utf8'), key: await readFile(key, 'utf8') };
}

/** The owners that verify Shell gateway assertions; each holds the Shell's public gateway JWKS. */
export const GATEWAY_VERIFYING_OWNERS = Object.freeze([
  'assortment', 'catalog', 'commerce-customer-context', 'commerce-market-catalog', 'crm', 'crm-activities',
  'facility-operations', 'finance-billing', 'inventory', 'legal-agreements', 'merchandise', 'party-registry',
  'payment-term-catalog', 'price-group-catalog', 'pricing', 'privacy', 'property-leasing', 'property-portfolio',
  'sales-insights', 'sales-pipeline', 'storefront-registry', 'tagging', 'tax', 'work-tasks', 'workforce',
]);

/** The Shell's Ed25519 gateway signing key and the public JWKS its verifying owners read. */
export function gatewayKeySecrets() {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const kid = randomUUID();
  const privateJwk = { alg: 'EdDSA', crv: 'Ed25519', d: jwk.d, kid, kty: 'OKP', use: 'sig', x: jwk.x };
  const jwks = JSON.stringify({ keys: [{ alg: 'EdDSA', crv: 'Ed25519', key_ops: ['verify'], kid, kty: 'OKP', use: 'sig', x: jwk.x }] });
  return {
    shell: { ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify(privateJwk) },
    owners: Object.fromEntries(GATEWAY_VERIFYING_OWNERS.map((owner) => [owner, { ONTOS_GATEWAY_PUBLIC_JWKS: jwks }])),
  };
}

/** Generate once. Rerunning init never rotates existing credentials. */
export async function initializeSecrets({ config, generateTls = generateTlsMaterial, output }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ontos-stable-tls-'));
  await chmod(directory, 0o700);
  try {
    const grpc = await generateTls({ directory, name: 'grpc', names: 'DNS:spicedb,DNS:localhost,IP:127.0.0.1' });
    const http = await generateTls({ directory, name: 'http', names: 'DNS:spicedb,DNS:localhost,IP:127.0.0.1' });
    const gateway = gatewayKeySecrets();
    const ownerSecrets = {
      ...gateway.owners,
      // The storefront customer realm (sign-in, account read, checkout); without it every shop's account read and order
      // placement fails with a malformed-configuration 500.
      'commerce-customer-context': {
        ...gateway.owners['commerce-customer-context'],
        COMMERCE_PORTAL_AUTH_SECRET: secret(),
      },
      pricing: {
        ...gateway.owners.pricing,
        ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET: secret(),
        ONTOS_PRICING_CONFIRMATION_KEY_REF: `stable-${randomUUID()}`,
        ONTOS_PRICING_CONFIRMATION_KEY_VERSION: '1',
        ONTOS_PRICING_CONFIRMATION_KEY_LINEAGE_REF: `stable-${randomUUID()}`,
      },
      'shell-super-app': { BETTER_AUTH_SECRET: secret(), ONTOS_EMAIL_DISPATCH_SECRET: secret(), ...gateway.shell },
    };
    const bundle = {
      projectId: config.projectId,
      schemaVersion: 1,
      services: {
        app: {
          ONTOS_OWNER_SECRETS_JSON: JSON.stringify(ownerSecrets),
          PARTY_REGISTRY_DATABASE_PASSWORD: secret(),
          PARTY_REGISTRY_WORKER_DATABASE_PASSWORD: secret(),
          SHELL_GATEWAY_ISSUER_DATABASE_PASSWORD: secret(),
        },
        spicedb: {
          SPICEDB_DATABASE_PASSWORD: secret(),
          SPICEDB_GRPC_PRESHARED_KEY: secret(),
          SPICEDB_GRPC_TLS_CERT: grpc.certificate,
          SPICEDB_GRPC_TLS_KEY: grpc.key,
          SPICEDB_HTTP_TLS_CERT: http.certificate,
          SPICEDB_HTTP_TLS_KEY: http.key,
        },
      },
    };
    // The directory may contain other operator files, so never chmod an existing directory.
    await mkdir(path.dirname(output), { mode: 0o700, recursive: true });
    await writeFile(output, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { output, projectId: config.projectId, serviceCount: Object.keys(bundle.services).length };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export function validateSecretBundle(value, config) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.projectId !== config.projectId ||
    !isRecord(value.services)
  ) {
    throw new Error('Secret bundle must name this stable project and schemaVersion 1');
  }
  for (const [service, variables] of Object.entries(value.services)) {
    if (!Object.hasOwn(config.services, service) || !isRecord(variables) || Object.keys(variables).length === 0) {
      throw new Error('Secret bundle contains an unknown service or empty variable set');
    }
    for (const [key, content] of Object.entries(variables)) {
      if (
        !/^[A-Z][A-Z0-9_]*$/u.test(key) ||
        typeof content !== 'string' ||
        content.length === 0 ||
        content.includes('\0')
      ) {
        throw new Error('Secret bundle variable names and values are invalid');
      }
    }
  }
  if (Object.keys(value.services).length === 0) {throw new Error('Secret bundle contains no services');}
  return value;
}

export async function readSecretBundle(file, config) {
  const metadata = await lstat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Secret bundle must be a regular private file (chmod 600), not a symlink');
  }
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    throw new Error('Secret bundle is not valid JSON');
  }
  return validateSecretBundle(value, config);
}

const ownerRecord = (encoded) => {
  let owners;
  try { owners = JSON.parse(encoded); } catch { throw new Error('Owner secret envelope must be JSON'); }
  if (!isRecord(owners) || Object.entries(owners).some(([owner, values]) =>
    !/^[a-z][a-z0-9-]*$/u.test(owner) || !isRecord(values) ||
    Object.entries(values).some(([key, value]) => !/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== 'string' || !value))) {
    throw new Error('Owner secret envelope must map owner IDs to non-empty string settings');
  }
  return owners;
};
const sortedOwnerJson = (owners) => JSON.stringify(Object.fromEntries(
  Object.entries(owners).sort(([a], [b]) => a.localeCompare(b)).map(([owner, values]) =>
    [owner, Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))]),
));

/** Extending an owner never discards another owner's settings or an existing auth secret. */
export const mergeOwnerSecrets = (previous, desired) => {
  const existing = previous === undefined ? {} : ownerRecord(previous);
  const additions = ownerRecord(desired);
  const merged = Object.fromEntries(Object.entries(existing).map(([owner, values]) => [owner, { ...values }]));
  for (const [owner, values] of Object.entries(additions)) merged[owner] = { ...merged[owner], ...values };
  return sortedOwnerJson(merged);
};

/** apply is explicit; existing values need a separate replacement confirmation. */
export async function applySecrets({
  apply = false,
  assertServices,
  bundle,
  config,
  env = process.env,
  store,
  confirmRotation = false,
}) {
  validateSecretBundle(bundle, config);
  const desired = Object.entries(bundle.services).flatMap(([service, variables]) =>
    Object.entries(variables).map(([key, content]) => ({ key, service, content })),
  );
  const connected = store ?? (env.ZEROPS_TOKEN ? createSecretStore({ token: env.ZEROPS_TOKEN }) : undefined);
  if (connected === undefined) {
    if (apply) throw new Error('ZEROPS_TOKEN is required to apply secrets');
    return {
      projectId: config.projectId, applied: false,
      changes: desired.map(({ key, service }) => ({ key, service, action: 'not-inspected' })),
    };
  }
  await assertServices(config);
  const lists = new Map();
  const operations = [];
  for (const entry of desired) {
    const serviceId = config.services[entry.service];
    if (!lists.has(serviceId)) lists.set(serviceId, await connected.list(serviceId));
    const matches = lists.get(serviceId).filter(({ key }) => key === entry.key);
    if (matches.length > 1) throw new Error(`Multiple live entries for ${entry.service}.${entry.key}; resolve explicitly`);
    const previous = matches[0];
    const content = entry.key === 'ONTOS_OWNER_SECRETS_JSON'
      ? mergeOwnerSecrets(previous?.content, entry.content) : entry.content;
    const previousContent = previous && entry.key === 'ONTOS_OWNER_SECRETS_JSON'
      ? sortedOwnerJson(ownerRecord(previous.content)) : previous?.content;
    const action = previous === undefined ? 'create' : previousContent === content ? 'unchanged' : 'replace';
    operations.push({ ...entry, serviceId, previous, content, action });
  }
  const changes = operations.map(({ key, service, action }) => ({ key, service, action }));
  if (!apply) return { projectId: config.projectId, applied: false, changes };
  if (!confirmRotation && operations.some(({ action }) => action === 'replace')) {
    throw new Error('Existing secrets would change; review the plan and pass --confirm-rotation explicitly');
  }
  for (const operation of operations) {
    if (operation.action === 'unchanged') continue;
    const { serviceId, key, content, previous } = operation;
    // All changes were inspected before the first mutation. Refuse a concurrent writer too.
    const current = (await connected.list(serviceId)).filter((entry) => entry.key === key);
    if (previous === undefined ? current.length !== 0 :
      current.length !== 1 || current[0].id !== previous.id || current[0].content !== previous.content) {
      throw new Error('Live secrets changed during planning; inspect again before applying');
    }
    if (previous !== undefined) await connected.remove(previous.id);
    try {
      await connected.create(serviceId, key, content);
    } catch {
      if (previous !== undefined) {
        try { await connected.create(serviceId, key, previous.content); }
        catch { throw new Error(`Secret replacement and recovery failed for ${operation.service}.${key}; keep the environment closed`); }
        throw new Error(`Secret replacement failed for ${operation.service}.${key}; the previous value was restored`);
      }
      throw new Error(`Secret creation failed for ${operation.service}.${key}`);
    }
  }
  return { applied: true, changes, projectId: config.projectId };
}

async function main() {
  const command = process.argv[2];
  if (!command || command === '--help') {
    process.stdout.write(
      'Usage: secrets.mjs init --config FILE --output PRIVATE_FILE\n       secrets.mjs sync --config FILE --file PRIVATE_FILE [--apply] [--confirm-rotation]\nInit never overwrites files. Sync merges owner settings without discarding prior keys. Replacing any existing value requires explicit --confirm-rotation after reviewing the plan.\n',
    );
    return;
  }
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      config: { type: 'string' },
      output: { type: 'string' },
      file: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'confirm-rotation': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.config) {throw new Error('--config is required');}
  const { loadStableConfig } = await import('./config.mjs');
  const config = await loadStableConfig(values.config);
  let result;
  if (command === 'init') {
    if (!values.output || values.file || values.apply || values['confirm-rotation'])
      {throw new Error('init requires --output and does not accept --file or --apply');}
    result = await initializeSecrets({ config, output: path.resolve(values.output) });
  } else if (command === 'sync') {
    if (!values.file || values.output) {throw new Error('sync requires --file and does not accept --output');}
    const { assertProjectServices } = await import('./maintenance.mjs');
    result = await applySecrets({
      apply: values.apply,
      assertServices: assertProjectServices,
      bundle: await readSecretBundle(values.file, config),
      config,
      confirmRotation: values['confirm-rotation'],
    });
  } else {throw new Error('Unknown secrets command; use --help');}
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    process.stderr.write(`Stable secrets: ${error.message}\n`);
    process.exitCode = 1;
  });
}
