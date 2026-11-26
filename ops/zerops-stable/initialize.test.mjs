import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  initialize,
  pushSpicedb,
  roleSecretsOf,
  runDatabaseLauncher,
  runSpicedbDatabaseBootstrap,
  stageSpicedbSource,
} from './initialize.mjs';

const config = JSON.parse(readFileSync(new URL('example.config.json', import.meta.url), 'utf8'));
const canonicalZerops = readFileSync(new URL('../../app/zerops.yaml', import.meta.url), 'utf8');
const ROLES = ['shell_gateway_issuer', 'party_registry_runtime', 'party_registry_worker'];
const ADMIN_URL = 'postgresql://db18:admin-secret@db18:5432/db18';
const COMMIT = 'c'.repeat(40);
const bundle = {
  projectId: config.projectId,
  schemaVersion: 1,
  services: {
    migrator: {
      PARTY_REGISTRY_DB_PASSWORD: 'pw-party',
      PARTY_REGISTRY_WORKER_DB_PASSWORD: 'pw-worker',
      SHELL_GATEWAY_ISSUER_DB_PASSWORD: 'pw-issuer',
    },
    spicedb: { SPICEDB_DATABASE_PASSWORD: 'pw-spicedb', SPICEDB_GRPC_PRESHARED_KEY: 'psk' },
  },
};
const stored = (variables) => Object.entries(variables).map(([key, content]) => ({ content, key }));
const freshDatabase = { database: 'db18', marker: null, roles: [], schemas: [], spicedbOwner: null, user: 'db18' };
const marker = `ontos-stable:${config.projectId}`;

/** Every dependency faked; `calls` records each write-capable call. */
const fakes = ({ database = freshDatabase, statuses = {}, userData = bundle.services, env = {} } = {}) => {
  const calls = [];
  const services = Object.fromEntries(
    Object.keys(config.services).map((name) => [name, { status: statuses[name] ?? 'READY_TO_DEPLOY' }]),
  );
  let current = database;
  return {
    calls,
    deps: {
      assertServices: async () => services,
      database: (input) => {
        if (input.mode === 'roles') return { explicitRoles: ROLES };
        if (input.mode === 'inspect') return current;
        calls.push(['database', input]);
        current = { ...current, marker: input.marker, roles: ROLES };
        return current;
      },
      gitShow: (object) =>
        object === `${COMMIT}:app/zerops.yaml` ? Buffer.from(canonicalZerops) : Buffer.from('file'),
      projectEnv: async () =>
        new Map(
          Object.entries({
            db18_dbName: 'db18',
            db18_hostname: 'db18',
            db18_port: '5432',
            db18_superUser: 'db18',
            ...env,
          }),
        ),
      pushSpicedb: (input) => calls.push(['push', input.commit, input.setupYaml]),
      release: () => ({ commit: COMMIT }),
      settledService: async () => ({ status: 'ACTIVE' }),
      spicedbDatabase: (input) => calls.push(['spicedb-database', input]),
      userData: async (serviceId) =>
        stored(serviceId === config.services.migrator ? userData.migrator : userData.spicedb),
    },
  };
};
const run = (deps, apply) =>
  initialize({ adminUrl: ADMIN_URL, apply, bundle, config, deps, tag: 'sales-stable/2026-11-28' });

test('the plan checks everything and writes nothing', async () => {
  const { calls, deps } = fakes();
  const { applied, plan } = await run(deps, false);
  assert.equal(applied, false);
  assert.deepEqual(calls, []);
  assert.equal(plan.database.state, 'fresh');
  assert.deepEqual(plan.database.missingRoles, ROLES);
  assert.equal(plan.spicedbDeploy, true);
  assert.match(plan.next, /deploy\.mjs .*--bootstrap-app/u);
});

test('a refused source revision never reaches service or database initialization', async () => {
  const { calls, deps } = fakes();
  deps.release = () => {
    throw new Error('the checkout differs from the candidate');
  };
  deps.assertServices = async () => {
    calls.push(['services']);
    return {};
  };
  await assert.rejects(run(deps, true), /checkout differs from the candidate/u);
  assert.deepEqual(calls, []);
});

test('apply marks the database, creates the roles with the migrator passwords, then the datastore and spicedb', async () => {
  const { calls, deps } = fakes();
  await run(deps, true);
  assert.deepEqual(
    calls.map(([step]) => step),
    ['database', 'spicedb-database', 'push'],
  );
  const [, database] = calls[0];
  assert.equal(database.marker, marker);
  assert.deepEqual(database.passwords, {
    party_registry_runtime: 'pw-party',
    party_registry_worker: 'pw-worker',
    shell_gateway_issuer: 'pw-issuer',
  });
  assert.deepEqual(calls[1][1], { adminUrl: ADMIN_URL, password: 'pw-spicedb' });
  const [, pushedCommit, setupYaml] = calls[2];
  assert.equal(pushedCommit, COMMIT);
  assert.match(setupYaml, /setup: spicedb/u);
  assert.doesNotMatch(setupYaml, /setup: (app|storefront|n1)/u, 'only the spicedb setup is pushed');
});

