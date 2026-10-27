import { PgClient as actualPgClient } from '@effect/sql-pg' with { rstest: 'importActual' };
import { Array as EffectArray, Effect, Exit, Order, Redacted, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { SqlClient, Statement } from 'effect/unstable/sql';
import type { SqlConnection } from 'effect/unstable/sql';
import { AuthenticationError, SqlError } from 'effect/unstable/sql/SqlError';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';
import type { DatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import { ensureDatabaseLoginRole } from '../postgres/database-login-roles.mts';
import { DATABASE_ROLE_GRANT_MANIFEST } from '../postgres/database-role-manifest.mts';
import { bootstrapRuntimeRoles, explicitEntries, grantExplicitRole } from '../postgres/runtime-role-bootstrap.mts';
import type { ExplicitManifestEntry } from '../postgres/runtime-role-bootstrap.mts';

rstest.mock('@effect/sql-pg', () => ({
  PgClient: { ...actualPgClient, makeClient: rstest.fn() },
}));
const { PgClient } = await import('@effect/sql-pg');

const TEST_CREDENTIAL = 'unit-test-password';
const PRIVATE_DRIVER_DETAIL = 'private-driver-detail';
const INITIALIZE_LOCAL = 'initialize-local';
const CORE_TABLE_GRANT = 'grant select, insert, update, delete on all tables in schema core to ontos_runtime';
const ROLE_EXISTS_QUERY_PREFIX = 'select exists(select 1 from pg_catalog.pg_roles';
const TABLE_EXISTS_QUERY = 'select pg_catalog.to_regclass($1) is not null as exists';
const TABLE_ATTRIBUTES_QUERY_PREFIX = 'select attname';
const PROBE_TABLE = 'core.bootstrap_probe';

const connectionFor = (role: string) => ({
  connectionString: `postgresql://${role}:${TEST_CREDENTIAL}@127.0.0.1/unit_test`,
  database: 'unit_test',
  expectedRole: role,
  host: '127.0.0.1',
  port: 5432,
  user: role,
});
const connections: DatabaseIdentityConnections = {
  admin: connectionFor('unit_test_admin'),
  runtime: Object.fromEntries(DATABASE_IDENTITIES.map(({ id, role }) => [id, connectionFor(role)])),
};
const passwords = new Map(DATABASE_IDENTITIES.map(({ role }) => [role, Redacted.make(TEST_CREDENTIAL)]));

interface Row {
  readonly allowed?: boolean;
  readonly attname?: string;
  readonly database?: string;
  readonly exists?: boolean;
  readonly rolbypassrls?: boolean;
  readonly rolcanlogin?: boolean;
  readonly rolcreatedb?: boolean;
  readonly rolcreaterole?: boolean;
  readonly role?: string | undefined;
  readonly rolinherit?: boolean;
  readonly rolreplication?: boolean;
  readonly rolsuper?: boolean;
  readonly settings?: string;
}
type Rows = readonly Row[];
type Respond = (text: string, values: readonly unknown[]) => Rows | Effect.Effect<Rows, SqlError>;

/** A real Effect SQL facade over an in-memory connection; transaction controls are recorded too. */
const makeClient = (statements: string[], respond: Respond) =>
  Effect.gen(function* makeMemoryClient() {
    const execute = (text: string, values: readonly unknown[]) =>
      Effect.suspend(() => {
        statements.push(text);
        const response = respond(text, values);
        return Effect.isEffect(response) ? response : Effect.succeed(response);
      });
    const connection: SqlConnection.Connection = {
      execute,
      executeRaw: execute,
      executeStream: () => Stream.empty,
      executeUnprepared: execute,
      executeValues: () => Effect.succeed([]),
      executeValuesUnprepared: () => Effect.succeed([]),
    };
    const sql = yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    });
    const client: actualPgClient.PgClient = Object.assign(sql, {
      config: {},
      json: () => Statement.fragment([]),
      listen: () => Effect.die('Unexpected LISTEN in bootstrap'),
      notify: () => Effect.void,
      [PgClient.TypeId]: PgClient.TypeId,
    });
    return client;
  });

