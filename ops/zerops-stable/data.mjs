// Stable customer data: backup, checksum verification, restore and migration rehearsal for the stable Zerops project.
//
// What a backup holds. db18 is one PostgreSQL 18 cluster with two data sets: the shared application database (every
// owner, the portal realm; its name is the project's `db18_dbName`) and SpiceDB's datastore, the separate `spicedb`
// database owned by the `spicedb` role (app/scripts/spicedb-datastore-uri.sh, scripts/postgres/bootstrap-spicedb-
// database.mts). A backup dumps every non-template database of the cluster except `postgres` (pg_dump custom format),
// and the cluster-wide roles and memberships the dumps reference (names and attributes, never password hashes). Login
// passwords are not backed up: the migrator sets them from the stable services' variables.
//
// Credentials come only from the environment and reach the PostgreSQL tools only through their PG* variables, never an
// argument or a log line:
//   DATABASE_ADMIN_URL             db18 superuser URL to the application database (the `app` variable of that name),
//                                  reached over `zcli vpn up <projectId>`; backup and restore
//   REHEARSAL_DATABASE_ADMIN_URL   superuser URL to a disposable PostgreSQL 18 cluster; rehearse only
//   ZEROPS_TOKEN                   Zerops API token; backup and restore
//   CLOUDFLARE_API_TOKEN, STABLE_EDGE_FILE   the maintenance gate read (maintenance.mjs); backup and restore
//   PG_BIN_DIR                     optional directory of pg_dump, pg_restore and psql (version >= the server's)
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { assertInMaintenance, maintenanceStatus, readPrivateJson, zeropsClientFromEnv } from './maintenance.mjs';

export class DataError extends Error {
  name = 'DataError';
}

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const APP_DIRECTORY = path.join(REPOSITORY_ROOT, 'app');
export const BACKUP_KIND = 'ontos.stable.backup';
export const REHEARSAL_KIND = 'ontos.stable.migration-rehearsal';
/** The SpiceDB datastore database (app/scripts/spicedb-datastore-uri.sh). */
export const SPICEDB_DATABASE = 'spicedb';
const MANIFEST = 'manifest.json';
const ROLES = 'roles.json';
const DATABASE_NAME = /^[A-Za-z_][\w-]{0,62}$/u;
const REVISION = /^[\da-f]{40}$/u;

const sha256Of = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(file)
      .on('data', (chunk) => {
        hash.update(chunk);
        bytes += chunk.length;
      })
      .on('error', reject)
      .on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