test('a rerun on this project marker with spicedb ACTIVE pushes nothing', async () => {
  const { calls, deps } = fakes({
    database: { ...freshDatabase, marker, roles: ROLES, schemas: ['core'], spicedbOwner: 'spicedb' },
    statuses: { spicedb: 'ACTIVE' },
  });
  const { plan } = await run(deps, true);
  assert.equal(plan.database.state, 'initialized');
  assert.deepEqual(plan.database.missingRoles, []);
  assert.deepEqual(
    calls.map(([step]) => step),
    ['database', 'spicedb-database'],
  );
});

test('refusals: a deployed workload, unsynced secrets, another db18, data without the marker, another marker', async () => {
  const cases = [
    [{ statuses: { app: 'ACTIVE' } }, /first install only; app/u],
    [{ statuses: { spicedb: 'STOPPED' } }, /spicedb is STOPPED/u],
    [
      {
        userData: { ...bundle.services, migrator: { ...bundle.services.migrator, PARTY_REGISTRY_DB_PASSWORD: 'old' } },
      },
      /sync --apply/u,
    ],
    [{ env: { db18_hostname: 'db18-other' } }, /host is not the stable/u],
    [{ database: { ...freshDatabase, schemas: ['core', 'party'] } }, /no stable marker/u],
    [{ database: { ...freshDatabase, marker: 'ontos-stable:SomeOtherProject000' } }, /another environment marker/u],
    [{ database: { ...freshDatabase, spicedbOwner: 'postgres' } }, /another owner/u],
    [{ database: { ...freshDatabase, user: 'ontos_runtime' } }, /not the db18 user/u],
  ];
  for (const [options, message] of cases) {
    const { calls, deps } = fakes(options);
    await assert.rejects(run(deps, true), message);
    assert.deepEqual(calls, [], 'a refusal writes nothing');
  }
  const { deps } = fakes();
  await assert.rejects(
    initialize({ adminUrl: 'postgresql://db18@db18:5432/db18', apply: false, bundle, config, deps, tag: 't' }),
    /DATABASE_ADMIN_URL must be/u,
  );
});

test('the canonical setup maps every explicit manifest role to its migrator secret', () => {
  const { explicitRoles } = runDatabaseLauncher({ mode: 'roles' });
  const secrets = roleSecretsOf(canonicalZerops);
  assert.deepEqual([...explicitRoles].sort(), [...secrets.keys()].sort());
  assert.equal(secrets.get('shell_gateway_issuer'), 'SHELL_GATEWAY_ISSUER_DB_PASSWORD');
});

test('secrets reach PostgreSQL steps on stdin or in the child env, never in arguments', () => {
  const seen = [];
  const fakeRun = (command, args, options) => {
    seen.push({ args, options });
    return { status: 0, stdout: '{"ok":true}\n' };
  };
  runDatabaseLauncher({ adminUrl: ADMIN_URL, mode: 'apply', passwords: { a: 'pw-a' } }, { run: fakeRun });
  runSpicedbDatabaseBootstrap({ adminUrl: ADMIN_URL, password: 'pw-spicedb' }, { run: fakeRun });
  assert.ok(seen.every(({ args }) => !args.join(' ').includes('admin-secret') && !args.join(' ').includes('pw-')));
  assert.match(seen[0].options.input, /pw-a/u);
  assert.equal(seen[1].options.env.SPICEDB_DATABASE_PASSWORD, 'pw-spicedb');
  assert.deepEqual(Object.keys(seen[1].options.env).sort(), [
    'DATABASE_ADMIN_URL',
    'PATH',
    'SPICEDB_DATABASE_PASSWORD',
  ]);
});

test('the spicedb source is the tagged files plus its setup, pushed to the configured service', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-initialize-'));
  const setupYaml = canonicalZerops.slice(0, canonicalZerops.indexOf('  - setup: storefront'));
  const shown = [];
  const files = stageSpicedbSource({
    commit: COMMIT,
    directory,
    gitShow: (object) => {
      shown.push(object);
      return Buffer.from(`content of ${object}`);
    },
    setupYaml,
  });
  assert.deepEqual(
    shown,
    files.map((file) => `${COMMIT}:${file}`),
  );
  assert.ok(files.includes('app/scripts/run-zerops-spicedb.sh'));
  assert.equal(statSync(path.join(directory, 'app/scripts/run-zerops-spicedb.sh')).mode & 0o777, 0o755);
  assert.equal(readFileSync(path.join(directory, 'zerops.yaml'), 'utf8'), setupYaml);
  assert.throws(
    () =>
      stageSpicedbSource({
        commit: COMMIT,
        directory,
        gitShow: () => '',
        setupYaml: 'zerops:\n  - setup: spicedb\n    build:\n      buildCommands: [x]\n      deployFiles: [a]\n',
      }),
    /deploy files only/u,
  );
  const pushed = [];
  pushSpicedb(
    { commit: COMMIT, config, directory },
    { run: (command, args) => (pushed.push([command, ...args]), { status: 0 }) },
  );
  assert.deepEqual(pushed[0].slice(0, 7), [
    'zcli',
    'push',
    '--project-id',
    config.projectId,
    '--service-id',
    config.services.spicedb,
    '--setup',
  ]);
  assert.ok(pushed[0].includes('--no-git'));
});
