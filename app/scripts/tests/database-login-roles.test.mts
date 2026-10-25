import { PgClient as actualPgClient } from '@effect/sql-pg' with { rstest: 'importActual' };
import { Array as EffectArray, Effect, Order, Redacted, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity';
import { SqlClient, Statement } from 'effect/unstable/sql';
import type { SqlConnection } from 'effect/unstable/sql';
import { AuthenticationError, SqlError } from 'effect/unstable/sql/SqlError';
import { afterEach, expect, it, rstest } from 'effect-rstest';

import { DATABASE_IDENTITIES } from '../../database/identity-enrollment.ts';
import type { DatabaseIdentityConnections } from '../../packages/core-runtime/src/db/config.ts';
import { ensureDatabaseLoginRole } from '../postgres/database-login-roles.mts';
import { DATABASE_ROLE_GRANT_MANIFEST } from '../postgres/database-role-manifest.mts';
import { bootstrapRuntimeRoles, explicitEntries } from '../postgres/runtime-role-bootstrap.mts';

rstest.mock('@effect/sql-pg', () => ({
  PgClient: { ...actualPgClient, makeClient: rstest.fn() },
}));
const { PgClient } = await import('@effect/sql-pg');

const TEST_CREDENTIAL = 'unit-test-password';
const ROLE_EXISTS_QUERY_PREFIX = 'select exists(select 1 from pg_catalog.pg_roles';

const connectionFor = (role: string) => ({
  connectionString: `postgresql://${role}:${TEST_CREDENTIAL}@127.0.0.1/unit_test`,
  database: 'unit_test',
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
type Respond = (text: string, values: readonly unknown[]) => Rows;

/** A real Effect SQL facade over an in-memory connection; transaction controls are recorded too. */
const makeClient = (statements: string[], respond: Respond) =>
  Effect.gen(function* makeMemoryClient() {
    const execute = (text: string, values: readonly unknown[]) =>
      Effect.sync(() => {
        statements.push(text);
        return respond(text, values);
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
                reason: new AuthenticationError({ cause: 'private-driver-detail', message: TEST_CREDENTIAL }),
              }),
            )
          : makeClient([], () => [{ database: 'unit_test', role }]);
      });
      const failure = yield* bootstrapRuntimeRoles(client, connections, passwords, 'reconcile').pipe(Effect.flip);
      expect(failure.reason).toContain(protectedIdentity.urlKey);
      expect(JSON.stringify(failure)).not.toContain(TEST_CREDENTIAL);
      expect(JSON.stringify(failure)).not.toContain('private-driver-detail');
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
      expect(statements).toContain(
        'grant select, insert, update, delete on all tables in schema core to ontos_runtime',
      );
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
      yield* bootstrapRuntimeRoles(client, connections, passwords, 'initialize-local');
      expect(connect).not.toHaveBeenCalled();
      for (const { role } of DATABASE_IDENTITIES) {
        expect(statements.some((text) => text.startsWith(`create role "${role}" login password `))).toBe(true);
      }
      expect(statements).toContain(
        'grant select, insert, update, delete on all tables in schema core to ontos_runtime',
      );
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
      'initialize-local',
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
