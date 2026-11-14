import { createHash } from 'node:crypto';
import path from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';

import {
  COMMERCE_URL_KEY,
  DatabaseEvidence,
  REGENERATE_SEAL_SQL,
  SEAL_TABLE,
  SeedDatabase,
  SeedJournal,
  SeedMembership,
  SeedRole,
  SeedSetting,
  assertDatabaseEvidence,
  quoteIdentifier,
  quoteLiteral,
  schemaFingerprint,
  seedFailure,
} from './integration-seed-model.mts';
import type { SeedManifest } from './integration-seed-model.mts';
import { postgresCommand, requiredEnvironment, runSeedCommand, seedSql } from './integration-seed-process.mts';

const MAINTENANCE_DB = 'template1';
const PG_SERVICE = 'ontos-db';
const USERNAME_FLAG = '--username';
const DATABASE_FLAG = '--dbname';
const CREATE_FLAG = '--create';
const POSTGRES_USER_KEY = 'POSTGRES_USER';
const ROLES_QUERY = `select coalesce(json_agg(r order by name), '[]') from (
  select rolname as name, rolsuper as superuser, rolinherit as inherit, rolcreaterole as "createRole",
    rolcreatedb as "createDb", rolcanlogin as login, rolreplication as replication, rolbypassrls as "bypassRls",
    rolconnlimit as "connectionLimit", rolvaliduntil::text as "validUntil"
  from pg_roles where rolname !~ '^pg_') r`;
const MEMBERS_QUERY = `select coalesce(json_agg(m order by role, member, grantor), '[]') from (
  select pg_get_userbyid(roleid) as role, pg_get_userbyid(member) as member,
    pg_get_userbyid(grantor) as grantor, admin_option as admin, inherit_option as inherit, set_option as "set"
  from pg_auth_members) m`;
const SETTINGS_QUERY = `select coalesce(json_agg(s order by role, database, value), '[]') from (
  select case when setrole = 0 then null else pg_get_userbyid(setrole) end as role,
    (select datname from pg_database where oid = setdatabase) as database, unnest(setconfig) as value
  from pg_db_role_setting) s`;
const DATABASES_QUERY = `select coalesce(json_agg(datname order by datname), '[]')
  from pg_database where not datistemplate`;
const TABLES_QUERY = `select coalesce(json_agg(format('%I.%I', n.nspname, c.relname) order by n.nspname, c.relname), '[]')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'drizzle' and c.relkind = 'r'`;
const SAFE_SETTING =
  /^(?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|search_path|default_transaction_read_only|work_mem|maintenance_work_mem|temp_file_limit|row_security|log_parameter_max_length|log_parameter_max_length_on_error)=/u;

/** Exclude all generated key data; refuse any other credential-bearing row, rather than silently losing state. */
export const SECRET_AUDIT_SQL = `DO $$ DECLARE c record; present boolean; BEGIN
  FOR c IN select table_schema, table_name, column_name from information_schema.columns
    where table_schema not in ('information_schema', 'pg_catalog') and table_schema !~ '^pg_'
      and not (table_schema = 'trust' and table_name = 'scope_sealing_keys')
      and (column_name ~* '(password|secret|token|private_key|inner_pad|outer_pad|credential|api_key|assertion_digest)'
        or table_schema in ('auth', 'commerce_auth') or table_name ~* '(secret|credential|key_material|signing_key|jwks)')
  LOOP
    EXECUTE format('select exists(select 1 from %I.%I where %I is not null)', c.table_schema, c.table_name, c.column_name) INTO present;
    IF present THEN RAISE EXCEPTION 'Credential-bearing seed row is forbidden in %.%', c.table_schema, c.table_name; END IF;
  END LOOP;
END $$;`;

const queryJson = <A, I>(database: string, query: string, schema: Schema.Codec<A, I>) =>
  seedSql(database, query).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    Effect.mapError(() => seedFailure('PostgreSQL seed catalog did not match its JSON schema')),
  );

export const readRoles = () => queryJson(MAINTENANCE_DB, ROLES_QUERY, Schema.Array(SeedRole));
export const readMemberships = () => queryJson(MAINTENANCE_DB, MEMBERS_QUERY, Schema.Array(SeedMembership));
export const readSettings = () => queryJson(MAINTENANCE_DB, SETTINGS_QUERY, Schema.Array(SeedSetting));
export const readDatabases = () => queryJson(MAINTENANCE_DB, DATABASES_QUERY, Schema.Array(Schema.String));