const reconciledRows: Respond = (text, values) => {
  if (text.startsWith(ROLE_EXISTS_QUERY_PREFIX)) {
    return [{ exists: true }];
  }
  if (text.startsWith('select exists(select 1 from pg_catalog.pg_namespace')) {
    return [{ exists: values[0] === 'core' }];
  }
  if (text.startsWith('select rolsuper,')) {
    return [
      {
        rolbypassrls: false,
        rolcanlogin: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false,
      },
    ];
  }
  const entry = DATABASE_ROLE_GRANT_MANIFEST.find(({ identity }) => identity.role === values[0]);
  if (text.includes("'TEMPORARY') as allowed")) {
    return [{ allowed: entry?.databaseTemporary ?? false }];
  }
  if (text.startsWith('select coalesce(pg_catalog.string_agg')) {
    return [{ settings: EffectArray.sort(entry?.roleSettings ?? [], Order.String).join(',') }];
  }
  return [];
};

const mutations = (statements: readonly string[]) => statements.filter((text) => !text.startsWith('select'));
afterEach(() => {
  rstest.resetAllMocks();
});

const probeEntry = (tables: ExplicitManifestEntry['grants']['tables']): ExplicitManifestEntry => {
  const [entry] = explicitEntries;
  if (entry === undefined) {
    throw new Error('Expected an explicit identity for the grant probe');
  }
  return {
    grants: { ...entry.grants, routines: [], schemas: ['core'], sequences: [], tables },
    identity: entry.identity,
  };
};

