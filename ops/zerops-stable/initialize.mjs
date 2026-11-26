#!/usr/bin/env node
// The first install of a new stable project, before its first app deploy: the database identities the app's
// migrator only reconciles, the SpiceDB datastore, and the SpiceDB service itself.
//
//   ZEROPS_TOKEN=… DATABASE_ADMIN_URL=… node ops/zerops-stable/initialize.mjs --config stable.json \
//       --secrets PRIVATE_BUNDLE --tag sales-stable/YYYY-MM-DD [--apply]
//
// Run it from a host on the stable project's VPN (`zcli vpn up --project-id <projectId>`), logged in with
// `zcli login`, after `secrets.mjs sync --apply` stored the bundle on the project. DATABASE_ADMIN_URL is the db18
// superuser URL of the stable project (its access details in Zerops).
//
// Why a separate step: on every start the app runs `scripts/postgres/bootstrap-runtime-role.mts` in `reconcile`
// mode, which refuses unless every explicit login of `DATABASE_ROLE_GRANT_MANIFEST` already exists and authenticates
// (it never creates one or sets its password; `initialize-local` is loopback-only and stays so). SpiceDB needs its
// `spicedb` database before its own start, and the app needs a running SpiceDB to publish. This command closes that
// loop once, with the repository's own primitives and the project's fresh secrets:
//
//   1. Zerops: the project is not the demo, every configured service is its own, no workload was ever deployed, and
//      the migrator and spicedb secrets stored on Zerops equal the bundle (compared, never printed).
//   2. Database: DATABASE_ADMIN_URL names the project's db18 (host, port, database and superuser of its env), and the
//      cluster is either fresh (no application schema, no marker) or marked as this project's. On apply the database
//      comment becomes the marker `ontos-stable:<projectId>`, so a VPN pointed at another project's db18 is refused.
//   3. On apply, in one transaction: `ensureDatabaseLoginRole` (scripts/postgres/database-login-roles.mts) for each
//      explicit manifest role with the password of the migrator secret its URL names in app/zerops.yaml; then
//      `scripts/postgres/bootstrap-spicedb-database.mts` with SPICEDB_DATABASE_PASSWORD. Both create only what is
//      missing and set the given passwords; neither drops, truncates or resets data. Grants stay the migrator's.
//   4. On apply, unless spicedb is already ACTIVE: `zcli push` of the tag's spicedb snapshot (its deployFiles from
//      `git show <commit>:…` and the materialized stable spicedb setup as zerops.yaml), then waits until ACTIVE.
//
// It deploys no app or front: the next step is `deploy.mjs install`, whose first install deploys the app alone.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { parse: parseYaml } = createRequire(new URL('../../app/package.json', import.meta.url))('yaml');

import { loadStableConfig } from './config.mjs';
import { materializeStableZerops, ZEROPS_BUILD_FILE_LIMIT_BYTES } from './materialize.mjs';
import { assertCleanCheckoutAt, inspectDeployableRelease } from './release.mjs';
import { readSecretBundle } from './secrets.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const APP_ROOT = path.join(REPO_ROOT, 'app');
/** Services the first install deploys later (deploy.mjs); none may hold a deploy yet. */
export const LATER_WORKLOADS = Object.freeze(['app', 'storefront', 'shop', 'n1']);
/** A Zerops service created by the import and never deployed. */
export const NEVER_DEPLOYED = 'READY_TO_DEPLOY';
export const SPICEDB_DATABASE_SCRIPT = 'scripts/postgres/bootstrap-spicedb-database.mts';

export class InitializationError extends Error {
  name = 'InitializationError';
}

const fail = (message) => {
  throw new InitializationError(message);
};

export const projectMarker = (config) => `ontos-stable:${config.projectId}`;

/**
 * Each explicit login role and the migrator secret holding its password, as the app setup's database URLs name them
 * (`postgresql://<role>:${migrator_<KEY>}@…` in app/zerops.yaml), so the password set here is the one the app uses.
 */
export const roleSecretsOf = (zeropsYamlText) => {
  const app = parseYaml(zeropsYamlText)?.zerops?.find((entry) => entry.setup === 'app');
  const roles = new Map();
  for (const value of Object.values(app?.run?.envVariables ?? {})) {
    const match = /^postgresql:\/\/([a-z_]+):\$\{migrator_([A-Z][A-Z0-9_]*)\}@/u.exec(String(value));
    if (match === null) continue;
    const [, role, key] = match;
    if (roles.has(role) && roles.get(role) !== key) fail(`app/zerops.yaml gives ${role} two migrator secrets`);
    roles.set(role, key);
  }
  return roles;
};