/** A PostgreSQL URL split into the parts libpq takes from PG* variables. Only `sslmode` may ride along. */
export const parsePostgresUrl = (value, label) => {
  if (typeof value !== 'string' || value.length === 0) throw new DataError(`${label} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DataError(`${label} is not a URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new DataError(`${label} is not a postgresql:// URL`);
  const extra = [...url.searchParams.keys()].filter((key) => key !== 'sslmode');
  if (extra.length > 0) throw new DataError(`${label} carries unsupported parameters ${extra.join(', ')}`);
  const connection = {
    host: url.hostname.replace(/^\[(.*)\]$/u, '$1'),
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//u, '')),
    sslmode: url.searchParams.get('sslmode') ?? undefined,
  };
  for (const key of ['host', 'user', 'database']) {
    if (connection[key].length === 0) throw new DataError(`${label} has no ${key}`);
  }
  return connection;
};

const connectionUrl = (connection, user, password, database) => {
  const host = connection.host.includes(':') ? `[${connection.host}]` : connection.host;
  const query = connection.sslmode === undefined ? '' : `?sslmode=${encodeURIComponent(connection.sslmode)}`;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${connection.port}/${encodeURIComponent(database)}${query}`;
};

/** The child environment: just enough to find binaries, never this process's environment and its credentials. */
const baseEnvironment = () =>
  Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

const libpqEnvironment = (connection, database = connection.database) => ({
  PGHOST: connection.host,
  PGPORT: connection.port,
  PGUSER: connection.user,
  PGPASSWORD: connection.password,
  PGDATABASE: database,
  PGCONNECT_TIMEOUT: '15',
  PGAPPNAME: 'ontos-stable-data',
  ...(connection.sslmode === undefined ? {} : { PGSSLMODE: connection.sslmode }),
});

/**
 * The PostgreSQL client tools. Each call passes the connection through PG* variables. psql reads its SQL from stdin, so
 * statements (and throwaway rehearsal passwords) never show in a process listing; psql's error text is dropped for
 * statements marked secret, because it echoes the failing statement.
 */
export const createPostgresTools = ({ binDir = process.env.PG_BIN_DIR, stderr = process.stderr } = {}) => {
  const executable = (tool) => (binDir ? path.join(binDir, tool) : tool);
  const run = (tool, args, { connection, database, input, output, secret = false } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(executable(tool), args, {
        env: { ...baseEnvironment(), ...(connection === undefined ? {} : libpqEnvironment(connection, database)) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const hash = createHash('sha256');
      let bytes = 0;
      let text = '';
      let errors = '';
      let sinkDone = Promise.resolve();
      if (output === undefined) {
        child.stdout.on('data', (chunk) => {
          text += chunk.toString('utf8');
        });
      } else {
        const sink = createWriteStream(output, { flags: 'wx', mode: 0o600 });
        sinkDone = new Promise((done, failed) => {
          sink.on('error', failed).on('finish', done);
        });
        child.stdout.on('data', (chunk) => {
          hash.update(chunk);
          bytes += chunk.length;
        });
        child.stdout.pipe(sink);
      }
      child.stderr.on('data', (chunk) => {
        errors += chunk.toString('utf8');
      });
      child.on('error', (error) => reject(new DataError(`${tool} could not start (${error.code ?? error.name}); set PG_BIN_DIR`)));
      child.on('close', (code, signal) => {
        sinkDone.then(
          () => {
            if (code === 0) {
              resolve({ text, sha256: hash.digest('hex'), bytes });
              return;
            }
            if (!secret && errors.length > 0) stderr.write(errors.slice(-4000));
            reject(new DataError(`${tool} failed with ${signal ?? `exit ${String(code)}`}`));
          },
          (error) => reject(new DataError(`writing ${tool} output failed (${error.code ?? error.name})`)),
        );
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });

  return {
    toolMajor: async (tool) => {
      const { text } = await run(tool, ['--version']);
      const major = /\b(\d+)(?:\.\d+)*/u.exec(text)?.[1];
      if (major === undefined) throw new DataError(`${tool} --version printed no version`);
      return Number(major);
    },
    sql: async (connection, sql, { database, secret } = {}) =>
      (await run('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { connection, database, input: sql, secret })).text,
    dump: (connection, database, output) =>
      run('pg_dump', ['--format=custom', '--no-password', '--serializable-deferrable'], { connection, database, output }),
    restore: (connection, file) =>
      run('pg_restore', ['--create', '--exit-on-error', '--no-password', '--dbname=postgres', file], { connection, database: 'postgres' }),
  };
};

const INVENTORY_SQL = `select json_build_object(
  'serverVersionNum', current_setting('server_version_num')::int,
  'systemIdentifier', (select system_identifier::text from pg_control_system()),
  'superuser', (select rolsuper from pg_roles where rolname = current_user),
  'databases', (select coalesce(json_agg(json_build_object('name', datname, 'owner', pg_get_userbyid(datdba)) order by datname), '[]'::json)
    from pg_database where not datistemplate and datname <> 'postgres'),
  'roles', (select coalesce(json_agg(json_build_object('name', rolname, 'superuser', rolsuper, 'inherit', rolinherit, 'login', rolcanlogin) order by rolname), '[]'::json)
    from pg_roles where rolname !~ '^pg_'),
  'memberships', (select coalesce(json_agg(json_build_object('role', pg_get_userbyid(roleid), 'member', pg_get_userbyid(member))
      order by pg_get_userbyid(roleid), pg_get_userbyid(member)), '[]'::json)
    from pg_auth_members where pg_get_userbyid(roleid) !~ '^pg_' and pg_get_userbyid(member) !~ '^pg_')
);`;

/** The cluster's identity, databases and roles, read through one superuser connection. */
export const readInventory = async (pg, connection, label) => {
  let inventory;
  try {
    inventory = JSON.parse((await pg.sql(connection, INVENTORY_SQL)).trim());
  } catch (error) {
    throw error instanceof DataError ? error : new DataError(`${label} inventory is not JSON`);
  }
  if (inventory.superuser !== true) throw new DataError(`${label} must be a superuser connection`);
  return { ...inventory, serverMajor: Math.floor(inventory.serverVersionNum / 10_000) };
};

/** Proves DATABASE_ADMIN_URL addresses this project's db18 (host, port and database name from its project variables). */
const assertProjectDatabase = async (config, client, connection) => {
  const variables = await client.projectEnvFile(config.projectId);
  const [hostname, port, dbName] = ['db18_hostname', 'db18_port', 'db18_dbName'].map((key) => variables.get(key));
  if (!hostname || !port || !dbName) throw new DataError('the stable project variables do not name db18 hostname, port and dbName');
  // zcli vpn resolves a service by its hostname and by <hostname>.zerops.
  if (![hostname, `${hostname}.zerops`].includes(connection.host) || connection.port !== port || connection.database !== dbName) {
    throw new DataError('DATABASE_ADMIN_URL does not address the stable project db18 application database; refusing');
  }
};

const assertPrivate = async (file, label) => {
  const stat = await lstat(file).catch(() => undefined);
  if (stat === undefined) throw new DataError(`${label} is missing`);
  if (stat.isSymbolicLink()) throw new DataError(`${label} is a symbolic link`);
  if ((stat.mode & 0o077) !== 0) throw new DataError(`${label} is readable by others`);
  return stat;
};

/**
 * verifyBackup(directory, { projectId }) → manifest. Checks the kind, schema and project of the manifest, that the
 * directory and every file are private, and every file's byte count and SHA-256. Throws DataError otherwise.
 */
export const verifyBackup = async (directory, { projectId }) => {
  if (!(await assertPrivate(directory, 'backup directory')).isDirectory()) throw new DataError('backup is not a directory');
  await assertPrivate(path.join(directory, MANIFEST), 'backup manifest');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, MANIFEST), 'utf8'));
  } catch {
    throw new DataError('backup manifest is not JSON');
  }
  if (manifest?.kind !== BACKUP_KIND || manifest.schemaVersion !== 1) throw new DataError('backup manifest is not a stable backup manifest');
  if (manifest.projectId !== projectId) throw new DataError('backup belongs to another project; refusing');
  const entries = [...(manifest.databases ?? []), manifest.roles];
  if (!manifest.databases?.some(({ name }) => name === SPICEDB_DATABASE)) throw new DataError('backup has no SpiceDB datastore');
  if (!manifest.databases?.some(({ name }) => name === manifest.applicationDatabase)) throw new DataError('backup has no application database');
  const expected = new Set([MANIFEST]);
  for (const entry of entries) {
    if (typeof entry?.file !== 'string' || !/^[\w.-]+$/u.test(entry.file)) throw new DataError('backup manifest names an invalid file');
    expected.add(entry.file);
    const file = path.join(directory, entry.file);
    await assertPrivate(file, `backup file ${entry.file}`);
    const { sha256, bytes } = await sha256Of(file);
    if (sha256 !== entry.sha256 || bytes !== entry.bytes) throw new DataError(`backup file ${entry.file} does not match its checksum`);
  }
  const unexpected = (await readdir(directory)).filter((name) => !expected.has(name));
  if (unexpected.length > 0) throw new DataError(`backup directory holds unlisted files ${unexpected.join(', ')}`);
  return manifest;
};

/** SHA-256 of the manifest file itself: what evidence binds a backup by. */
export const backupManifestDigest = async (directory) => (await sha256Of(path.join(directory, MANIFEST))).sha256;

const writePrivate = async (file, content) => {
  await writeFile(file, content, { flag: 'wx', mode: 0o600 });
};

/**
 * backupStable({ config, output, sourceRevision, adminUrl, client, cloudflare?, edge?, pg, allowLive?, now?, log? }) → manifest.
 * Requires the stable project in maintenance (gate closed, nothing running) unless `allowLive`, which records
 * `consistency: "live"`. Writes `<output>/manifest.json`, `roles.json` and one `<database>.dump` per database, all 0400
 * in a new 0700 directory, then verifies them.
 */
export const backupStable = async ({ config, output, sourceRevision, adminUrl, client, cloudflare, edge, pg, allowLive = false, now = () => new Date(), log = () => {} }) => {
  if (!REVISION.test(sourceRevision ?? '')) throw new DataError('--source-revision must be the 40-character commit the stable project runs');
  const status = await maintenanceStatus(config, { client, cloudflare, edge });
  if (status.datastores.db18.status !== 'ACTIVE') throw new DataError('db18 is not ACTIVE');
  if (status.state !== 'maintenance' && !allowLive) {
    throw new DataError(`stable project is ${status.state}; back up in maintenance, or pass --allow-live for a live (non-quiesced) copy`);
  }
  const admin = parsePostgresUrl(adminUrl, 'DATABASE_ADMIN_URL');
  await assertProjectDatabase(config, client, admin);
  const inventory = await readInventory(pg, admin, 'DATABASE_ADMIN_URL');
  const names = inventory.databases.map(({ name }) => name);
  for (const required of [admin.database, SPICEDB_DATABASE]) {
    if (!names.includes(required)) throw new DataError(`db18 has no ${required} database`);
  }
  const invalid = names.filter((name) => !DATABASE_NAME.test(name) || name === 'manifest' || name === 'roles');
  if (invalid.length > 0) throw new DataError(`db18 has databases with unsupported names: ${invalid.join(', ')}`);
  if ((await pg.toolMajor('pg_dump')) < inventory.serverMajor) throw new DataError('pg_dump is older than the db18 server');

  await mkdir(path.dirname(output), { recursive: true });
  try {
    await mkdir(output, { mode: 0o700 });
  } catch (error) {
    throw new DataError(error.code === 'EEXIST' ? 'backup output exists; a backup never overwrites' : `cannot create the backup output (${error.code})`);
  }
  await chmod(output, 0o700);
  const startedAt = now().toISOString();
  const databases = [];
  for (const { name, owner } of inventory.databases) {
    log(`dumping database ${name}`);
    const file = `${name}.dump`;
    const { sha256, bytes } = await pg.dump(admin, name, path.join(output, file));
    databases.push({ name, owner, file, sha256, bytes });
  }
  const roles = `${JSON.stringify({ roles: inventory.roles, memberships: inventory.memberships }, null, 2)}\n`;
  await writePrivate(path.join(output, ROLES), roles);
  const manifest = {
    kind: BACKUP_KIND,
    schemaVersion: 1,
    projectId: config.projectId,
    sourceRevision,
    consistency: status.state === 'maintenance' ? 'maintenance' : 'live',
    startedAt,
    createdAt: now().toISOString(),
    server: { major: inventory.serverMajor, versionNum: inventory.serverVersionNum, systemIdentifier: inventory.systemIdentifier },
    applicationDatabase: admin.database,
    databases,
    roles: { file: ROLES, ...(await sha256Of(path.join(output, ROLES))) },
  };
  await writePrivate(path.join(output, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of [MANIFEST, ROLES, ...databases.map((database) => database.file)]) await chmod(path.join(output, file), 0o400);
  return verifyBackup(output, { projectId: config.projectId });
};

/** Creates the backed-up roles a target cluster lacks (NOLOGIN, never elevated) and the missing memberships. */
const ensureRoles = async (pg, connection, backupDirectory, inventory) => {
  const { roles, memberships } = JSON.parse(await readFile(path.join(backupDirectory, ROLES), 'utf8'));
  const existing = new Set(inventory.roles.map(({ name }) => name));
  const granted = new Set(inventory.memberships.map(({ role, member }) => `${role}\0${member}`));
  const statements = [
    ...roles
      .filter(({ name }) => !existing.has(name))
      .map(({ name, inherit }) => `create role ${quoteIdentifier(name)} nologin ${inherit ? 'inherit' : 'noinherit'} nosuperuser nocreatedb nocreaterole noreplication nobypassrls;`),
    ...memberships
      .filter(({ role, member }) => !granted.has(`${role}\0${member}`))
      .map(({ role, member }) => `grant ${quoteIdentifier(role)} to ${quoteIdentifier(member)};`),
  ];
  if (statements.length > 0) await pg.sql(connection, statements.join('\n'), { database: 'postgres' });
  return statements.length;
};

/** Replaces each backed-up database: drop (terminating its sessions), then pg_restore --create from the dump. */
const replaceDatabases = async (pg, connection, backupDirectory, manifest, log) => {
  for (const { name, file } of manifest.databases) {
    log(`replacing database ${name}`);
    await pg.sql(connection, `drop database if exists ${quoteIdentifier(name)} with (force);`, { database: 'postgres' });
    await pg.restore(connection, path.join(backupDirectory, file));
  }
  const after = await readInventory(pg, connection, 'restored cluster');
  for (const { name, owner } of manifest.databases) {
    if (!after.databases.some((database) => database.name === name && database.owner === owner)) {
      throw new DataError(`database ${name} is not back with owner ${owner} after restore`);
    }
  }
};

/**
 * restoreStable({ config, backup, confirmProject, destroyCurrentData, preRestoreOutput, currentRevision, adminUrl,
 * client, cloudflare?, edge?, pg, log? }) → { projectId, backupManifestSha256, preRestoreBackup, state }.
 * Destructive. Needs the project id typed again, the destroy acknowledgement, the project in maintenance, the same db18
 * cluster the backup came from, and first takes a fresh backup of the data it replaces. It then restarts SpiceDB so no
 * cache outlives the restored datastore, and leaves the project in maintenance.
 */
export const restoreStable = async ({ config, backup, confirmProject, destroyCurrentData, preRestoreOutput, currentRevision, adminUrl, client, cloudflare, edge, pg, log = () => {} }) => {
  if (confirmProject !== config.projectId) throw new DataError('restore requires --confirm-project equal to the config projectId');
  if (destroyCurrentData !== true) throw new DataError('restore replaces the stable databases; pass --destroy-current-data to acknowledge');
  if (typeof preRestoreOutput !== 'string') throw new DataError('restore requires --pre-restore-output for the copy of the data it replaces');
  const manifest = await verifyBackup(backup, { projectId: config.projectId });
  await assertInMaintenance(config, { client, cloudflare, edge });
  const admin = parsePostgresUrl(adminUrl, 'DATABASE_ADMIN_URL');
  await assertProjectDatabase(config, client, admin);
  if (manifest.applicationDatabase !== admin.database) throw new DataError('backup application database differs from db18 dbName');
  const inventory = await readInventory(pg, admin, 'DATABASE_ADMIN_URL');
  // SpiceDB's PostgreSQL datastore stores transaction ids; on another cluster restored relationships can read as future
  // writes until `spicedb datastore repair`, which this tool does not run.
  if (inventory.systemIdentifier !== manifest.server.systemIdentifier) {
    throw new DataError('db18 is a different PostgreSQL cluster than the backup source; refusing (SpiceDB transaction ids would not match)');
  }
  if ((await pg.toolMajor('pg_restore')) < manifest.server.major) throw new DataError('pg_restore is older than the backup server');
  log('backing up the current data before replacing it');
  const preRestore = await backupStable({ config, output: preRestoreOutput, sourceRevision: currentRevision, adminUrl, client, cloudflare, edge, pg, log });
  await ensureRoles(pg, admin, backup, await readInventory(pg, admin, 'DATABASE_ADMIN_URL'));
  await replaceDatabases(pg, admin, backup, manifest, log);
  log('restarting spicedb on the restored datastore');
  await client.stopService(config.services.spicedb);
  await client.startService(config.services.spicedb);
  await verifyBackup(backup, { projectId: config.projectId });
  const status = await assertInMaintenance(config, { client, cloudflare, edge });
  return {
    projectId: config.projectId,
    restoredBackup: path.resolve(backup),
    backupManifestSha256: await backupManifestDigest(backup),
    sourceRevision: manifest.sourceRevision,
    preRestoreBackup: path.resolve(preRestoreOutput),
    preRestoreCreatedAt: preRestore.createdAt,
    state: status.state,
  };
};

const sameServer = (left, right) => left.host.toLowerCase() === right.host.toLowerCase() && left.port === right.port;

/** The app's database identities (role and URL variable), from the app's own enrollment. */
export const loadDatabaseIdentities = async (appDirectory = APP_DIRECTORY) => {
  const { DATABASE_IDENTITIES } = await import(pathToFileURL(path.join(appDirectory, 'database/identity-enrollment.ts')).href);
  return DATABASE_IDENTITIES.map(({ role, urlKey }) => ({ role, urlKey }));
};

/** Runs the stable migrator once (app/scripts/run-zerops-migrator.mjs with MIGRATOR_ONCE) and returns its exit code. */
export const runRepositoryMigrator = ({ env, appDirectory = APP_DIRECTORY }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(appDirectory, 'scripts/run-zerops-migrator.mjs')], { cwd: appDirectory, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });

/** The checkout under rehearsal: HEAD, the tag must name it, and the tree must be clean. */
export const readCandidate = (tag, repositoryRoot = REPOSITORY_ROOT) => {
  const git = (...args) => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const commit = git('rev-parse', 'HEAD');
  let tagged;
  try {
    tagged = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  } catch {
    throw new DataError(`tag ${tag} does not exist in this checkout`);
  }
  if (tagged !== commit) throw new DataError(`tag ${tag} does not point at the checked-out commit`);
  if (git('status', '--porcelain', '--untracked-files=no').length > 0) throw new DataError('the checkout has uncommitted changes; rehearse a clean tag checkout');
  return { tag, commit };
};

/**
 * The migrator's environment on the scratch cluster: scratch admin, throwaway passwords for every login role, the
 * portal realm in the shared database as on stable (app/zerops.yaml), ULTRAMODERN_DEPLOYMENT_ENVIRONMENT `stage` as
 * stable materializes it. SPICEDB_ENDPOINT and SPICEDB_PRESHARED_KEY are set empty so the access catalog activation
 * finds no engine (also not one from app/.env), fails its configuration and is reported by the migrator without
 * reaching SpiceDB: the rehearsal covers role bootstrap, every owner migration and schema verification.
 */
const rehearsalEnvironment = (scratch, database, identities, passwords) => {
  const runtime = identities.find(({ urlKey }) => urlKey === 'DATABASE_URL');
  if (runtime === undefined) throw new DataError('the app enrollment has no DATABASE_URL identity');
  const admin = connectionUrl(scratch, scratch.user, scratch.password, database);
  return {
    ...baseEnvironment(),
    NODE_ENV: 'production',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
    MIGRATOR_ONCE: 'true',
    DATABASE_ADMIN_URL: admin,
    ...Object.fromEntries(identities.map(({ role, urlKey }) => [urlKey, connectionUrl(scratch, role, passwords.get(role), database)])),
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: admin,
    COMMERCE_PORTAL_AUTH_DATABASE_URL: connectionUrl(scratch, runtime.role, passwords.get(runtime.role), database),
    SPICEDB_DATABASE_PASSWORD: passwords.get(SPICEDB_DATABASE),
    SPICEDB_ENDPOINT: '',
    SPICEDB_PRESHARED_KEY: '',
  };
};

/**
 * rehearseStable({ config, backup, evidence, scratchAdminUrl, liveAdminUrl?, replaceScratchDatabases, candidate, pg,
 * identities?, runMigrator?, now?, log? }) → evidence object.
 * Restores the verified backup into a disposable cluster (never the backup source cluster or a stable service host),
 * gives every login role a throwaway password there, runs the candidate checkout's migrator against it, re-verifies
 * the backup and writes the evidence file (0400) whatever the verdict. Throws after writing when the migration failed.
 */
export const rehearseStable = async ({
  config,
  backup,
  evidence,
  scratchAdminUrl,
  liveAdminUrl,
  replaceScratchDatabases = false,
  candidate,
  pg,
  identities,
  runMigrator = runRepositoryMigrator,
  now = () => new Date(),
  log = () => {},
}) => {
  if (typeof evidence !== 'string') throw new DataError('rehearse requires --evidence for the rehearsal evidence file');
  const manifest = await verifyBackup(backup, { projectId: config.projectId });
  const backupManifestSha256 = await backupManifestDigest(backup);
  const scratch = parsePostgresUrl(scratchAdminUrl, 'REHEARSAL_DATABASE_ADMIN_URL');
  if (liveAdminUrl !== undefined && liveAdminUrl !== '' && sameServer(scratch, parsePostgresUrl(liveAdminUrl, 'DATABASE_ADMIN_URL'))) {
    throw new DataError('REHEARSAL_DATABASE_ADMIN_URL addresses the DATABASE_ADMIN_URL server; refusing');
  }
  const stableHosts = Object.keys(config.services).flatMap((name) => [name, `${name}.zerops`]);
  if (stableHosts.includes(scratch.host.toLowerCase())) throw new DataError('REHEARSAL_DATABASE_ADMIN_URL addresses a stable project service; refusing');
  const inventory = await readInventory(pg, scratch, 'REHEARSAL_DATABASE_ADMIN_URL');
  if (inventory.systemIdentifier === manifest.server.systemIdentifier) {
    throw new DataError('the scratch cluster is the backup source cluster; refusing');
  }
  if (inventory.serverMajor < manifest.server.major) throw new DataError('the scratch cluster is older than the backup server');
  if ((await pg.toolMajor('pg_restore')) < manifest.server.major) throw new DataError('pg_restore is older than the backup server');
  const present = manifest.databases.filter(({ name }) => inventory.databases.some((database) => database.name === name));
  if (present.length > 0 && !replaceScratchDatabases) {
    throw new DataError(`the scratch cluster already has ${present.map(({ name }) => name).join(', ')}; pass --replace-scratch-databases to drop them`);
  }
  const startedAt = now().toISOString();
  await ensureRoles(pg, scratch, backup, inventory);
  await replaceDatabases(pg, scratch, backup, manifest, log);

  const enrolled = identities ?? (await loadDatabaseIdentities());
  const passwords = new Map([...enrolled.map(({ role }) => role), SPICEDB_DATABASE].map((role) => [role, randomBytes(24).toString('hex')]));
  await pg.sql(
    scratch,
    [...passwords].map(([role, password]) => `alter role ${quoteIdentifier(role)} login password ${quoteLiteral(password)};`).join('\n'),
    { database: 'postgres', secret: true },
  );
  log(`running the ${candidate.commit} migrator against the scratch cluster`);
  const migratorExitCode = await runMigrator({ env: rehearsalEnvironment(scratch, manifest.applicationDatabase, enrolled, passwords) });
  await verifyBackup(backup, { projectId: config.projectId });
  const record = {
    kind: REHEARSAL_KIND,
    schemaVersion: 1,
    tag: candidate.tag,
    commit: candidate.commit,
    sourceProjectId: config.projectId,
    backupManifestSha256,
    backupSourceRevision: manifest.sourceRevision,
    backupTakenAt: manifest.createdAt,
    scratchSystemIdentifier: inventory.systemIdentifier,
    startedAt,
    finishedAt: now().toISOString(),
    migratorExitCode,
    verdict: migratorExitCode === 0 ? 'passed' : 'failed',
  };
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o400 });
  if (migratorExitCode !== 0) {
    throw new DataError(`migration rehearsal failed: the migrator exited ${String(migratorExitCode)}; the backup is unchanged and verified`);
  }
  return record;
};

/**
 * assertRehearsalEvidence(record, { config, backupManifestSha256, tag, commit }) for release tooling: a passed rehearsal
 * of exactly this tag and commit, on this project's backup.
 */
export const assertRehearsalEvidence = (record, { config, backupManifestSha256, tag, commit }) => {
  if (record?.kind !== REHEARSAL_KIND || record.schemaVersion !== 1) throw new DataError('not a stable migration rehearsal record');
  if (record.sourceProjectId !== config.projectId) throw new DataError('rehearsal belongs to another project');
  if (record.tag !== tag || record.commit !== commit) throw new DataError('rehearsal is for another candidate');
  if (record.backupManifestSha256 !== backupManifestSha256) throw new DataError('rehearsal used another backup');
  if (record.verdict !== 'passed' || record.migratorExitCode !== 0) throw new DataError('rehearsal did not pass');
  return record;
};

/** Reads a rehearsal evidence file (private, regular) for assertRehearsalEvidence. */
export const readRehearsalEvidence = (file) => readPrivateJson(file, 'rehearsal evidence');

const USAGE = `Usage:
  data.mjs backup   --config PATH --output DIR --source-revision SHA [--allow-live]
  data.mjs verify   --config PATH --backup DIR
  data.mjs restore  --config PATH --backup DIR --confirm-project PROJECT_ID --destroy-current-data
                    --pre-restore-output DIR --current-revision SHA
  data.mjs rehearse --config PATH --backup DIR --tag TAG --evidence FILE [--replace-scratch-databases]
Environment: DATABASE_ADMIN_URL and ZEROPS_TOKEN (backup, restore); REHEARSAL_DATABASE_ADMIN_URL (rehearse);
PG_BIN_DIR optional. Credentials are never printed.
`;

export const main = async (argv, { env = process.env, client, pg = createPostgresTools({ binDir: env.PG_BIN_DIR }), stdout = process.stdout, stderr = process.stderr } = {}) => {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help') {
    stdout.write(USAGE);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      config: { type: 'string' },
      output: { type: 'string' },
      backup: { type: 'string' },
      evidence: { type: 'string' },
      tag: { type: 'string' },
      'source-revision': { type: 'string' },
      'current-revision': { type: 'string' },
      'confirm-project': { type: 'string' },
      'pre-restore-output': { type: 'string' },
      'allow-live': { type: 'boolean', default: false },
      'destroy-current-data': { type: 'boolean', default: false },
      'replace-scratch-databases': { type: 'boolean', default: false },
    },
  });
  if (values.config === undefined) throw new DataError('--config is required');
  const { loadStableConfig } = await import('./config.mjs');
  const config = await loadStableConfig(values.config);
  const log = (line) => stderr.write(`[data] ${line}\n`);
  const resolved = (key) => (values[key] === undefined ? undefined : path.resolve(values[key]));
  const need = (key) => {
    if (values[key] === undefined) throw new DataError(`${command} requires --${key}`);
    return resolved(key);
  };
  let result;
  if (command === 'backup') {
    result = await backupStable({
      config, output: need('output'), sourceRevision: values['source-revision'], allowLive: values['allow-live'],
      adminUrl: env.DATABASE_ADMIN_URL, client: client ?? zeropsClientFromEnv(env), pg, log,
    });
  } else if (command === 'verify') {
    const backup = need('backup');
    result = { ...(await verifyBackup(backup, { projectId: config.projectId })), manifestSha256: await backupManifestDigest(backup) };
  } else if (command === 'restore') {
    result = await restoreStable({
      config, backup: need('backup'), confirmProject: values['confirm-project'], destroyCurrentData: values['destroy-current-data'],
      preRestoreOutput: need('pre-restore-output'), currentRevision: values['current-revision'],
      adminUrl: env.DATABASE_ADMIN_URL, client: client ?? zeropsClientFromEnv(env), pg, log,
    });
  } else if (command === 'rehearse') {
    if (values.tag === undefined) throw new DataError('rehearse requires --tag');
    result = await rehearseStable({
      config, backup: need('backup'), evidence: need('evidence'), scratchAdminUrl: env.REHEARSAL_DATABASE_ADMIN_URL,
      liveAdminUrl: env.DATABASE_ADMIN_URL, replaceScratchDatabases: values['replace-scratch-databases'],
      candidate: readCandidate(values.tag), pg, log,
    });
  } else throw new DataError(`unknown command ${command}; use --help`);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Stable data: ${error.message}\n`);
    process.exitCode = 1;
  });
}