for (const columns of [
  undefined,
  { insert: ['present', 'future'], select: ['present', 'future'], update: ['future'] },
] as const) {
  it.effect(`batches table privileges without widening missing columns: ${JSON.stringify(columns)}`, () =>
    Effect.gen(function* batchedGrantProbe() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, (text, values) => {
        if (text === TABLE_EXISTS_QUERY) {
          return [{ exists: values[0] === PROBE_TABLE }];
        }
        if (text.startsWith(TABLE_ATTRIBUTES_QUERY_PREFIX)) {
          return [{ attname: 'present' }];
        }
        return reconciledRows(text, values);
      });
      const entry = probeEntry([
        {
          columns,
          privileges: ['select', 'insert', 'update', 'delete'],
          reason: 'Grant batching probe',
          table: PROBE_TABLE,
        },
      ]);
      yield* grantExplicitRole(client, entry);
      expect(statements.filter((text) => text.startsWith('grant ') && text.includes('"bootstrap_probe"'))).toEqual([
        columns === undefined
          ? `grant select, insert, update, delete on table "core"."bootstrap_probe" to "${entry.identity.role}"`
          : `grant select ("present"), insert ("present"), delete on table "core"."bootstrap_probe" to "${entry.identity.role}"`,
      ]);
      expect(statements.filter((text) => text.startsWith(TABLE_ATTRIBUTES_QUERY_PREFIX))).toHaveLength(
        columns === undefined ? 0 : 1,
      );
      expect(
        statements.indexOf(`revoke all on all tables in schema "core" from "${entry.identity.role}"`),
      ).toBeLessThan(statements.findIndex((text) => text.includes('on table "core"."bootstrap_probe"')));
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}

it.effect('keeps checking the current table and columns on every grant pass', () =>
  Effect.gen(function* grantChangedColumns() {
    const statements: string[] = [];
    let pass = 0;
    const client = yield* makeClient(statements, (text, values) => {
      if (text === TABLE_EXISTS_QUERY) {
        return [{ exists: values[0] === PROBE_TABLE && pass > 0 }];
      }
      if (text.startsWith(TABLE_ATTRIBUTES_QUERY_PREFIX)) {
        return pass === 1 ? [] : [{ attname: 'future' }];
      }
      return reconciledRows(text, values);
    });
    const entry = probeEntry([
      { columns: { select: ['future'] }, privileges: ['select'], reason: 'Fresh catalog probe', table: PROBE_TABLE },
    ]);
    for (pass = 0; pass < 3; pass += 1) {
      yield* grantExplicitRole(client, entry);
    }
    expect(statements.filter((text) => text === TABLE_EXISTS_QUERY)).toHaveLength(3);
    expect(statements.filter((text) => text.startsWith(TABLE_ATTRIBUTES_QUERY_PREFIX))).toHaveLength(2);
    expect(statements.filter((text) => text.startsWith('grant ') && text.includes('"bootstrap_probe"'))).toEqual([
      `grant select ("future") on table "core"."bootstrap_probe" to "${entry.identity.role}"`,
    ]);
  }).pipe(Effect.provide(Reactivity.layer)),
);

for (const interrupted of [false, true]) {
  it.effect(`rolls back partial reconciliation before reporting success, interrupted=${String(interrupted)}`, () =>
    Effect.gen(function* rollbackPartialBootstrap() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, (text, values) => {
        if (text.startsWith('select rolsuper,')) {
          return interrupted
            ? Effect.interrupt
            : Effect.fail(
                new SqlError({
                  reason: new AuthenticationError({ cause: PRIVATE_DRIVER_DETAIL, message: TEST_CREDENTIAL }),
                }),
              );
        }
        return reconciledRows(text, values);
      });
      const exit = yield* Effect.exit(bootstrapRuntimeRoles(client, connections, passwords, INITIALIZE_LOCAL));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(statements).toContain(CORE_TABLE_GRANT);
      expect(statements).toContain('BEGIN');
      expect(statements.at(-1)).toBe('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(JSON.stringify(exit)).not.toContain(TEST_CREDENTIAL);
      expect(JSON.stringify(exit)).not.toContain(PRIVATE_DRIVER_DETAIL);
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}

for (const { identity: protectedIdentity } of explicitEntries) {
  it.effect(`stops before any mutation when ${protectedIdentity.role} is missing`, () =>
    Effect.gen(function* missingProtectedRole() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, (text, values) =>
        text.startsWith(ROLE_EXISTS_QUERY_PREFIX)
          ? [{ exists: values[0] !== protectedIdentity.role }]
          : reconciledRows(text, values),
      );
      const connect = rstest.mocked(PgClient.makeClient);
      const failure = yield* bootstrapRuntimeRoles(client, connections, passwords, 'reconcile').pipe(Effect.flip);
      expect(failure.reason).toContain(protectedIdentity.role);
      expect(mutations(statements)).toEqual([]);
      expect(connect).not.toHaveBeenCalled();
    }).pipe(Effect.provide(Reactivity.layer)),
  );

  it.effect(`stops before any mutation when ${protectedIdentity.role} credentials fail`, () =>
    Effect.gen(function* mismatchedProtectedPassword() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, reconciledRows);
      rstest.mocked(PgClient.makeClient).mockImplementation(({ url }) => {
        const role = new URL(Redacted.value(url ?? Redacted.make(''))).username;
        return role === protectedIdentity.role
          ? Effect.fail(
              new SqlError({
                reason: new AuthenticationError({ cause: PRIVATE_DRIVER_DETAIL, message: TEST_CREDENTIAL }),
              }),
            )
          : makeClient([], () => [{ database: 'unit_test', role }]);
      });
      const failure = yield* bootstrapRuntimeRoles(client, connections, passwords, 'reconcile').pipe(Effect.flip);
      expect(failure.reason).toContain(protectedIdentity.urlKey);
      expect(JSON.stringify(failure)).not.toContain(TEST_CREDENTIAL);
      expect(JSON.stringify(failure)).not.toContain(PRIVATE_DRIVER_DETAIL);
      expect(mutations(statements)).toEqual([]);
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}

it.effect(
  'authenticates every protected login outside the transaction, then reconciles grants without its password',
  () =>
    Effect.gen(function* reconcileProtectedRoles() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, reconciledRows);
      const authenticated: string[] = [];
      const assertNoMutations = Effect.sync(() => expect(mutations(statements)).toEqual([]));
      rstest.mocked(PgClient.makeClient).mockImplementation(({ url }) => {
        const role = new URL(Redacted.value(url ?? Redacted.make(''))).username;
        return Effect.acquireRelease(
          assertNoMutations.pipe(
            Effect.andThen(
              makeClient([], (text) => {
                expect(text).toBe('select current_database() as database, session_user as role');
                authenticated.push(role);
                return [{ database: 'unit_test', role }];
              }),
            ),
          ),
          () => assertNoMutations,
        );
      });
      yield* bootstrapRuntimeRoles(client, connections, passwords, 'reconcile');
      expect(authenticated).toEqual(explicitEntries.map(({ identity }) => identity.role));
      expect(mutations(statements)[0]).toBe('BEGIN');
      expect(statements.at(-1)).toBe('COMMIT');
      for (const { identity } of explicitEntries) {
        expect(statements).toContain(
          `alter role "${identity.role}" login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication`,
        );
        expect(statements).toContain(`grant connect on database "unit_test" to "${identity.role}"`);
        expect(statements).toContain(`alter role "${identity.role}" reset all`);
        expect(
          statements.filter(
            (text) =>
              text.startsWith(`create role "${identity.role}"`) ||
              (text.startsWith(`alter role "${identity.role}"`) && text.includes('password')),
          ),
        ).toEqual([]);
      }
      expect(statements).toContain(CORE_TABLE_GRANT);
    }).pipe(Effect.provide(Reactivity.layer)),
);