/** The administrative URL's parts; it must be a postgresql URL with a user, password and database. */
export const parseAdminUrl = (value) => {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    fail('DATABASE_ADMIN_URL is required: the stable db18 superuser URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.username === '' ||
    url.password === '' ||
    database === ''
  ) {
    fail('DATABASE_ADMIN_URL must be postgresql://<user>:<password>@<host>:<port>/<database>');
  }
  if (
    [...url.searchParams.keys()].some((key) =>
      ['host', 'hostaddr', 'port', 'user', 'dbname', 'database', 'db'].includes(key),
    )
  ) {
    fail('DATABASE_ADMIN_URL must not override its host, port, user or database in the query');
  }
  return { database, host: url.hostname, port: url.port || '5432', user: decodeURIComponent(url.username) };
};

/** The URL must name exactly the project's db18: its env (`db18_hostname`, `_port`, `_dbName`, `_superUser`). */
export const assertAdminUrlOfProject = (admin, env) => {
  const expected = {
    database: env.get('db18_dbName'),
    host: env.get('db18_hostname'),
    port: env.get('db18_port'),
    user: env.get('db18_superUser'),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined || value === '') fail(`the stable project env has no db18 ${key}`);
    if (admin[key] !== value) fail(`DATABASE_ADMIN_URL ${key} is not the stable project's db18 ${key}`);
  }
};

/** Every bundle secret of `services` must be stored on Zerops exactly once, with the same value. */
export const assertSecretsStored = (bundle, stored, services) => {
  for (const service of services) {
    const variables = bundle.services[service];
    if (variables === undefined) fail(`the secret bundle has no ${service} secrets`);
    const entries = stored[service];
    for (const [key, value] of Object.entries(variables)) {
      const matches = entries.filter((entry) => entry.key === key);
      if (matches.length !== 1 || matches[0].content !== value) {
        fail(`${service} ${key} on Zerops is not the bundle's; run secrets.mjs sync --apply first`);
      }
    }
  }
};

/** Never-deployed workloads, and whether spicedb still needs its deploy. */
export const assertFirstInstall = (services) => {
  const deployed = LATER_WORKLOADS.filter((name) => services[name].status !== NEVER_DEPLOYED);
  if (deployed.length > 0) {
    fail(`initialize is the first install only; ${deployed.join(', ')} already deployed`);
  }
  const { status } = services.spicedb;
  if (status === NEVER_DEPLOYED) return { spicedbDeploy: true };
  if (status === 'ACTIVE') return { spicedbDeploy: false };
  return fail(`spicedb is ${status}; it must be never deployed or ACTIVE`);
};

/**
 * The database decision. `fresh`: no marker and no schema but the defaults, so nothing can be lost. `initialized`:
 * this project's marker. Anything else (another marker, or application schemas without the marker) is refused.
 */
export const classifyDatabase = (inspection, { admin, explicitRoles, marker }) => {
  if (inspection.database !== admin.database || inspection.user !== admin.user) {
    fail('the administrative session is not the db18 user and database DATABASE_ADMIN_URL names');
  }
  let state;
  if (inspection.marker === marker) state = 'initialized';
  else if (inspection.marker === null && inspection.schemas.length === 0) state = 'fresh';
  else if (inspection.marker === null)
    fail(`db18 holds schemas (${inspection.schemas.join(', ')}) and no stable marker; refusing`);
  else fail('db18 carries another environment marker; refusing');
  if (inspection.spicedbOwner !== null && inspection.spicedbOwner !== 'spicedb') {
    fail('the spicedb database exists with another owner; refusing');
  }
  return {
    missingRoles: explicitRoles.filter((role) => !inspection.roles.includes(role)),
    spicedbDatabase: inspection.spicedbOwner === null ? 'create' : 'present',
    state,
  };
};

/**
 * Runs in the app workspace (its node_modules), importing the repository's own role manifest and login-role writer.
 * stdin: `{ mode: 'roles' | 'inspect' | 'apply', adminUrl?, marker?, passwords? }`; stdout: one JSON line without
 * secrets. Driver errors are replaced by a fixed message: they may echo password-bearing SQL.
 */