export const assertDatabaseNames = (names: readonly string[]) =>
  Effect.gen(function* validateDatabaseInventory() {
    const primary = yield* requiredEnvironment('POSTGRES_DB');
    const expected = [primary, 'postgres', 'spicedb'];
    if (
      new Set(expected).size !== expected.length ||
      names.length !== expected.length ||
      names.some((name) => !expected.includes(name))
    ) {
      return yield* seedFailure(
        'Seed requires exactly POSTGRES_DB, postgres and spicedb; unexpected/missing database refused',
      );
    }
    return yield* Effect.void;
  });

export const databaseEvidence = (database: string) =>
  Effect.gen(function* readDatabaseEvidence() {
    const user = yield* requiredEnvironment(POSTGRES_USER_KEY);
    const schema = yield* postgresCommand('pg_dump', [
      USERNAME_FLAG,
      user,
      DATABASE_FLAG,
      database,
      '--schema-only',
      CREATE_FLAG,
    ]);
    const tables = yield* queryJson(database, TABLES_QUERY, Schema.Array(Schema.String));
    const queries = tables.map(
      (table) => `select ${quoteLiteral(table)} as "table", count(*)::int as rows from ${table}`,
    );
    const journals =
      queries.length === 0
        ? []
        : yield* queryJson(
            database,
            `select json_agg(j order by "table") from (${queries.join(' union all ')}) j`,
            Schema.Array(SeedJournal),
          );
    return yield* Effect.succeed(
      new DatabaseEvidence({ name: database, fingerprint: schemaFingerprint(schema), journals }),
    );
  });

const archiveDigest = (filename: string) =>
  Effect.gen(function* readArchiveDigest() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.succeed(
      createHash('sha256')
        .update(yield* fs.readFile(filename))
        .digest('hex'),
    );
  });

/** Container-local files never include role passwords. Each scoped directory is removed on exit. */
export const withPostgresFiles = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* ownedPostgresDirectory() {
      const directory = (yield* postgresCommand('mktemp', ['-d', '/tmp/ontos-ci-seed.XXXXXXXX'])).trim();
      if (!/^\/tmp\/ontos-ci-seed\.[A-Za-z0-9]+$/u.test(directory)) {
        return yield* seedFailure('PostgreSQL temporary directory was not operation-owned');
      }
      yield* Effect.addFinalizer(() => postgresCommand('rm', ['-rf', directory]).pipe(Effect.orDie));
      return yield* body(directory);
    }),
  );

export const dumpDatabase = (database: string, index: number, directory: string, containerDirectory: string) =>
  Effect.gen(function* dumpProvedDatabase() {
    yield* seedSql(database, SECRET_AUDIT_SQL);
    const user = yield* requiredEnvironment(POSTGRES_USER_KEY);
    const archive = `database-${index}.dump`;
    const source = `${containerDirectory}/${archive}`;
    yield* postgresCommand('pg_dump', [
      USERNAME_FLAG,
      user,
      DATABASE_FLAG,
      database,
      '--format=custom',
      CREATE_FLAG,
      `--exclude-table-data=${SEAL_TABLE}`,
      '--file',
      source,
    ]);
    yield* runSeedCommand('docker', ['compose', 'cp', `${PG_SERVICE}:${source}`, path.join(directory, archive)]);
    return yield* Effect.succeed(
      new SeedDatabase({
        archive,
        digest: yield* archiveDigest(path.join(directory, archive)),
        evidence: yield* databaseEvidence(database),
      }),
    );
  });

export const validateArchive = (database: SeedDatabase, directory: string) =>
  Effect.gen(function* verifyArchive() {
    if ((yield* archiveDigest(path.join(directory, database.archive))) !== database.digest) {
      return yield* seedFailure(`Seed archive digest mismatch for ${database.evidence.name}`);
    }
    return yield* Effect.void;
  });

