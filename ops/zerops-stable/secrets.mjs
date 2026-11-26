#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const secret = () => randomBytes(48).toString('base64url');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const root = fileURLToPath(new URL('../../', import.meta.url));

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

/** Generate once. Rerunning init never rotates existing credentials. */
export async function initializeSecrets({ config, generateTls = generateTlsMaterial, output }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ontos-stable-tls-'));
  await chmod(directory, 0o700);
  try {
    const grpc = await generateTls({ directory, name: 'grpc', names: 'DNS:spicedb,DNS:localhost,IP:127.0.0.1' });
    const http = await generateTls({ directory, name: 'http', names: 'DNS:spicedb,DNS:localhost,IP:127.0.0.1' });
    const ownerSecrets = {
      pricing: { ONTOS_PRICING_CONFIRMATION_SIGNING_SECRET: secret() },
      'shell-super-app': { BETTER_AUTH_SECRET: secret() },
    };
    const bundle = {
      projectId: config.projectId,
      schemaVersion: 1,
      services: {
        app: { ONTOS_OWNER_SECRETS_JSON: JSON.stringify(ownerSecrets) },
        migrator: {
          PARTY_REGISTRY_DB_PASSWORD: secret(),
          PARTY_REGISTRY_WORKER_DB_PASSWORD: secret(),
          SHELL_GATEWAY_ISSUER_DB_PASSWORD: secret(),
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

/** apply is explicit; plan is the default. Values never enter arguments or output. */
export async function applySecrets({
  apply = false,
  assertServices,
  bundle,
  config,
  env = process.env,
  runCommand = run,
}) {
  validateSecretBundle(bundle, config);
  const changes = Object.entries(bundle.services).flatMap(([service, variables]) =>
    Object.keys(variables).map((key) => ({ key, service })),
  );
  if (!apply) {return { projectId: config.projectId, applied: false, changes };}
  if (!env.ZEROPS_TOKEN) {throw new Error('ZEROPS_TOKEN is required to apply secrets');}
  await assertServices(config);
  for (const { key, service } of changes) {
    runCommand(
      'bash',
      [
        path.join(root, 'app/scripts/zerops/sync-service-secret.sh'),
        config.services[service],
        key,
        'STABLE_SECRET_VALUE',
      ],
      { cwd: root, env: { ...env, STABLE_SECRET_VALUE: bundle.services[service][key] } },
    );
  }
  return { applied: true, changes, projectId: config.projectId };
}

async function main() {
  const command = process.argv[2];
  if (!command || command === '--help') {
    process.stdout.write(
      'Usage: secrets.mjs init --config FILE --output PRIVATE_FILE\n       secrets.mjs sync --config FILE --file PRIVATE_FILE [--apply]\nNo existing file is overwritten. Add external mail/ERP/storefront credentials to a separate private bundle, then sync it explicitly.\n',
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
    },
    strict: true,
  });
  if (!values.config) {throw new Error('--config is required');}
  const { loadStableConfig } = await import('./config.mjs');
  const config = await loadStableConfig(values.config);
  let result;
  if (command === 'init') {
    if (!values.output || values.file || values.apply)
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