export const DATABASE_LAUNCHER = `
import { DATABASE_ROLE_GRANT_MANIFEST } from './scripts/postgres/database-role-manifest.mts';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const explicitRoles = DATABASE_ROLE_GRANT_MANIFEST.filter((entry) => entry.kind === 'explicit').map((entry) => entry.identity.role);
if (input.mode === 'roles') {
  process.stdout.write(JSON.stringify({ explicitRoles }) + '\\n');
  process.exit(0);
}
const { ensureDatabaseLoginRole } = await import('./scripts/postgres/database-login-roles.mts');
const { PgClient } = await import('@effect/sql-pg');
const { Cause, Effect, Exit, Redacted } = await import('effect');
const { Reactivity } = await import('effect/reactivity');
const refuse = (refusal) => Effect.fail({ refusal });
const inspect = (client) => Effect.gen(function* () {
  const [session] = yield* client.unsafe("select current_database() as database, session_user as user, pg_catalog.shobj_description(d.oid, 'pg_database') as marker from pg_catalog.pg_database d where d.datname = current_database()");
  const schemas = yield* client.unsafe("select nspname from pg_catalog.pg_namespace where nspname not in ('public', 'information_schema') and nspname not like 'pg\\\\_%' order by nspname");
  const roles = yield* client.unsafe('select rolname from pg_catalog.pg_roles order by rolname');
  const spicedb = yield* client.unsafe("select pg_catalog.pg_get_userbyid(datdba) as owner from pg_catalog.pg_database where datname = 'spicedb'");
  return {
    database: session.database,
    marker: session.marker ?? null,
    roles: roles.map(({ rolname }) => rolname).filter((role) => explicitRoles.includes(role)),
    schemas: schemas.map(({ nspname }) => nspname),
    spicedbOwner: spicedb[0]?.owner ?? null,
    user: session.user,
  };
});
const program = Effect.gen(function* () {
  const client = yield* PgClient.makeClient({ url: Redacted.make(input.adminUrl) });
  const before = yield* inspect(client);
  if (input.mode === 'inspect') return before;
  const fresh = before.marker === null && before.schemas.length === 0;
  if (before.marker !== input.marker && !fresh) return yield* refuse('the database is neither fresh nor this project');
  for (const role of explicitRoles) {
    if (typeof input.passwords?.[role] !== 'string') return yield* refuse('a password is missing for ' + role);
  }
  yield* Effect.gen(function* () {
    if (before.marker === null) {
      const literal = "'" + input.marker.replaceAll("'", "''") + "'";
      const database = '"' + before.database.replaceAll('"', '""') + '"';
      yield* client.unsafe('comment on database ' + database + ' is ' + literal);
    }
    for (const role of explicitRoles) {
      yield* ensureDatabaseLoginRole(client, {
        credentials: { kind: 'password', password: Redacted.make(input.passwords[role]) },
        database: before.database,
        role,
      });
    }
  }).pipe(client.withTransaction);
  // Each login must authenticate as itself, as the app's migrator preflight will on its first start.
  for (const role of explicitRoles) {
    const url = new URL(input.adminUrl);
    url.username = encodeURIComponent(role);
    url.password = encodeURIComponent(input.passwords[role]);
    const login = yield* PgClient.makeClient({ connectTimeout: '10 seconds', url: Redacted.make(url.href) }).pipe(
      Effect.flatMap((roleClient) => roleClient.unsafe('select current_database() as database, session_user as role')),
      Effect.scoped,
      Effect.mapError((failure) => ({
        refusal: 'the ' + role + ' login does not authenticate after initialization (' + String(failure?.cause?.code ?? failure?._tag ?? 'unknown') + ')',
      })),
    );
    if (login[0]?.database !== before.database || login[0]?.role !== role) {
      return yield* refuse('the ' + role + ' login reads back as another identity');
    }
  }
  return yield* inspect(client);
});
const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(Reactivity.layer)));
if (Exit.isSuccess(exit)) {
  process.stdout.write(JSON.stringify(exit.value) + '\\n');
} else {
  const failure = Cause.squash(exit.cause);
  const refusal = typeof failure?.refusal === 'string' ? failure.refusal : 'a PostgreSQL step failed (driver details withheld)';
  process.stderr.write(refusal + '\\n');
  process.exitCode = 1;
}
`;

/** Runs the launcher in the app workspace; secrets travel on stdin only. */
export const runDatabaseLauncher = (input, { run = spawnSync } = {}) => {
  const result = run(process.execPath, ['--input-type=module', '--no-warnings', '-e', DATABASE_LAUNCHER], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    fail(`database ${input.mode} failed: ${(result.stderr ?? '').trim().split('\n').at(-1) || 'no output'}`);
  }
  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  } catch {
    return fail(`database ${input.mode} printed no result`);
  }
};

