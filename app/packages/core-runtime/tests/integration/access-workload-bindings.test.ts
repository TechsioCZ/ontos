import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Cause, Crypto, DateTime, Effect, Exit, FileSystem, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { AccessWorkloadBindingIdSchema } from '../../src/access/workloads/store.ts';
import type { AccessWorkloadBindingStoreService } from '../../src/access/workloads/store.ts';
import { makeAccessWorkloadBindingDrizzleStore } from '../../src/access/workloads/binding-store.ts';
import { makeDrizzleAccessWorkloadBindings } from '../../src/access/workloads/bindings.ts';
import { PrincipalIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import type { WorkloadKey } from '../../src/authorization/access-declaration.ts';
import { WorkloadKeySchema } from '../../src/authorization/access-declaration.ts';
import type { AccessIntentError } from '../../src/access/intent/errors.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor } from '../../src/db/types.ts';
import { writeTestTenantScopes } from '../../src/testing/tenant-access.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The registered workload identities are Core-owned intent, so PostgreSQL has to keep them: one live
 * binding per principal and workload key, a revocation that is final, a scope that is the request's
 * own, and a reader that answers only the actor's active keys. These suites apply the real access
 * migration into a database of their own, write through the store Core's writers use, and probe the
 * reader and every refusal beside the command that must be accepted (O73).
 *
 * Each suite owns its database and drops it again: the access tables are append-only by design, so
 * intent written into a shared test database could never be cleaned up afterwards.
 */
const databasePrefix = 'ontos_test_access_workload_bindings_';
/** The access migration, then the access fence's lease (the column Core's fence writers set). */
const migrationPaths = [
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  // The registry read answers keys and registered companies together (D6), so the company registrations exist too.
  '../../drizzle/20261109185619_workload-company-bindings/migration.sql',
  '../../drizzle/20261112024527_scope-fence-lease/migration.sql',
].map((path) => new URL(path, import.meta.url).pathname);

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantA = uid(1);
const tenantB = uid(2);
const provisioner = uid(3);
const otherWorkload = uid(4);
const human = uid(5);
const authBinding = uid(20);

const workloadKey = (value: string): WorkloadKey => WorkloadKeySchema.make(value);
const IDENTITY_PROVIDER = workloadKey('core.identity-provider');
const STOREFRONT = workloadKey('commerce.storefront-client');

/** The trusted request scope a store call runs in: one session principal of one tenant. */
const scopeOf = (tenantId: string, principalId: string): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: authBinding,
    authContextRef: 'better-auth-session:access-workload-bindings',
    authMethod: 'session',
    principalId,
    tenantId,
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-workload-bindings' })),
    Effect.orDie,
  );

/** The exact refusal a store operation produced, so a suite asserts a code and never a message. */
const failureOf = <Value>(effect: Effect.Effect<Value, AccessIntentError>) =>
  Effect.gen(function* storeFailureOf() {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  });

const REQUIRED_IDENTITY_TABLES = [
  'create schema "core"',
  `create table "core"."tenants" (tenant_id uuid primary key)`,
  `create table "core"."legal_entities" (
     tenant_id uuid not null,
     legal_entity_id uuid primary key,
     status text not null default 'active',
     unique (tenant_id, legal_entity_id)
   )`,
  `create table "core"."principals" (
     tenant_id uuid not null,
     principal_id uuid primary key,
     kind text not null,
     unique (tenant_id, principal_id)
   )`,
  // The access migration scopes its gateway-request policies by the redeemed trusted scope
  // (`trust.current_tenant_id()`, D6); the real database carries that function from the trusted
  // gateway-scope migration, which runs before this one. This isolated database applies the access
  // migration alone, so it declares the same schema and function the policies resolve against at
  // creation time. The suite runs as the shared runtime, so the gateway policies are never used.
  `create schema "trust"`,
  `create function "trust"."current_tenant_id"() returns uuid language sql stable as $$
     select nullif(current_setting('ontos.tenant_id', true), '')::uuid
   $$`,
] as const;

const replacedDatabase = (connectionString: string, database: string): string => {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.href;
};

interface AccessWorkloadSchema {
  readonly admin: PgClient.PgClient;
  readonly reader: ReturnType<typeof makeDrizzleAccessWorkloadBindings>;
  readonly runtimeDatabase: CoreDatabaseExecutor;
  readonly scopeA: OperationalScope;
  readonly scopeB: OperationalScope;
  readonly store: AccessWorkloadBindingStoreService;
}