for (const session of [
  { database: 'other_database', role: explicitEntries[0]?.identity.role },
  { database: 'unit_test', role: 'other_role' },
]) {
  it.effect(`rejects a login landing in the wrong database or role: ${JSON.stringify(session)}`, () =>
    Effect.gen(function* wrongProtectedTarget() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, reconciledRows);
      rstest.mocked(PgClient.makeClient).mockImplementation(() => makeClient([], () => [session]));
      yield* bootstrapRuntimeRoles(client, connections, passwords, 'reconcile').pipe(Effect.flip);
      expect(mutations(statements)).toEqual([]);
    }).pipe(Effect.provide(Reactivity.layer)),
  );
}

it.effect('a caller cannot omit a protected connection to avoid the preflight', () =>
  Effect.gen(function* missingProtectedConnection() {
    const statements: string[] = [];
    const client = yield* makeClient(statements, reconciledRows);
    const failure = yield* bootstrapRuntimeRoles(client, { ...connections, runtime: {} }, passwords, 'reconcile').pipe(
      Effect.flip,
    );
    expect(failure.reason).toContain('connection is unavailable');
    expect(mutations(statements)).toEqual([]);
  }).pipe(Effect.provide(Reactivity.layer)),
);

it.effect(
  'explicit fresh local initialization creates all logins and retains the grant pass without network preflight',
  () =>
    Effect.gen(function* initializeFreshLocalRoles() {
      const statements: string[] = [];
      const client = yield* makeClient(statements, (text, values) =>
        text.startsWith(ROLE_EXISTS_QUERY_PREFIX) ? [{ exists: false }] : reconciledRows(text, values),
      );
      const connect = rstest.mocked(PgClient.makeClient);
      yield* bootstrapRuntimeRoles(client, connections, passwords, INITIALIZE_LOCAL);
      expect(connect).not.toHaveBeenCalled();
      for (const { role } of DATABASE_IDENTITIES) {
        expect(statements.some((text) => text.startsWith(`create role "${role}" login password `))).toBe(true);
      }
      expect(statements).toContain(CORE_TABLE_GRANT);
      expect(statements.at(-1)).toBe('COMMIT');
    }).pipe(Effect.provide(Reactivity.layer)),
);

it.effect('refuses initialization on a non-local target before any SQL', () =>
  Effect.gen(function* refuseRemoteInitialization() {
    const statements: string[] = [];
    const client = yield* makeClient(statements, reconciledRows);
    yield* bootstrapRuntimeRoles(
      client,
      { ...connections, admin: { ...connections.admin, host: 'private-stage-db' } },
      passwords,
      INITIALIZE_LOCAL,
    ).pipe(Effect.flip);
    expect(statements).toEqual([]);
  }).pipe(Effect.provide(Reactivity.layer)),
);

it.effect('an existing-credential login never falls back to CREATE when the role disappears', () =>
  Effect.gen(function* noProtectedRoleRecreation() {
    const statements: string[] = [];
    const client = yield* makeClient(statements, () => [{ exists: false }]);
    yield* ensureDatabaseLoginRole(client, {
      credentials: { kind: 'existing' },
      database: 'unit_test',
      role: 'protected_role',
    }).pipe(Effect.flip);
    expect(mutations(statements)).toEqual([]);
  }).pipe(Effect.provide(Reactivity.layer)),
);