/** The repository's SpiceDB datastore bootstrap (role `spicedb`, database `spicedb`), with exactly its two inputs. */
export const runSpicedbDatabaseBootstrap = ({ adminUrl, password }, { run = spawnSync } = {}) => {
  const result = run(process.execPath, [SPICEDB_DATABASE_SCRIPT], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { DATABASE_ADMIN_URL: adminUrl, PATH: process.env.PATH, SPICEDB_DATABASE_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) fail('the SpiceDB database bootstrap failed (see the stable db18 log)');
};

/**
 * The spicedb push source: the materialized stable setup as zerops.yaml and each of its deployFiles read from the
 * tagged commit, never from the working tree.
 */
export const stageSpicedbSource = ({ commit, directory, gitShow, setupYaml }) => {
  if (Buffer.byteLength(setupYaml) >= ZEROPS_BUILD_FILE_LIMIT_BYTES) fail('the spicedb setup exceeds the Zerops limit');
  const setup = parseYaml(setupYaml)?.zerops?.find((entry) => entry.setup === 'spicedb');
  const files = setup?.build?.deployFiles;
  if (!Array.isArray(files) || files.length === 0 || setup.build.buildCommands !== undefined) {
    fail('the spicedb setup must deploy files only');
  }
  for (const file of files) {
    if (path.isAbsolute(file) || file.split('/').includes('..') || file.endsWith('/'))
      fail(`unsupported deployFiles entry ${file}`);
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, gitShow(`${commit}:${file}`), { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
  }
  writeFileSync(path.join(directory, 'zerops.yaml'), setupYaml);
  return files;
};

const gitShowAt = (repoRoot) => (object) => {
  const result = spawnSync('git', ['show', object], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) fail(`git show ${object} failed`);
  return result.stdout;
};

/** `zcli push` of the staged spicedb source to the verified service; zcli waits for the deploy process. */
export const pushSpicedb = ({ commit, config, directory }, { run = spawnSync } = {}) => {
  const args = [
    'push',
    '--project-id',
    config.projectId,
    '--service-id',
    config.services.spicedb,
    '--setup',
    'spicedb',
    '--working-dir',
    directory,
    '--zerops-yaml-path',
    'zerops.yaml',
    '--version-name',
    commit,
    '--no-git',
  ];
  const result = run('zcli', args, { stdio: ['ignore', 2, 2] });
  if (result.error || result.status !== 0) fail('zcli push of spicedb failed');
  return args;
};

/** A service's stored user data (its secrets), as `sync-service-secret.sh` reads them. */
export const readServiceUserData = async (serviceId, { apiUrl, fetchImpl = fetch, token }) => {
  const response = await fetchImpl(
    `${apiUrl}/service-stack/${encodeURIComponent(serviceId)}/user-data?limit=1000&offset=0`,
    { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) fail(`Zerops user data read answered HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.list)) fail('Zerops user data read returned no list');
  return body.list.map(({ content, key }) => ({ content, key }));
};

/**
 * Every read-only check, then (with `apply`) the writes. Dependencies are injected so tests never reach Zerops,
 * PostgreSQL, Git or zcli. Returns the plan that was checked and what was done.
 */
export const initialize = async ({ adminUrl, apply, bundle, config, deps, log = () => {}, tag }) => {
  const release = deps.release(tag);
  const services = await deps.assertServices(config);
  const { spicedbDeploy } = assertFirstInstall(services);
  assertSecretsStored(
    bundle,
    { migrator: await deps.userData(config.services.migrator), spicedb: await deps.userData(config.services.spicedb) },
    ['migrator', 'spicedb'],
  );
  const zeropsYaml = deps.gitShow(`${release.commit}:app/zerops.yaml`).toString('utf8');
  const roleSecrets = roleSecretsOf(zeropsYaml);
  const { explicitRoles } = deps.database({ mode: 'roles' });
  const unmapped = explicitRoles.filter((role) => !roleSecrets.has(role));
  if (unmapped.length > 0 || explicitRoles.length === 0) {
    fail(`app/zerops.yaml names no migrator secret for ${unmapped.join(', ') || 'any explicit role'}`);
  }
  const admin = parseAdminUrl(adminUrl);
  assertAdminUrlOfProject(admin, await deps.projectEnv(config.projectId));
  const marker = projectMarker(config);
  const decision = classifyDatabase(deps.database({ adminUrl, mode: 'inspect' }), { admin, explicitRoles, marker });
  const plan = {
    commit: release.commit,
    database: { ...decision, explicitRoles, marker },
    next: `node ops/zerops-stable/deploy.mjs install --config <stable.json> --tag ${tag} --artifacts <dir> --execute`,
    projectId: config.projectId,
    spicedbDeploy,
  };
  log(
    `stable ${config.projectId} at ${release.commit}: database ${decision.state}, roles to create ${decision.missingRoles.join(', ') || 'none'}, spicedb database ${decision.spicedbDatabase}, spicedb deploy ${spicedbDeploy ? 'needed' : 'done'}`,
  );
  if (!apply) return { applied: false, plan };
  const passwords = Object.fromEntries(
    explicitRoles.map((role) => [
      role,
      bundle.services.migrator[roleSecrets.get(role)] ?? fail(`the bundle has no ${roleSecrets.get(role)}`),
    ]),
  );
  const after = deps.database({ adminUrl, marker, mode: 'apply', passwords });
  if (after.marker !== marker || explicitRoles.some((role) => !after.roles.includes(role))) {
    fail('the database did not read back as initialized');
  }
  deps.spicedbDatabase({
    adminUrl,
    password: bundle.services.spicedb.SPICEDB_DATABASE_PASSWORD ?? fail('the bundle has no SPICEDB_DATABASE_PASSWORD'),
  });
  if (spicedbDeploy) {
    deps.pushSpicedb({ commit: release.commit, setupYaml: spicedbSetupOf(zeropsYaml, config) });
    const settled = await deps.settledService(config.services.spicedb);
    if (settled.status !== 'ACTIVE') fail(`spicedb is ${settled.status} after its deploy`);
  }
  log(`initialized; next: ${plan.next}`);
  return { applied: true, plan };
};

/** The stable spicedb setup materialized from the tagged commit's app/zerops.yaml. */
export const spicedbSetupOf = (zeropsYamlText, config) => {
  const setup = materializeStableZerops(zeropsYamlText, config).setups.find((entry) => entry.setup === 'spicedb');
  return setup?.file ?? fail('the materialized release has no spicedb setup');
};

/** The real dependencies of one run: the Zerops client of maintenance.mjs, Git, the app workspace and zcli. */
export const liveDependencies = async ({ config, token }) => {
  const { assertProjectServices, createZeropsClient, ZEROPS_PUBLIC_API_URL } = await import('./maintenance.mjs');
  const client = createZeropsClient({ token });
  const gitShow = gitShowAt(REPO_ROOT);
  return {
    assertServices: (stable) => assertProjectServices(stable, { client }),
    database: (input) => runDatabaseLauncher(input),
    gitShow,
    projectEnv: (projectId) => client.projectEnvFile(projectId),
    pushSpicedb: ({ commit, setupYaml }) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'ontos-stable-spicedb-'));
      try {
        stageSpicedbSource({ commit, directory, gitShow, setupYaml });
        pushSpicedb({ commit, config, directory });
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    },
    release: (tag) => {
      const release = inspectDeployableRelease({ cwd: REPO_ROOT, tag });
      // Role and datastore bootstraps import this checkout's app source.
      assertCleanCheckoutAt(REPO_ROOT, release.commit);
      return release;
    },
    settledService: (serviceId) => client.settledService(serviceId),
    spicedbDatabase: (input) => runSpicedbDatabaseBootstrap(input),
    userData: (serviceId) => readServiceUserData(serviceId, { apiUrl: ZEROPS_PUBLIC_API_URL, token }),
  };
};

const USAGE =
  'Usage: ZEROPS_TOKEN=… DATABASE_ADMIN_URL=… initialize.mjs --config STABLE.json --secrets PRIVATE_BUNDLE --tag TAG [--apply]';

export const main = async (argv, { env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { default: false, type: 'boolean' },
      config: { type: 'string' },
      secrets: { type: 'string' },
      tag: { type: 'string' },
    },
    strict: true,
  });
  if (!values.config || !values.secrets || !values.tag) fail(USAGE);
  if (!env.ZEROPS_TOKEN) fail('ZEROPS_TOKEN is required (it reads service secrets, so it needs full access)');
  const config = await loadStableConfig(values.config);
  const bundle = await readSecretBundle(values.secrets, config);
  return initialize({
    adminUrl: env.DATABASE_ADMIN_URL,
    apply: values.apply,
    bundle,
    config,
    deps: await liveDependencies({ config, token: env.ZEROPS_TOKEN }),
    log,
    tag: values.tag,
  });
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