const roleAttributes = (role: SeedRole) =>
  [
    role.superuser ? 'SUPERUSER' : 'NOSUPERUSER',
    role.inherit ? 'INHERIT' : 'NOINHERIT',
    role.createRole ? 'CREATEROLE' : 'NOCREATEROLE',
    role.createDb ? 'CREATEDB' : 'NOCREATEDB',
    role.login ? 'LOGIN' : 'NOLOGIN',
    role.replication ? 'REPLICATION' : 'NOREPLICATION',
    role.bypassRls ? 'BYPASSRLS' : 'NOBYPASSRLS',
    `CONNECTION LIMIT ${role.connectionLimit}`,
    role.validUntil === null ? '' : `VALID UNTIL ${quoteLiteral(role.validUntil)}`,
  ].join(' ');

/** Credentials are reconstructed only from the consumer environment, never role names or artifact SQL. */
export const rolePasswords = () =>
  Effect.gen(function* consumerRolePasswords() {
    const result = new Map<string, string>();
    const admin = URL.parse(yield* requiredEnvironment('DATABASE_ADMIN_URL'));
    if (admin === null) {
      return yield* seedFailure('Invalid consumer administrator URL');
    }
    for (const key of [
      'DATABASE_ADMIN_URL',
      'DATABASE_URL',
      'SHELL_GATEWAY_ISSUER_DATABASE_URL',
      'PARTY_REGISTRY_DATABASE_URL',
      'PARTY_REGISTRY_WORKER_DATABASE_URL',
      COMMERCE_URL_KEY,
    ]) {
      const url = URL.parse(yield* requiredEnvironment(key));
      if (
        url === null ||
        !['postgres:', 'postgresql:'].includes(url.protocol) ||
        url.hostname !== admin.hostname ||
        url.port !== admin.port ||
        url.pathname !== admin.pathname ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        return yield* seedFailure(`Expected a local consumer PostgreSQL URL without routing overrides in ${key}`);
      }
      const { name, password } = yield* Effect.try({
        try: () => ({ name: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }),
        catch: () => seedFailure(`Invalid percent-encoded consumer credentials in ${key}`),
      });
      if (password.length === 0 || (result.has(name) && result.get(name) !== password)) {
        return yield* seedFailure(`Missing or conflicting consumer credentials in ${key}`);
      }
      result.set(name, password);
    }
    result.set('spicedb', yield* requiredEnvironment('SPICEDB_DATABASE_PASSWORD'));
    return yield* Effect.succeed(result);
  });

export const validateSettings = (settings: readonly SeedSetting[]) =>
  settings.every(({ value }) => SAFE_SETTING.test(value))
    ? Effect.void
    : Effect.fail(seedFailure('Unreviewed PostgreSQL role/database setting cannot enter a password-free seed'));