/** A database of this run's own, with the access migration applied and the runtime role granted. */
const makeAccessWorkloadSchema = Effect.gen(function* accessWorkloadSchema() {
  const connections = yield* loadDatabaseConnectionPair();
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const database = `${databasePrefix}${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const sourceAdmin = yield* makeTestPgClient(connections.admin.connectionString);
  yield* sourceAdmin.unsafe(`create database "${database}"`);
  yield* Effect.addFinalizer(() =>
    database.startsWith(databasePrefix)
      ? sourceAdmin.unsafe(`drop database if exists "${database}"`).pipe(Effect.orDie)
      : Effect.die('Unsafe isolated database cleanup target'),
  );
  const isolated = yield* parseDatabaseConnectionPair({
    DATABASE_ADMIN_URL: replacedDatabase(connections.admin.connectionString, database),
    DATABASE_URL: replacedDatabase(connections.runtime.connectionString, database),
  });
  const admin = yield* makeTestPgClient(isolated.admin.connectionString);
  for (const statement of REQUIRED_IDENTITY_TABLES) {
    yield* admin.unsafe(statement);
  }
  for (const migrationPath of migrationPaths) {
    const migration = yield* fileSystem.readFileString(migrationPath);
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        yield* admin.unsafe(statement);
      }
    }
  }
  // The runtime role's Core privileges, exactly what `db:bootstrap-runtime-role` grants after a migrate.
  for (const statement of [
    'grant usage on schema "core" to ontos_runtime',
    'grant select, insert, update, delete on all tables in schema "core" to ontos_runtime',
  ]) {
    yield* admin.unsafe(statement);
  }
  const runtime = yield* makeTestPgClient(isolated.runtime.connectionString);
  const runtimeDatabase = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return {
    admin,
    reader: makeDrizzleAccessWorkloadBindings({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
    runtimeDatabase,
    scopeA: yield* scopeOf(tenantA, provisioner),
    scopeB: yield* scopeOf(tenantB, otherWorkload),
    store: makeAccessWorkloadBindingDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
  } satisfies AccessWorkloadSchema;
});

const seedTenants = ({ admin, runtimeDatabase }: Pick<AccessWorkloadSchema, 'admin' | 'runtimeDatabase'>) =>
  Effect.gen(function* seedTenantsEffect() {
    yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}'), ('${tenantB}')`);
    yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind) values
      ('${tenantA}', '${provisioner}', 'service'),
      ('${tenantA}', '${human}', 'human'),
      ('${tenantB}', '${otherWorkload}', 'service')`);
    // Every tenant carries the scopes and Ready fence its bootstrap writes; a revocation locks that fence so
    // it serializes with every Action already prepared on the binding (D6).
    for (const [tenantId, principalId] of [
      [tenantA, provisioner],
      [tenantB, otherWorkload],
    ] as const) {
      yield* writeTestTenantScopes(runtimeDatabase, {
        databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        principalId,
        tenantId,
      });
    }
  });

const bindingOf = (input: {
  readonly bindingId: string;
  readonly incarnation: string;
  readonly key: WorkloadKey;
  readonly principalId: string;
  readonly tenantId: string;
}) => ({
  bindingId: AccessWorkloadBindingIdSchema.make(input.bindingId),
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T09:35:47Z')),
  incarnation: AccessWorkloadBindingIdSchema.make(input.incarnation),
  principalId: PrincipalIdSchema.make(input.principalId),
  tenantId: TenantIdSchema.make(input.tenantId),
  workloadKey: input.key,
});

it.layer(NodeServices.layer)('the Access workload binding store', (suite) => {
  suite.effect(
    'registers a workload and answers only its active keys to the actor that holds them',
    Effect.fnUntraced(function* registersAndReads() {
      const schema = yield* makeAccessWorkloadSchema;
      const { reader, scopeA, store } = schema;
      yield* seedTenants(schema);

      const binding = bindingOf({
        bindingId: uid(30),
        incarnation: uid(40),
        key: IDENTITY_PROVIDER,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [binding] });

      const keys = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(provisioner),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...keys]).toEqual([IDENTITY_PROVIDER]);

      // A person holds no registered workload: the kind alone admits nothing (O73).
      const humanKeys = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(human),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...humanKeys]).toEqual([]);
    }),
  );

  suite.effect(
    'never revives a revoked binding and lets a fresh incarnation re-bind the same key',
    Effect.fnUntraced(function* revokedIsFinal() {
      const schema = yield* makeAccessWorkloadSchema;
      const { reader, scopeA, store } = schema;
      yield* seedTenants(schema);

      const binding = bindingOf({
        bindingId: uid(31),
        incarnation: uid(41),
        key: STOREFRONT,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [binding] });
      yield* store.revokeBinding(scopeA, {
        bindingId: AccessWorkloadBindingIdSchema.make(uid(31)),
        revokedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-03T10:00:00Z')),
      });

      const afterRevoke = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(provisioner),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...afterRevoke]).toEqual([]);

      // Re-registering the same binding id is a no-op: a revoked binding is never reopened (D27).
      yield* store.registerBindings(scopeA, { bindings: [binding] });
      const afterReregister = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(provisioner),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...afterReregister]).toEqual([]);

      // A fresh registration with a new incarnation is a new, live binding for the same key.
      const rebind = bindingOf({
        bindingId: uid(32),
        incarnation: uid(42),
        key: STOREFRONT,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [rebind] });
      const afterRebind = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(provisioner),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...afterRebind]).toEqual([STOREFRONT]);
    }),
  );

  suite.effect(
    'refuses a binding that names another tenant and hides another tenant rows from the reader',
    Effect.fnUntraced(function* refusesForeignTenant() {
      const schema = yield* makeAccessWorkloadSchema;
      const { reader, scopeA, scopeB, store } = schema;
      yield* seedTenants(schema);

      const foreign = bindingOf({
        bindingId: uid(33),
        incarnation: uid(43),
        key: IDENTITY_PROVIDER,
        principalId: otherWorkload,
        tenantId: tenantB,
      });
      const refusal = yield* failureOf(store.registerBindings(scopeA, { bindings: [foreign] }));
      expect(refusal?.code).toBe('access_intent_scope_mismatch');

      // Each tenant's own binding is invisible to the other tenant's scope (row security).
      const inA = bindingOf({
        bindingId: uid(34),
        incarnation: uid(44),
        key: IDENTITY_PROVIDER,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [inA] });
      const inB = bindingOf({
        bindingId: uid(35),
        incarnation: uid(45),
        key: STOREFRONT,
        principalId: otherWorkload,
        tenantId: tenantB,
      });
      yield* store.registerBindings(scopeB, { bindings: [inB] });

      const seenInA = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(otherWorkload),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...seenInA]).toEqual([]);
      const seenInB = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(otherWorkload),
        scope: scopeB,
        tenantId: TenantIdSchema.make(tenantB),
      })).workloadKeys;
      expect([...seenInB]).toEqual([STOREFRONT]);
    }),
  );

  suite.effect(
    'keeps one live binding per principal and key: a repeat registration is a no-op',
    Effect.fnUntraced(function* keepsOneLiveBinding() {
      const schema = yield* makeAccessWorkloadSchema;
      const { reader, scopeA, store } = schema;
      yield* seedTenants(schema);

      const first = bindingOf({
        bindingId: uid(36),
        incarnation: uid(46),
        key: IDENTITY_PROVIDER,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [first] });
      // An idempotent bootstrap re-registers the same binding: the store leaves the live one alone.
      yield* store.registerBindings(scopeA, { bindings: [first] });
      const second = bindingOf({
        bindingId: uid(37),
        incarnation: uid(47),
        key: IDENTITY_PROVIDER,
        principalId: provisioner,
        tenantId: tenantA,
      });
      yield* store.registerBindings(scopeA, { bindings: [second] });
      const keys = (yield* reader.readWorkloadAuthority({
        principalId: PrincipalIdSchema.make(provisioner),
        scope: scopeA,
        tenantId: TenantIdSchema.make(tenantA),
      })).workloadKeys;
      expect([...keys]).toEqual([IDENTITY_PROVIDER]);

      // The invariant is the database's: a raw second live row for the same principal and key is
      // refused, so a store bug can never widen what the gate admits (O73).
      const duplicate = yield* Effect.exit(
        schema.admin.unsafe(`insert into "core"."access_workload_bindings"
          (binding_id, tenant_id, principal_id, workload_key, status, incarnation, created_at)
        values ('${uid(38)}', '${tenantA}', '${provisioner}', '${IDENTITY_PROVIDER}', 'active', '${uid(48)}', now())`),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
  );
});