export const restoreRoles = (manifest: SeedManifest, passwords: ReadonlyMap<string, string>) =>
  Effect.gen(function* restoreClusterRoles() {
    const existing = yield* readRoles();
    if (existing.some((role) => !manifest.roles.some((expected) => expected.name === role.name))) {
      return yield* seedFailure('Unexpected existing cluster role; seed restore requires a fresh cluster');
    }
    const unmapped = manifest.roles.find((role) => role.login && !passwords.has(role.name));
    if (unmapped !== undefined) {
      return yield* seedFailure(`No consumer environment password mapping for login role ${unmapped.name}`);
    }
    for (const role of manifest.roles) {
      const password = passwords.get(role.name);
      if (role.login && password === undefined) {
        return yield* seedFailure(`No consumer environment password mapping for login role ${role.name}`);
      }
      const identifier = quoteIdentifier(role.name);
      const create = `CREATE ROLE ${identifier}`;
      const passwordSql = role.login && password !== undefined ? quoteLiteral(password) : 'NULL';
      yield* seedSql(
        MAINTENANCE_DB,
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role.name)})
        THEN EXECUTE ${quoteLiteral(create)}; END IF; END $$;
        ALTER ROLE ${identifier} ${roleAttributes(role)} PASSWORD ${passwordSql}; ALTER ROLE ${identifier} RESET ALL;`,
      );
    }
    for (const member of manifest.memberships) {
      yield* seedSql(
        MAINTENANCE_DB,
        `GRANT ${quoteIdentifier(member.role)} TO ${quoteIdentifier(member.member)}
        WITH ADMIN ${member.admin}, INHERIT ${member.inherit}, SET ${member.set} GRANTED BY ${quoteIdentifier(member.grantor)};`,
      );
    }
    return yield* Effect.void;
  });

export const restoreDatabase = (database: SeedDatabase, directory: string, containerDirectory: string, jobs: number) =>
  Effect.gen(function* restoreOneDatabase() {
    const user = yield* requiredEnvironment(POSTGRES_USER_KEY);
    const destination = `${containerDirectory}/${database.archive}`;
    yield* runSeedCommand('docker', [
      'compose',
      'cp',
      path.join(directory, database.archive),
      `${PG_SERVICE}:${destination}`,
    ]);
    // Every database has already been checked empty, before any cluster mutation.
    yield* seedSql(MAINTENANCE_DB, `DROP DATABASE IF EXISTS ${quoteIdentifier(database.evidence.name)} WITH (FORCE)`);
    yield* postgresCommand('pg_restore', [
      USERNAME_FLAG,
      user,
      DATABASE_FLAG,
      MAINTENANCE_DB,
      CREATE_FLAG,
      '--exit-on-error',
      '--jobs',
      String(jobs),
      destination,
    ]);
    if (
      (yield* seedSql(database.evidence.name, `select to_regclass(${quoteLiteral(SEAL_TABLE)}) is not null`)).trim() ===
      't'
    ) {
      yield* seedSql(database.evidence.name, REGENERATE_SEAL_SQL);
    }
    return yield* assertDatabaseEvidence(database.evidence, yield* databaseEvidence(database.evidence.name));
  });

export const restoreSettings = (settings: readonly SeedSetting[]) =>
  Effect.gen(function* restoreRoleDatabaseSettings() {
    yield* validateSettings(settings);
    for (const setting of settings) {
      const separator = setting.value.indexOf('=');
      const key = quoteIdentifier(setting.value.slice(0, separator));
      const value = quoteLiteral(setting.value.slice(separator + 1));
      const target = setting.role === null ? 'ALL' : quoteIdentifier(setting.role);
      const inDatabase = setting.database === null ? '' : ` IN DATABASE ${quoteIdentifier(setting.database)}`;
      yield* seedSql(MAINTENANCE_DB, `ALTER ROLE ${target}${inDatabase} SET ${key} TO ${value}`);
    }
    return yield* Effect.void;
  });

export const assertEmptyDatabases = () =>
  Effect.gen(function* refusePopulatedDatabases() {
    const names = yield* readDatabases();
    for (const name of names) {
      const count = (yield* seedSql(
        name,
        `select count(*) from pg_namespace where nspname not in ('public', 'information_schema') and nspname !~ '^pg_'`,
      )).trim();
      const objects = (yield* seedSql(
        name,
        `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname = 'public'`,
      )).trim();
      if (count !== '0' || objects !== '0') {
        return yield* seedFailure(`Seed requires an empty database before restore/proof: ${name}`);
      }
    }
    return yield* Effect.void;
  });

/** Passwords are deliberately absent from both sides of this cluster-equivalence check. */
export const assertClusterEvidence = (manifest: SeedManifest) =>
  Effect.gen(function* verifyRestoredCluster() {
    const roleJson = Schema.fromJsonString(Schema.Array(SeedRole));
    const membershipJson = Schema.fromJsonString(Schema.Array(SeedMembership));
    const settingJson = Schema.fromJsonString(Schema.Array(SeedSetting));
    const rolesMatch =
      (yield* Schema.encodeEffect(roleJson)(manifest.roles)) ===
      (yield* Schema.encodeEffect(roleJson)(yield* readRoles()));
    const membershipsMatch =
      (yield* Schema.encodeEffect(membershipJson)(manifest.memberships)) ===
      (yield* Schema.encodeEffect(membershipJson)(yield* readMemberships()));
    const settingsMatch =
      (yield* Schema.encodeEffect(settingJson)(manifest.settings)) ===
      (yield* Schema.encodeEffect(settingJson)(yield* readSettings()));
    return yield* rolesMatch && membershipsMatch && settingsMatch
      ? Effect.void
      : Effect.fail(seedFailure('Restored cluster role attributes, memberships or settings differ from the seed'));
  });
