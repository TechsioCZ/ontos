import { NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import {
  Cause,
  Clock,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Match,
  Option,
  Schema,
} from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import { AccessMembershipIdSchema, makeAccessMembershipDrizzleStore } from '../../src/access/intent/memberships.ts';
import type { AccessMembershipStoreService } from '../../src/access/intent/memberships.ts';
import { makeTenantIntentLoader } from '../../src/access/intent/tenant-intent-loader.ts';
import { optionalProperty, runScoped, runScopedRead } from '../../src/access/intent/persistence.ts';
import type { AccessIntentDatabase, AccessIntentStoreFailure } from '../../src/access/intent/persistence.ts';
import { AmountCeilingSchema, CellSelectorSchema, holderKey } from '../../src/access/model.ts';
import type { TenantProjectionIntent } from '../../src/access/compiler/intent.ts';
import type { TenantIntentLoaderService } from '../../src/access/intent/tenant-intent-loader.ts';
import type { AccessIntentError } from '../../src/access/intent/errors.ts';
import { AccessTeamMemberIdSchema, makeAccessTeamDrizzleStore } from '../../src/access/intent/teams.ts';
import type { AccessTeamStoreService } from '../../src/access/intent/teams.ts';
import { AccessTeamIdSchema } from '../../src/access/decision/authority.ts';
import type { AuthorityCell } from '../../src/access/decision/authority.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  AgentIdSchema,
  AssignmentIncarnationIdSchema,
  CapabilityKeySchema,
  GrantIncarnationIdSchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RoleIdSchema,
  RoleRevisionIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { loadDatabaseConnectionPair, parseDatabaseConnectionPair } from '../../src/db/config.ts';
import { accessMemberships, accessScopes, coreRelations } from '../../src/db/schema.ts';
import type { CoreDatabaseExecutor, CoreTransaction } from '../../src/db/types.ts';
import { makeTestDatabase, makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';

/*
 * The tenant intent loader is the one reader of intent, so it has to be exact twice over: complete and
 * consistent for the projection writer (D13), and claim-by-claim right for the decision engine's
 * resolver ports (guarantee 5, D6). These suites apply the real access migrations into a database of
 * their own, write intent through the stores and the tables Core's writers use, and read it back
 * through the loader, with a negative control beside every claim.
 */
const databasePrefix = 'ontos_test_access_intent_loader_';
/** The access-intent migration and every later migration that changes the tables it creates, in order. */
const migrationPaths = [
  '../../drizzle/20261103093547_authorization-v2-access-intent/migration.sql',
  '../../drizzle/20261110141804_access-membership-ended-by/migration.sql',
].map((path) => new URL(path, import.meta.url).pathname);

type ExpectedCeiling = NonNullable<AuthorityCell['amountCeiling']>;

const ALL_RECORDS: AuthorityCell['selector'] = Schema.decodeUnknownSync(CellSelectorSchema)({ _tag: 'all' });

/** The CZK 10 000 a delegation envelope allows. */
const ENVELOPE_CEILING: ExpectedCeiling = Schema.decodeUnknownSync(AmountCeilingSchema)({
  currency: 'CZK',
  limitMinor: 10_000,
});

const fixedInstant = (iso: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(iso));

/** A cell written out by hand, with fixed instants; its amount ceiling only when it has one. */
const expectedCell = (input: {
  readonly assignedBy: string;
  readonly assignment: string;
  readonly capabilityKey: string;
  readonly ceiling?: ExpectedCeiling | undefined;
  readonly deadline: string;
  readonly grant: string;
  readonly holder: AuthorityCell['holder'];
  readonly revision: string;
  readonly role: string;
}): AuthorityCell => {
  const cell: AuthorityCell = {
    assignedAt: fixedInstant('2000-01-01T00:00:00Z'),
    assignedBy: PrincipalIdSchema.make(input.assignedBy),
    assignmentIncarnationId: AssignmentIncarnationIdSchema.make(input.assignment),
    capabilityKey: CapabilityKeySchema.make(input.capabilityKey),
    deadline: fixedInstant(input.deadline),
    grantIncarnationId: GrantIncarnationIdSchema.make(input.grant),
    holder: input.holder,
    mode: 'run',
    roleId: RoleIdSchema.make(input.role),
    roleRevisionId: RoleRevisionIdSchema.make(input.revision),
    selector: ALL_RECORDS,
  };
  return input.ceiling === undefined ? cell : { ...cell, amountCeiling: input.ceiling };
};

/** One answer's cells in assignment order, so a set of cells compares whatever order the rows came in. */
const byAssignment = (answer: readonly { readonly assignmentIncarnationId: string }[] | undefined) =>
  [...(answer ?? [])].toSorted((left, right) =>
    left.assignmentIncarnationId.localeCompare(right.assignmentIncarnationId),
  );

const uid = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantA = uid(1);
const tenantB = uid(2);
const jana = uid(3);
const eva = uid(4);
const janaAgent = uid(5);
const ingestService = uid(6);
const pavel = uid(7);
const expiredMember = uid(8);
const futureMember = uid(9);
/** Still a member of the tenant, but their Akros membership has ended. */
const companyLeaver = uid(190);
const membershipLeaverTenant = uid(191);
const membershipLeaverAkros = uid(192);
const legalEntityAkros = uid(8);
const legalEntityNajempark = uid(9);
const legalEntityB = uid(10);
const scopeTenantA = uid(11);
const scopeAkros = uid(12);
const scopeNajempark = uid(13);
const scopeTenantB = uid(14);
const authBinding = uid(20);
const snapshot1 = uid(21);
const snapshot2 = uid(22);
const role1 = uid(23);
const role1Revision = uid(24);
const role2 = uid(25);
const role2Revision = uid(26);
const grantRead = uid(27);
const grantVoid = uid(28);
const grantPay = uid(29);
const assignmentJana = uid(30);
const assignmentDelegated = uid(31);
const assignmentExpired = uid(32);
const assignmentFuture = uid(33);
const assignmentPaid = uid(34);
const delegationRevoked = uid(35);
const connectionCurrent = uid(36);
const connectionNoConsent = uid(37);
const membershipJana = uid(40);
const membershipOwner = uid(41);
const membershipAgent = uid(42);
const membershipEva = uid(43);
const membershipJanaAkros = uid(44);
const membershipAdminAkros = uid(45);
const membershipAgentAkros = uid(46);
const membershipB = uid(47);
const membershipExpiredMember = uid(53);
const membershipExpiredOwner = uid(54);
const membershipExpiredAdmin = uid(55);
const membershipFutureMember = uid(56);
const roleCapped = uid(70);
const roleCappedRevision = uid(71);
const roleUncapped = uid(72);
const roleUncappedRevision = uid(73);
const grantCapped = uid(74);
const grantUncapped = uid(75);
const delegationCzk = uid(76);
const delegationEur = uid(77);
const assignmentCapped = uid(78);
const assignmentUncapped = uid(79);
const assignmentEuro = uid(80);
const grantCappedRead = uid(81);
const grantCappedUnknown = uid(82);
// Holders with fixed instants and two roles each: one assignment delegated under a CZK envelope, one of their own.
const delegationAgent = uid(193);
const assignmentAgentCapped = uid(194);
const assignmentAgentUncapped = uid(195);
const ondra = uid(196);
const delegationOndra = uid(197);
const assignmentOndraCapped = uid(198);
const assignmentOndraUncapped = uid(199);
const team = uid(50);
const teamMemberJana = uid(51);
const teamMemberAgent = uid(52);

/** The two shapes a scope can take, so an assertion names one instead of comparing tags by hand. */
const legalEntityScopeSchema = Schema.TaggedStruct('LegalEntity', {
  legalEntityId: LegalEntityIdSchema,
  tenantId: TenantIdSchema,
});
const tenantContextScopeSchema = Schema.TaggedStruct('TenantContext', { tenantId: TenantIdSchema });

const moduleKey = 'test.access';
const readKey = 'test.access.invoice.read';
const voidKey = 'test.access.invoice.void';
const payKey = 'test.access.invoice.pay';
/** A key no pinned release declares, so nothing can say whether a money limit applies to it. */
const unknownKey = 'test.access.invoice.unknown';
const teamKey = 'test.access.record.read';

/**
 * The suite's own instants come from the live clock the loader reads, so a seeded period and a read
 * can never disagree. `TestClock` starts at the epoch, so only the read of "now" is taken live.
 */
const liveNow = Effect.fn('accessIntentLoaderTest.liveNow')(function* liveNowEffect() {
  const millis = yield* TestClock.withLive(Clock.currentTimeMillis);
  return DateTime.toDateUtc(DateTime.makeUnsafe(millis));
});

const daysAfter = (instant: Date, days: number): Date =>
  DateTime.toDateUtc(DateTime.add(DateTime.makeUnsafe(instant), { days }));

const person = (principalId: string) => ({
  _tag: 'Principal' as const,
  principalId: PrincipalIdSchema.make(principalId),
});
const agentHolder = (agentId: string) => ({ _tag: 'Agent' as const, agentId: AgentIdSchema.make(agentId) });
const capability = (key: string) => CapabilityKeySchema.make(key);

interface EntryInput {
  readonly amountInput?: string;
  readonly key: string;
  readonly kind: string;
  readonly modes: readonly string[];
  readonly risk: string;
  readonly selectors: readonly string[];
}

const entry = (input: EntryInput) => ({
  ...optionalProperty({}, 'amountInput', input.amountInput),
  key: input.key,
  kind: input.kind,
  modes: [...input.modes],
  moduleKey,
  placement: { group: 'test', level: 'basic' },
  risk: input.risk,
  selectors: [...input.selectors],
});

const releaseEntries = (payRisk: string): readonly EntryInput[] => [
  { key: readKey, kind: 'read', modes: ['run'], risk: 'routine', selectors: [] },
  { key: voidKey, kind: 'action', modes: ['run', 'propose', 'approve'], risk: 'critical', selectors: ['all'] },
  { amountInput: 'amount', key: payKey, kind: 'action', modes: ['run'], risk: payRisk, selectors: [] },
  { key: teamKey, kind: 'read', modes: ['run'], risk: 'routine', selectors: ['team'] },
];

/** What one complete, consistent tenant picture states: members, owners, installations, releases. */
const assertProjection = (projection: TenantProjectionIntent): void => {
  // ---- the projection is complete and consistent for one whole tenant (D13) -----------------
  expect(projection.tenantId).toBe(TenantIdSchema.make(tenantA));
  expect(projection.coverage).toBe('complete');
  expect(projection.scopes).toHaveLength(3);
  expect(projection.legalEntities.map(({ legalEntityId }) => legalEntityId).toSorted()).toEqual(
    [legalEntityAkros, legalEntityNajempark].toSorted(),
  );
  // Tenant membership carries its deadline, and an agent is a member like a person (L43X).
  expect(projection.members.map(({ holder }) => holderKey(holder)).toSorted()).toEqual(
    [holderKey(person(jana)), holderKey(agentHolder(janaAgent)), holderKey(person(companyLeaver))].toSorted(),
  );
  expect(projection.members.map(({ expiresAt }) => expiresAt !== undefined)).toEqual([true, true, true]);
  expect(projection.owners).toEqual([PrincipalIdSchema.make(jana)]);
  expect(projection.suspended.map(holderKey)).toEqual([holderKey(person(eva))]);
  // A membership whose window does not contain this instant is not live intent, whatever its kind:
  // an expired and a not-yet-started member, and an expired owner, are all absent (D6).
  const outsideWindow = [holderKey(person(expiredMember)), holderKey(person(futureMember))];
  expect(projection.members.map(({ holder }) => holderKey(holder))).not.toEqual(expect.arrayContaining(outsideWindow));
  expect(projection.owners).not.toContain(PrincipalIdSchema.make(expiredMember));
  const akros = projection.legalEntities.find(({ legalEntityId }) => legalEntityId === legalEntityAkros);
  expect(akros?.accessAdmins).toEqual([PrincipalIdSchema.make(jana)]);
  // The expired company administration is not live either, so it never projects as an admin (D6).
  expect(akros?.accessAdmins).not.toContain(PrincipalIdSchema.make(expiredMember));
  expect(akros?.members.map(({ holder }) => holderKey(holder)).toSorted()).toEqual(
    [holderKey(person(jana)), holderKey(agentHolder(janaAgent))].toSorted(),
  );
  // The company without a membership projects its identity and nothing else.
  const najempark = projection.legalEntities.find(({ legalEntityId }) => legalEntityId === legalEntityNajempark);
  expect([najempark?.members.length, najempark?.accessAdmins.length]).toEqual([0, 0]);
  expect(projection.principals).toEqual(
    expect.arrayContaining([
      { kind: 'human', principalId: jana },
      { kind: 'agent', principalId: janaAgent },
      { kind: 'service', principalId: ingestService },
    ]),
  );

  const akrosScope = projection.scopes.find(({ scope }) => scope.id === AccessScopeIdSchema.make(scopeAkros));
  expect(akrosScope?.scope.id).toBe(AccessScopeIdSchema.make(scopeAkros));
  expect(Schema.is(legalEntityScopeSchema)(akrosScope?.scope.scope)).toBe(true);
  // Only live assignments and live delegations are projected: the expired one, the future one and
  // the revoked delegation's assignment are not part of the graph.
  expect(akrosScope?.assignments.map(({ incarnationId }) => incarnationId).toSorted()).toEqual(
    [assignmentJana, assignmentPaid].toSorted(),
  );
  expect(akrosScope?.delegations).toEqual([]);
  expect(akrosScope?.roleRevisions.map(({ id }) => id).toSorted()).toEqual([role1Revision, role2Revision].toSorted());
  // Installations are the modules whose state still offers the module's data (O7).
  expect(akrosScope?.installations.map(({ moduleKey: installed }) => installed).toSorted()).toEqual([
    moduleKey,
    'test.other',
  ]);
  expect(akrosScope?.connections.map(({ id }) => id).toSorted()).toEqual(
    [AgentConnectionIdSchema.make(connectionCurrent), AgentConnectionIdSchema.make(connectionNoConsent)].toSorted(),
  );
  // Two releases are pinned at once, and a key resolves to the current release's meaning (O1).
  expect(projection.catalogEntries.map(({ key }) => key).toSorted()).toEqual(
    [payKey, readKey, teamKey, voidKey].toSorted(),
  );
  expect(projection.catalogEntries.find(({ key }) => key === payKey)?.risk).toBe('sensitive');
  // The other tenant's intent never enters this one's picture.
  expect(projection.scopes.some(({ scope }) => scope.id === AccessScopeIdSchema.make(scopeTenantB))).toBe(false);
};

/** One release's entries as the statement values that publish them against one snapshot. */
const entryValues = (snapshotId: string, risk: string): string =>
  releaseEntries(risk)
    .map((input) => `('${snapshotId}', '${input.key}', '${JSON.stringify(entry(input))}'::jsonb)`)
    .join(',\n      ');

/** The trusted request scope a loader call runs in: one session principal of one tenant. */
const scopeOf = (tenantId: string, principalId: string, legalEntityId?: string): Effect.Effect<OperationalScope> =>
  Schema.decodeEffect(TrustedPrincipalContextSchema)({
    authBindingId: authBinding,
    authContextRef: 'better-auth-session:access-intent-loader',
    authMethod: 'session',
    principalId,
    tenantId,
    ...optionalProperty({}, 'legalEntityId', legalEntityId),
  }).pipe(
    Effect.map((context) => ({ ...context, correlationId: 'access-intent-loader' })),
    Effect.orDie,
  );

/**
 * The loader reads the request's instant from the Clock, so a suite must read it from the same live
 * clock production does: Effect's test clock starts at the epoch, which would put every seeded period
 * in the future. Nothing else is wrapped.
 */
const onLiveClock = (loader: TenantIntentLoaderService): TenantIntentLoaderService => ({
  loadAuthorityCells: (scope, query) => TestClock.withLive(loader.loadAuthorityCells(scope, query)),
  loadAuthorityCellsMany: (scope, queries) => TestClock.withLive(loader.loadAuthorityCellsMany(scope, queries)),
  loadConfigureBases: (scope, query) => TestClock.withLive(loader.loadConfigureBases(scope, query)),
  loadConnection: (scope, query) => TestClock.withLive(loader.loadConnection(scope, query)),
  loadProjection: (scope) => TestClock.withLive(loader.loadProjection(scope)),
  loadScope: (scope, query) => TestClock.withLive(loader.loadScope(scope, query)),
  loadTeamIds: (scope, query) => TestClock.withLive(loader.loadTeamIds(scope, query)),
  loadTenantContextScopeId: (scope) => TestClock.withLive(loader.loadTenantContextScopeId(scope)),
});

const failureOf = <Value>(effect: Effect.Effect<Value, AccessIntentError>) =>
  Effect.gen(function* loaderFailureOf() {
    const exit = yield* Effect.exit(effect);
    return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  });

/**
 * One scoped read runner. `runScopedRead` is what the loader reads with and `runScoped` is what the
 * intent stores write with; both take the same shape, so one procedure runs against either.
 */
type ScopedRun = <Value>(
  database: AccessIntentDatabase,
  scope: OperationalScope,
  constraints: ReadonlySet<string>,
  body: (transaction: CoreTransaction) => Effect.Effect<Value, AccessIntentStoreFailure>,
) => Effect.Effect<Value, AccessIntentError>;

/**
 * The statements one loader read of the tenant context scope needs: the scope installation's two and the
 * one SELECT. An unexpected statement dies instead of being answered with rows that would hide it.
 */
const scriptedLoaderRead =
  (scopeRow: {
    readonly legalEntityId: null;
    readonly scopeId: string;
    readonly tenantContextId: string;
    readonly tenantId: string;
  }) =>
  (statement: string): Effect.Effect<readonly object[]> => {
    if (statement.includes('current_user::text as role')) {
      return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: scopeRow.tenantId }]);
    }
    if (statement.includes('"core"."access_scopes"')) {
      return Effect.succeed([scopeRow]);
    }
    if (statement.includes('set_config') || statement.startsWith('set transaction')) {
      return Effect.succeed([]);
    }
    if (/^(?:begin|commit|rollback)/iu.test(statement)) {
      return Effect.succeed([]);
    }
    return Effect.die(new Error(`unexpected statement in a scoped read: ${statement}`));
  };

/**
 * Whether the connection reported the isolation a read asked for is not something a passing read can
 * show: PostgreSQL answers the same rows either way. The statement the driver sends is the proof, so the
 * loader runs over a scripted connection and the SQL it issues is asserted directly.
 */
it.effect(
  'asks PostgreSQL for one repeatable-read snapshot for its reads, and the default for a write',
  Effect.fnUntraced(function* loaderReadIsolation() {
    const scope = yield* scopeOf(tenantA, jana);
    const scopeRow = { legalEntityId: null, scopeId: scopeTenantA, tenantContextId: tenantA, tenantId: tenantA };
    const record = (read: (database: AccessIntentDatabase) => Effect.Effect<unknown, AccessIntentError>) =>
      Effect.gen(function* recordStatements() {
        const statements: string[] = [];
        const rows = scriptedLoaderRead(scopeRow);
        const database = yield* makeTestDatabase((statement) => {
          statements.push(statement);
          return rows(statement);
        });
        yield* read({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor: database });
        return statements;
      });
    const loaderRead = yield* record((database) => makeTenantIntentLoader(database).loadTenantContextScopeId(scope));
    const storeWrite = yield* record((database) =>
      runScoped(database, scope, new Set<string>(), (transaction) =>
        transaction
          .select({ scopeId: accessScopes.scopeId })
          .from(accessScopes)
          .where(eq(accessScopes.tenantId, tenantA))
          .pipe(Effect.asVoid),
      ),
    );
    // The snapshot is fixed as the transaction opens, the only point at which PostgreSQL accepts it.
    expect(loaderRead[0]).toMatch(/^begin$/iu);
    expect(loaderRead[1]).toMatch(/^set transaction isolation level repeatable read$/iu);
    expect(loaderRead[2]).toContain('set_config');
    // A write helper keeps the default: the isolation one read needs is not imposed on every command.
    expect(storeWrite.some((statement) => statement.startsWith('set transaction'))).toBe(false);
    expect(storeWrite[0]).toMatch(/^begin$/iu);
    expect(storeWrite[1]).toContain('set_config');
  }),
);

const REQUIRED_IDENTITY_TABLES = [
  'create schema "core"',
  `create table "core"."tenants" (tenant_id uuid primary key)`,
  `create table "core"."legal_entities" (
     tenant_id uuid not null,
     legal_entity_id uuid primary key,
     unique (tenant_id, legal_entity_id)
   )`,
  `create table "core"."principals" (
     tenant_id uuid not null,
     principal_id uuid primary key,
     kind text not null,
     unique (tenant_id, principal_id)
   )`,
  `create table "core"."tenant_module_states" (
     tenant_module_state_id uuid primary key,
     tenant_id uuid not null,
     module_key text not null,
     state text not null,
     created_at timestamp with time zone default now() not null,
     updated_at timestamp with time zone default now() not null,
     unique (tenant_id, module_key)
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

interface IntentLoaderSchema {
  readonly admin: PgClient.PgClient;
  readonly loader: TenantIntentLoaderService;
  readonly membershipStore: AccessMembershipStoreService;
  readonly runtimeDatabase: CoreDatabaseExecutor;
  readonly scopeAkros: OperationalScope;
  readonly scopeNajempark: OperationalScope;
  readonly scopeTenant: OperationalScope;
  readonly scopeTenantB: OperationalScope;
  readonly teamStore: AccessTeamStoreService;
}

const makeIntentLoaderSchema = Effect.gen(function* intentLoaderSchema() {
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
    loader: makeTenantIntentLoader({ enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT, executor: runtimeDatabase }),
    membershipStore: makeAccessMembershipDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
    runtimeDatabase,
    scopeAkros: yield* scopeOf(tenantA, jana, legalEntityAkros),
    scopeNajempark: yield* scopeOf(tenantA, jana, legalEntityNajempark),
    scopeTenant: yield* scopeOf(tenantA, jana),
    scopeTenantB: yield* scopeOf(tenantB, pavel),
    teamStore: makeAccessTeamDrizzleStore({
      enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
      executor: runtimeDatabase,
    }),
  } satisfies IntentLoaderSchema;
});

const cellJson = (input: {
  readonly amountCeiling?: { readonly currency: string; readonly limitMinor: number };
  readonly key: string;
  readonly mode: string;
}) =>
  JSON.stringify({
    ...optionalProperty({}, 'amountCeiling', input.amountCeiling),
    capabilityKey: input.key,
    mode: input.mode,
    selector: { _tag: 'all' },
  });

/** Tenant A's whole intent: two releases, two roles, four assignments, one delegation, two agents. */
const seedIntent = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedTenantIntent() {
    yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}'), ('${tenantB}')`);
    yield* admin.unsafe(`insert into "core"."legal_entities" values
      ('${tenantA}', '${legalEntityAkros}'),
      ('${tenantA}', '${legalEntityNajempark}'),
      ('${tenantB}', '${legalEntityB}')`);
    yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind) values
      ('${tenantA}', '${jana}', 'human'),
      ('${tenantA}', '${eva}', 'human'),
      ('${tenantA}', '${expiredMember}', 'human'),
      ('${tenantA}', '${futureMember}', 'human'),
      ('${tenantA}', '${companyLeaver}', 'human'),
      ('${tenantA}', '${janaAgent}', 'agent'),
      ('${tenantA}', '${ingestService}', 'service'),
      ('${tenantB}', '${pavel}', 'human')`);
    yield* admin.unsafe(`insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id) values
      ('${scopeTenantA}', '${tenantA}', '${tenantA}', null),
      ('${scopeAkros}', '${tenantA}', null, '${legalEntityAkros}'),
      ('${scopeNajempark}', '${tenantA}', null, '${legalEntityNajempark}'),
      ('${scopeTenantB}', '${tenantB}', '${tenantB}', null)`);
    yield* admin.unsafe(`insert into "core"."tenant_module_states"
        (tenant_module_state_id, tenant_id, module_key, state) values
      ('${uid(60)}', '${tenantA}', '${moduleKey}', 'active'),
      ('${uid(61)}', '${tenantA}', 'test.other', 'read_only'),
      ('${uid(62)}', '${tenantA}', 'test.suspended', 'suspended'),
      ('${uid(63)}', '${tenantA}', 'test.archived', 'archived'),
      ('${uid(64)}', '${tenantB}', 'test.tenantb', 'active')`);

    // ---- two releases: the same capability keys, one of them re-risked (O1) --------------------
    yield* admin.unsafe(`insert into "core"."access_catalog_snapshots" (catalog_snapshot_id, digest, published_at) values
      ('${snapshot1}', '${'a'.repeat(64)}', now() - interval '2 days'),
      ('${snapshot2}', '${'b'.repeat(64)}', now() - interval '1 day')`);
    yield* admin.unsafe(`insert into "core"."access_catalog_entries" (catalog_snapshot_id, capability_key, entry_json) values
      ${entryValues(snapshot1, 'routine')},
      ${entryValues(snapshot2, 'sensitive')}`);

    // ---- two roles, each pinned to the release it was saved against ---------------------------
    yield* admin.unsafe(`insert into "core"."access_roles" (role_id, tenant_id, created_by, legal_entity_id, name) values
      ('${role1}', '${tenantA}', '${jana}', null, 'Účetní'),
      ('${role2}', '${tenantA}', '${jana}', '${legalEntityAkros}', 'Platby')`);
    yield* admin.unsafe(`insert into "core"."access_role_revisions"
        (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance) values
      ('${role1Revision}', '${tenantA}', '${role1}', 1, '${snapshot1}',
       '[{"capabilityKey": "${readKey}", "mode": "run", "selector": {"_tag": "all"}}, {"capabilityKey": "${voidKey}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb,
       '${jana}', 'manual'),
      ('${role2Revision}', '${tenantA}', '${role2}', 1, '${snapshot2}',
       '[{"amountCeiling": {"currency": "CZK", "limitMinor": 100000}, "capabilityKey": "${payKey}", "mode": "run", "selector": {"_tag": "all"}}]'::jsonb,
       '${jana}', 'manual')`);
    yield* admin.unsafe(`insert into "core"."access_grant_incarnations"
        (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status) values
      ('${grantRead}', '${tenantA}', '${scopeAkros}', '${role1}', '${readKey}', 'run', 'all', '${cellJson({ key: readKey, mode: 'run' })}'::jsonb, 'active'),
      ('${grantVoid}', '${tenantA}', '${scopeAkros}', '${role1}', '${voidKey}', 'run', 'all', '${cellJson({ key: voidKey, mode: 'run' })}'::jsonb, 'active'),
      ('${grantPay}', '${tenantA}', '${scopeAkros}', '${role2}', '${payKey}', 'run', 'all',
       '${cellJson({ amountCeiling: { currency: 'CZK', limitMinor: 100_000 }, key: payKey, mode: 'run' })}'::jsonb, 'active')`);

    // ---- assignments: one live, one delegated by a revoked delegation, one expired, one future --
    yield* admin.unsafe(`insert into "core"."access_delegations"
        (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
         amount_ceiling_json, status, valid_from, until) values
      ('${delegationRevoked}', '${tenantA}', '${scopeAkros}', '${jana}', '${eva}', array['${janaAgent}'::uuid],
       array['${role1}'::uuid], array['${voidKey}'], null, 'revoked', now() - interval '1 day', now() + interval '5 days')`);
    yield* admin.unsafe(`insert into "core"."access_assignments"
        (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, delegated_by,
         delegation_envelope_json, status, valid_from, valid_until) values
      ('${assignmentJana}', '${tenantA}', '${scopeAkros}', '${role1}', '${role1Revision}', '${jana}', '${jana}', null, null,
       'active', now() - interval '1 day', null),
      ('${assignmentDelegated}', '${tenantA}', '${scopeAkros}', '${role1}', '${role1Revision}', '${eva}', '${jana}',
       '${delegationRevoked}',
       jsonb_build_object(
         'capabilityKeys', jsonb_build_array('${voidKey}'),
         'delegationId', '${delegationRevoked}',
         'until', now() + interval '5 days'
       ),
       'active', now() - interval '1 day', now() + interval '5 days'),
      ('${assignmentExpired}', '${tenantA}', '${scopeNajempark}', '${role1}', '${role1Revision}', '${jana}', '${jana}', null, null,
       'active', now() - interval '10 days', now() - interval '1 day'),
      ('${assignmentFuture}', '${tenantA}', '${scopeAkros}', '${role2}', '${role2Revision}', '${jana}', '${jana}', null, null,
       'active', now() + interval '1 day', null),
      ('${assignmentPaid}', '${tenantA}', '${scopeAkros}', '${role2}', '${role2Revision}', '${jana}', '${jana}', null, null,
       'active', now() - interval '1 day', null)`);

    // ---- one agent connection whose consent names the read, one whose revision has no consent ---
    yield* admin.unsafe(`insert into "core"."access_agent_connections"
        (connection_id, tenant_id, scope_id, agent_id, principal_id, revision, ceiling_json, status, valid_from, valid_until) values
      ('${connectionCurrent}', '${tenantA}', '${scopeAkros}', '${janaAgent}', '${jana}', 2, '{"cells": []}'::jsonb,
       'active', now() - interval '1 day', now() + interval '1 day'),
      ('${connectionNoConsent}', '${tenantA}', '${scopeAkros}', '${janaAgent}', '${jana}', 3, '{"cells": []}'::jsonb,
       'active', now() - interval '1 day', now() + interval '1 day')`);
    yield* admin.unsafe(`insert into "core"."access_consent_snapshots"
        (tenant_id, connection_id, revision, ceiling_json, granted_at, granted_by) values
      ('${tenantA}', '${connectionCurrent}', 1, '{"cells": []}'::jsonb, now() - interval '2 days', '${jana}'),
      ('${tenantA}', '${connectionCurrent}', 2,
       '{"cells": [{"capabilityKey": "${readKey}", "mode": "run", "selector": {"_tag": "all"}}]}'::jsonb,
       now() - interval '1 day', '${jana}')`);
  });

/** Membership and team intent is written through the stores the writers use, not around them. */
const seedMemberships = (schema: IntentLoaderSchema) =>
  Effect.gen(function* seedMembershipIntent() {
    const { membershipStore: memberships } = schema;
    const now = yield* liveNow();
    const started = daysAfter(now, -2);
    const membership = (input: {
      readonly holder: ReturnType<typeof person> | ReturnType<typeof agentHolder>;
      readonly id: string;
      readonly kind: 'access_admin' | 'member' | 'owner';
      readonly scopeId: string;
      readonly validFrom?: Date;
      readonly validUntil?: Date;
    }) => ({
      createdAt: started,
      holder: input.holder,
      id: AccessMembershipIdSchema.make(input.id),
      kind: input.kind,
      recordedBy: PrincipalIdSchema.make(jana),
      scopeId: AccessScopeIdSchema.make(input.scopeId),
      status: 'active' as const,
      tenantId: TenantIdSchema.make(tenantA),
      validFrom: input.validFrom ?? started,
      ...optionalProperty({}, 'validUntil', input.validUntil),
    });
    yield* memberships.recordMemberships(schema.scopeTenant, {
      memberships: [
        membership({
          holder: person(jana),
          id: membershipJana,
          kind: 'member',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, 10),
        }),
        // Ownership ends on its own date; it bounds management, never Jana's business decisions (D6).
        membership({
          holder: person(jana),
          id: membershipOwner,
          kind: 'owner',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, 5),
        }),
        membership({
          holder: agentHolder(janaAgent),
          id: membershipAgent,
          kind: 'member',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, 10),
        }),
        membership({
          holder: person(eva),
          id: membershipEva,
          kind: 'member',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, 10),
        }),
        membership({
          holder: person(jana),
          id: membershipJanaAkros,
          kind: 'member',
          scopeId: scopeAkros,
          validUntil: daysAfter(now, 30),
        }),
        membership({ holder: person(jana), id: membershipAdminAkros, kind: 'access_admin', scopeId: scopeAkros }),
        membership({ holder: agentHolder(janaAgent), id: membershipAgentAkros, kind: 'member', scopeId: scopeAkros }),
        // Intent whose window does not contain the loader's instant is not intent at all: an expired
        // membership and a not-yet-started one are never projected as a live tuple (D6).
        membership({
          holder: person(expiredMember),
          id: membershipExpiredMember,
          kind: 'member',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, -1),
        }),
        membership({
          holder: person(expiredMember),
          id: membershipExpiredOwner,
          kind: 'owner',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, -1),
        }),
        membership({
          holder: person(expiredMember),
          id: membershipExpiredAdmin,
          kind: 'access_admin',
          scopeId: scopeAkros,
          validUntil: daysAfter(now, -1),
        }),
        membership({
          holder: person(companyLeaver),
          id: membershipLeaverTenant,
          kind: 'member',
          scopeId: scopeTenantA,
          validUntil: daysAfter(now, 10),
        }),
        membership({
          holder: person(companyLeaver),
          id: membershipLeaverAkros,
          kind: 'member',
          scopeId: scopeAkros,
          validUntil: daysAfter(now, -1),
        }),
        membership({
          holder: person(futureMember),
          id: membershipFutureMember,
          kind: 'member',
          scopeId: scopeTenantA,
          validFrom: daysAfter(now, 1),
          validUntil: daysAfter(now, 10),
        }),
      ],
    });
    yield* memberships.setMembershipStatus(schema.scopeTenant, {
      membershipId: AccessMembershipIdSchema.make(membershipEva),
      status: 'suspended',
    });
    yield* memberships.recordMembership(schema.scopeTenantB, {
      membership: {
        ...membership({ holder: person(pavel), id: membershipB, kind: 'member', scopeId: scopeTenantB }),
        recordedBy: PrincipalIdSchema.make(pavel),
        tenantId: TenantIdSchema.make(tenantB),
      },
    });
    yield* schema.teamStore.recordTeam(schema.scopeAkros, {
      team: {
        createdAt: started,
        createdBy: PrincipalIdSchema.make(jana),
        id: AccessTeamIdSchema.make(team),
        name: 'Skladníci',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      },
    });
    for (const [id, holder] of [
      [teamMemberJana, person(jana)],
      [teamMemberAgent, agentHolder(janaAgent)],
    ] as const) {
      yield* schema.teamStore.recordTeamMember(schema.scopeAkros, {
        member: {
          addedAt: started,
          addedBy: PrincipalIdSchema.make(jana),
          holder,
          id: AccessTeamMemberIdSchema.make(id),
          teamId: AccessTeamIdSchema.make(team),
          tenantId: TenantIdSchema.make(tenantA),
        },
      });
    }
  });

/**
 * One tenant where the same person holds the same money capability three ways: capped at 50 000 CZK by
 * a CZK envelope, uncapped by a CZK envelope, and capped at 50 000 CZK under an envelope that froze its
 * limit in EUR. The cell read has to answer with the envelope's 10 000 twice and with no cell at all
 * once (D10b, R3a-M2). The capped role also grants a plain read, which no money limit may reach, and a
 * capability the pinned release does not declare, which a delegated read must not hand out.
 */
const seedDelegatedMoney = (admin: PgClient.PgClient) =>
  Effect.gen(function* seedDelegatedMoneyIntent() {
    const cappedCell = `[{"amountCeiling": {"currency": "CZK", "limitMinor": 50000}, "capabilityKey": "${payKey}", "mode": "run", "selector": {"_tag": "all"}}, {"capabilityKey": "${readKey}", "mode": "run", "selector": {"_tag": "all"}}, {"capabilityKey": "${unknownKey}", "mode": "run", "selector": {"_tag": "all"}}]`;
    const uncappedCell = `[{"capabilityKey": "${payKey}", "mode": "run", "selector": {"_tag": "all"}}]`;
    const envelope = (delegationId: string, currency: string) =>
      `jsonb_build_object(
         'amountCeiling', jsonb_build_object('currency', '${currency}', 'limitMinor', 10000),
         'capabilityKeys', jsonb_build_array('${payKey}', '${readKey}', '${unknownKey}'),
         'delegationId', '${delegationId}',
         'until', now() + interval '30 days'
       )`;
    yield* admin.unsafe(`insert into "core"."tenants" values ('${tenantA}')`);
    yield* admin.unsafe(`insert into "core"."legal_entities" values ('${tenantA}', '${legalEntityAkros}')`);
    yield* admin.unsafe(`insert into "core"."principals" (tenant_id, principal_id, kind) values
      ('${tenantA}', '${jana}', 'human'),
      ('${tenantA}', '${eva}', 'human'),
      ('${tenantA}', '${janaAgent}', 'agent'),
      ('${tenantA}', '${ondra}', 'human')`);
    yield* admin.unsafe(`insert into "core"."access_scopes" (scope_id, tenant_id, tenant_context_id, legal_entity_id) values
      ('${scopeTenantA}', '${tenantA}', '${tenantA}', null),
      ('${scopeAkros}', '${tenantA}', null, '${legalEntityAkros}')`);
    yield* admin.unsafe(`insert into "core"."access_catalog_snapshots" (catalog_snapshot_id, digest, published_at)
      values ('${snapshot1}', '${'a'.repeat(64)}', now() - interval '1 day')`);
    yield* admin.unsafe(`insert into "core"."access_catalog_entries" (catalog_snapshot_id, capability_key, entry_json) values
      ${entryValues(snapshot1, 'routine')}`);
    yield* admin.unsafe(`insert into "core"."access_roles" (role_id, tenant_id, created_by, name) values
      ('${roleCapped}', '${tenantA}', '${jana}', 'Platby s limitem'),
      ('${roleUncapped}', '${tenantA}', '${jana}', 'Platby bez limitu')`);
    yield* admin.unsafe(`insert into "core"."access_role_revisions"
        (role_revision_id, tenant_id, role_id, revision, catalog_snapshot_id, cells_json, created_by, provenance) values
      ('${roleCappedRevision}', '${tenantA}', '${roleCapped}', 1, '${snapshot1}', '${cappedCell}'::jsonb, '${jana}', 'manual'),
      ('${roleUncappedRevision}', '${tenantA}', '${roleUncapped}', 1, '${snapshot1}', '${uncappedCell}'::jsonb, '${jana}', 'manual')`);
    yield* admin.unsafe(`insert into "core"."access_grant_incarnations"
        (grant_incarnation_id, tenant_id, scope_id, role_id, capability_key, mode, slot, cell_json, status) values
      ('${grantCapped}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${payKey}', 'run', 'all',
       '${cellJson({ amountCeiling: { currency: 'CZK', limitMinor: 50_000 }, key: payKey, mode: 'run' })}'::jsonb, 'active'),
      ('${grantUncapped}', '${tenantA}', '${scopeAkros}', '${roleUncapped}', '${payKey}', 'run', 'all',
       '${cellJson({ key: payKey, mode: 'run' })}'::jsonb, 'active'),
      ('${grantCappedRead}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${readKey}', 'run', 'all',
       '${cellJson({ key: readKey, mode: 'run' })}'::jsonb, 'active'),
      ('${grantCappedUnknown}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${unknownKey}', 'run', 'all',
       '${cellJson({ key: unknownKey, mode: 'run' })}'::jsonb, 'active')`);
    yield* admin.unsafe(`insert into "core"."access_delegations"
        (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
         amount_ceiling_json, status, valid_from, until) values
      ('${delegationCzk}', '${tenantA}', '${scopeAkros}', '${jana}', '${eva}', array['${jana}'::uuid],
       array['${roleCapped}'::uuid, '${roleUncapped}'::uuid], array['${payKey}', '${readKey}', '${unknownKey}'], '{"currency": "CZK", "limitMinor": 10000}'::jsonb,
       'active', now() - interval '1 day', now() + interval '60 days'),
      ('${delegationEur}', '${tenantA}', '${scopeAkros}', '${jana}', '${eva}', array['${jana}'::uuid],
       array['${roleCapped}'::uuid], array['${payKey}', '${readKey}', '${unknownKey}'], '{"currency": "EUR", "limitMinor": 10000}'::jsonb,
       'active', now() - interval '1 day', now() + interval '60 days')`);
    yield* admin.unsafe(`insert into "core"."access_assignments"
        (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, assigned_by, delegated_by,
         delegation_envelope_json, status, valid_from, valid_until) values
      ('${assignmentCapped}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${roleCappedRevision}', '${jana}', '${eva}',
       '${delegationCzk}', ${envelope(delegationCzk, 'CZK')}, 'active', now() - interval '1 day', now() + interval '30 days'),
      ('${assignmentUncapped}', '${tenantA}', '${scopeAkros}', '${roleUncapped}', '${roleUncappedRevision}', '${jana}', '${eva}',
       '${delegationCzk}', ${envelope(delegationCzk, 'CZK')}, 'active', now() - interval '1 day', now() + interval '30 days'),
      ('${assignmentEuro}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${roleCappedRevision}', '${jana}', '${eva}',
       '${delegationEur}', ${envelope(delegationEur, 'EUR')}, 'active', now() - interval '1 day', now() + interval '30 days')`);
    // Fixed instants, so every field of these holders' cells is known in advance.
    const fixedEnvelope = (delegationId: string) =>
      `jsonb_build_object(
         'amountCeiling', jsonb_build_object('currency', 'CZK', 'limitMinor', 10000),
         'capabilityKeys', jsonb_build_array('${payKey}', '${readKey}', '${unknownKey}'),
         'delegationId', '${delegationId}',
         'until', '2097-01-01T00:00:00Z'::timestamptz
       )`;
    yield* admin.unsafe(`insert into "core"."access_delegations"
        (delegation_id, tenant_id, scope_id, granted_by, manager_id, people, role_ids, capability_keys,
         amount_ceiling_json, status, valid_from, until) values
      ('${delegationAgent}', '${tenantA}', '${scopeAkros}', '${jana}', '${eva}', array['${janaAgent}'::uuid],
       array['${roleCapped}'::uuid], array['${payKey}', '${readKey}', '${unknownKey}'],
       '{"currency": "CZK", "limitMinor": 10000}'::jsonb, 'active', '2000-01-01T00:00:00Z', '2098-01-01T00:00:00Z'),
      ('${delegationOndra}', '${tenantA}', '${scopeAkros}', '${jana}', '${eva}', array['${ondra}'::uuid],
       array['${roleCapped}'::uuid], array['${payKey}', '${readKey}', '${unknownKey}'],
       '{"currency": "CZK", "limitMinor": 10000}'::jsonb, 'active', '2000-01-01T00:00:00Z', '2098-01-01T00:00:00Z')`);
    yield* admin.unsafe(`insert into "core"."access_assignments"
        (incarnation_id, tenant_id, scope_id, role_id, role_revision_id, principal_id, agent_id, assigned_by,
         delegated_by, delegation_envelope_json, status, valid_from, valid_until) values
      ('${assignmentAgentCapped}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${roleCappedRevision}', null,
       '${janaAgent}', '${eva}', '${delegationAgent}', ${fixedEnvelope(delegationAgent)}, 'active',
       '2000-01-01T00:00:00Z', '2096-01-01T00:00:00Z'),
      ('${assignmentAgentUncapped}', '${tenantA}', '${scopeAkros}', '${roleUncapped}', '${roleUncappedRevision}', null,
       '${janaAgent}', '${jana}', null, null, 'active', '2000-01-01T00:00:00Z', '2095-01-01T00:00:00Z'),
      ('${assignmentOndraCapped}', '${tenantA}', '${scopeAkros}', '${roleCapped}', '${roleCappedRevision}', '${ondra}',
       null, '${eva}', '${delegationOndra}', ${fixedEnvelope(delegationOndra)}, 'active',
       '2000-01-01T00:00:00Z', '2096-01-01T00:00:00Z'),
      ('${assignmentOndraUncapped}', '${tenantA}', '${scopeAkros}', '${roleUncapped}', '${roleUncappedRevision}',
       '${ondra}', null, '${jana}', null, null, 'active', '2000-01-01T00:00:00Z', '2095-01-01T00:00:00Z')`);
  });

it.layer(NodeServices.layer)('the tenant intent loader', (suite) => {
  suite.effect(
    'reads one complete tenant projection and answers every resolver port exactly, inside its scope',
    Effect.fnUntraced(function* tenantIntentLoaderIntegration() {
      const schema = yield* makeIntentLoaderSchema;
      yield* seedIntent(schema.admin);
      yield* seedMemberships(schema);
      const loader = onLiveClock(schema.loader);

      const projection = yield* loader.loadProjection(schema.scopeTenant);
      assertProjection(projection);

      // ---- the scope read carries every membership deadline that bounds the path (D6) -----------
      const tenantScope = yield* loader.loadScope(schema.scopeTenant, {
        holders: [person(jana)],
        tenantId: TenantIdSchema.make(tenantA),
      });
      const resolvedTenant = Option.getOrThrowWith(tenantScope, () => new Error('the tenant context must resolve'));
      expect(Schema.is(tenantContextScopeSchema)(resolvedTenant.scope)).toBe(true);
      expect(resolvedTenant.tenantId).toBe(TenantIdSchema.make(tenantA));
      expect(resolvedTenant.scopeId).toBe(AccessScopeIdSchema.make(scopeTenantA));
      // Only the member row's end bounds the path: the owner row's earlier end is management's own.
      expect(resolvedTenant.holderDeadlines.map(({ deadlines }) => deadlines.map(({ source }) => source))).toEqual([
        ['membership'],
      ]);
      const akrosDeadlines = yield* loader.loadScope(schema.scopeAkros, {
        holders: [person(jana), agentHolder(janaAgent)],
        legalEntityId: LegalEntityIdSchema.make(legalEntityAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      // The company scope needs the company membership too: the person carries both ends, the agent
      // only the tenant's, exactly as each of them holds them (D6, M2).
      expect(
        Option.getOrThrow(akrosDeadlines).holderDeadlines.map(({ deadlines, holder }) => [
          holderKey(holder),
          deadlines.length,
        ]),
      ).toEqual([
        [holderKey(person(jana)), 2],
        [holderKey(agentHolder(janaAgent)), 1],
      ]);
      // A live tenant membership never stands in for a company membership that has ended.
      const leaverHolders = { holders: [person(companyLeaver)], tenantId: TenantIdSchema.make(tenantA) };
      expect(Option.isSome(yield* loader.loadScope(schema.scopeTenant, leaverHolders))).toBe(true);
      expect(
        Option.isNone(
          yield* loader.loadScope(schema.scopeAkros, {
            ...leaverHolders,
            legalEntityId: LegalEntityIdSchema.make(legalEntityAkros),
          }),
        ),
      ).toBe(true);
      // A legal entity without a scope is a refusal of the actor, not a retryable read.
      expect(
        Option.isNone(
          yield* loader.loadScope(schema.scopeAkros, {
            holders: [person(jana)],
            legalEntityId: LegalEntityIdSchema.make(uid(98)),
            tenantId: TenantIdSchema.make(tenantA),
          }),
        ),
      ).toBe(true);
      const foreign = yield* failureOf(
        loader.loadScope(schema.scopeTenant, { holders: [person(pavel)], tenantId: TenantIdSchema.make(tenantB) }),
      );
      expect(foreign?.code).toBe('access_intent_scope_mismatch');

      // ---- the cell read names the exact grant cell a decision may witness (guarantee 9) --------
      const readCells = yield* loader.loadAuthorityCells(schema.scopeAkros, {
        capabilityKey: capability(readKey),
        holder: person(jana),
        mode: 'run',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      expect(readCells).toHaveLength(1);
      expect(readCells[0]?.grantIncarnationId).toBe(uid(27));
      expect(readCells[0]?.assignmentIncarnationId).toBe(assignmentJana);
      expect(readCells[0]?.roleId).toBe(RoleIdSchema.make(role1));
      expect(readCells[0]?.roleRevisionId).toBe(RoleRevisionIdSchema.make(role1Revision));
      expect([readCells[0]?.deadline, readCells[0]?.amountCeiling]).toEqual([undefined, undefined]);
      expect(Schema.is(Schema.TaggedStruct('all', {}))(readCells[0]?.selector)).toBe(true);
      const payCells = yield* loader.loadAuthorityCells(schema.scopeAkros, {
        capabilityKey: capability(payKey),
        holder: person(jana),
        mode: 'run',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      expect(payCells.map(({ amountCeiling }) => amountCeiling)).toEqual([{ currency: 'CZK', limitMinor: 100_000 }]);
      // The revoked delegation leaves no cell behind, rather than a wider one.
      expect(
        yield* loader.loadAuthorityCells(schema.scopeAkros, {
          capabilityKey: capability(voidKey),
          holder: person(eva),
          mode: 'run',
          scopeId: AccessScopeIdSchema.make(scopeAkros),
          tenantId: TenantIdSchema.make(tenantA),
        }),
      ).toEqual([]);
      // An expired assignment grants nothing, and an agent's own cells never stand in for a person's.
      expect(
        yield* loader.loadAuthorityCells(schema.scopeNajempark, {
          capabilityKey: capability(readKey),
          holder: person(jana),
          mode: 'run',
          scopeId: AccessScopeIdSchema.make(scopeNajempark),
          tenantId: TenantIdSchema.make(tenantA),
        }),
      ).toEqual([]);
      expect(
        yield* loader.loadAuthorityCells(schema.scopeAkros, {
          capabilityKey: capability(readKey),
          holder: agentHolder(janaAgent),
          mode: 'run',
          scopeId: AccessScopeIdSchema.make(scopeAkros),
          tenantId: TenantIdSchema.make(tenantA),
        }),
      ).toEqual([]);
      // One batched read answers every query exactly as it answers alone, in the asked order, across holders,
      // scopes, modes and capabilities — including the revoked delegation, the expired and the agent's queries.
      const cellQueries = [
        { capabilityKey: capability(readKey), holder: person(jana), scope: scopeAkros },
        { capabilityKey: capability(payKey), holder: person(jana), scope: scopeAkros },
        { capabilityKey: capability(voidKey), holder: person(eva), scope: scopeAkros },
        { capabilityKey: capability(readKey), holder: person(jana), scope: scopeNajempark },
        { capabilityKey: capability(readKey), holder: agentHolder(janaAgent), scope: scopeAkros },
        { capabilityKey: capability(readKey), holder: person(jana), mode: 'propose' as const, scope: scopeAkros },
      ].map(({ capabilityKey, holder, mode, scope }) => ({
        capabilityKey,
        holder,
        mode: mode ?? ('run' as const),
        scopeId: AccessScopeIdSchema.make(scope),
        tenantId: TenantIdSchema.make(tenantA),
      }));
      const alone = yield* Effect.forEach(cellQueries, (query) => loader.loadAuthorityCells(schema.scopeAkros, query), {
        concurrency: 1,
      });
      expect(yield* loader.loadAuthorityCellsMany(schema.scopeAkros, cellQueries)).toEqual(alone);
      expect(alone[0]).toEqual(readCells);
      expect(yield* loader.loadAuthorityCellsMany(schema.scopeAkros, [])).toEqual([]);
      const foreignBatch = yield* failureOf(
        loader.loadAuthorityCellsMany(schema.scopeTenant, [
          {
            capabilityKey: capability(readKey),
            holder: person(jana),
            mode: 'run',
            scopeId: AccessScopeIdSchema.make(scopeAkros),
            tenantId: TenantIdSchema.make(tenantB),
          },
        ]),
      );
      expect(foreignBatch?.code).toBe('access_intent_scope_mismatch');

      // ---- the connection read is fresh, consented and revision-exact (guarantee 6) -------------
      const connection = yield* loader.loadConnection(schema.scopeTenant, {
        connectionId: AgentConnectionIdSchema.make(connectionCurrent),
        tenantId: TenantIdSchema.make(tenantA),
      });
      const resolvedConnection = Option.getOrThrowWith(connection, () => new Error('the connection must resolve'));
      expect(resolvedConnection).toEqual({
        agentId: AgentIdSchema.make(janaAgent),
        ceiling: { cells: [{ capabilityKey: capability(readKey), mode: 'run', selector: { _tag: 'all' } }] },
        connectionId: AgentConnectionIdSchema.make(connectionCurrent),
        consentRevision: 2,
        deadline: resolvedConnection.deadline,
        principalId: PrincipalIdSchema.make(jana),
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        status: 'active',
      });
      expect(resolvedConnection.deadline > (yield* liveNow())).toBe(true);
      // A connection whose current revision has no consent snapshot has no authority at all.
      expect(
        Option.isNone(
          yield* loader.loadConnection(schema.scopeTenant, {
            connectionId: AgentConnectionIdSchema.make(connectionNoConsent),
            tenantId: TenantIdSchema.make(tenantA),
          }),
        ),
      ).toBe(true);
      expect(
        Option.isNone(
          yield* loader.loadConnection(schema.scopeTenant, {
            connectionId: AgentConnectionIdSchema.make(uid(99)),
            tenantId: TenantIdSchema.make(tenantA),
          }),
        ),
      ).toBe(true);

      // ---- the team read is the list predicate's scope, for a person and for an agent (B1) -----
      expect(
        (yield* loader.loadTeamIds(schema.scopeAkros, {
          holder: person(jana),
          scopeId: AccessScopeIdSchema.make(scopeAkros),
          tenantId: TenantIdSchema.make(tenantA),
        })).map((id) => id),
      ).toEqual([AccessTeamIdSchema.make(team)]);
      expect(
        (yield* loader.loadTeamIds(schema.scopeAkros, {
          holder: agentHolder(janaAgent),
          scopeId: AccessScopeIdSchema.make(scopeAkros),
          tenantId: TenantIdSchema.make(tenantA),
        })).map((id) => id),
      ).toEqual([AccessTeamIdSchema.make(team)]);
      // A team reaches only its own scope.
      expect(
        yield* loader.loadTeamIds(schema.scopeNajempark, {
          holder: person(jana),
          scopeId: AccessScopeIdSchema.make(scopeNajempark),
          tenantId: TenantIdSchema.make(tenantA),
        }),
      ).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)('the tenant intent loader over delegated money limits', (suite) => {
  suite.effect(
    'answers with the envelope ceiling and drops a cell the envelope never bounded in its own currency',
    Effect.fnUntraced(function* delegatedMoneyCeilings() {
      const schema = yield* makeIntentLoaderSchema;
      yield* seedDelegatedMoney(schema.admin);
      const loader = onLiveClock(schema.loader);
      const cells = yield* loader.loadAuthorityCells(schema.scopeAkros, {
        capabilityKey: capability(payKey),
        holder: person(jana),
        mode: 'run',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      const assignmentIds = {
        capped: AssignmentIncarnationIdSchema.make(assignmentCapped),
        euro: AssignmentIncarnationIdSchema.make(assignmentEuro),
        uncapped: AssignmentIncarnationIdSchema.make(assignmentUncapped),
      };
      const ceilingsOf = new Map(cells.map((cell) => [cell.assignmentIncarnationId, cell.amountCeiling]));
      // A cell capped at 50 000 CZK is narrowed to the 10 000 the delegation allowed (D10b).
      expect(ceilingsOf.get(assignmentIds.capped)).toEqual({ currency: 'CZK', limitMinor: 10_000 });
      // An uncapped cell under a capped envelope takes the envelope's ceiling instead of unlimited money.
      expect(ceilingsOf.get(assignmentIds.uncapped)).toEqual({ currency: 'CZK', limitMinor: 10_000 });
      // An envelope that froze its limit in another currency bounds nothing, so the cell is dropped.
      expect(ceilingsOf.has(assignmentIds.euro)).toBe(false);
      expect(cells.map(({ assignmentIncarnationId }) => assignmentIncarnationId).toSorted()).toEqual(
        [assignmentIds.capped, assignmentIds.uncapped].toSorted(),
      );

      // The same capped assignments grant a plain read, which governs no amount: the delegation's money
      // limit never reaches it, so it is not dropped and carries no ceiling, whatever the currency.
      const reads = yield* loader.loadAuthorityCells(schema.scopeAkros, {
        capabilityKey: capability(readKey),
        holder: person(jana),
        mode: 'run',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      expect(reads.map(({ assignmentIncarnationId }) => assignmentIncarnationId).toSorted()).toEqual(
        [assignmentIds.capped, assignmentIds.euro].toSorted(),
      );
      expect(reads.map(({ amountCeiling }) => amountCeiling)).toEqual([undefined, undefined]);

      // A capability the pinned release does not declare cannot say whether a money limit applies, so
      // a delegated read leaves it out (fail closed).
      const unknown = yield* loader.loadAuthorityCells(schema.scopeAkros, {
        capabilityKey: capability(unknownKey),
        holder: person(jana),
        mode: 'run',
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      });
      expect(unknown).toEqual([]);

      // The batched read applies the same envelopes and catalog entries per capability, and answers queries of
      // other scopes, modes and holders in the same batch exactly as each alone, in the asked order.
      const delegatedQueries = [payKey, readKey, unknownKey].map((key) => ({
        capabilityKey: capability(key),
        holder: person(jana),
        mode: 'run' as const,
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      }));
      const asked = {
        capabilityKey: capability(readKey),
        holder: person(jana),
        mode: 'run' as const,
        scopeId: AccessScopeIdSchema.make(scopeAkros),
        tenantId: TenantIdSchema.make(tenantA),
      };
      const otherQueries = [
        { ...asked, capabilityKey: capability(payKey), mode: 'propose' as const },
        { ...asked, scopeId: AccessScopeIdSchema.make(scopeNajempark) },
        { ...asked, holder: person(eva) },
      ];
      const otherAlone = yield* Effect.forEach(
        otherQueries,
        (query) => loader.loadAuthorityCells(schema.scopeAkros, query),
        { concurrency: 1 },
      );
      expect(yield* loader.loadAuthorityCellsMany(schema.scopeAkros, [...delegatedQueries, ...otherQueries])).toEqual([
        cells,
        reads,
        unknown,
        ...otherAlone,
      ]);

      // Independent of the single read: batches answered against cells written out by hand. Each holder has a
      // delegated role (capped at the envelope's CZK 10 000, ending at the earliest of its assignment, envelope and
      // delegation) and a role of its own.
      const fixedQueries = (holder: ReturnType<typeof person> | ReturnType<typeof agentHolder>) =>
        [payKey, readKey, unknownKey].map((key) => ({
          capabilityKey: capability(key),
          holder,
          mode: 'run' as const,
          scopeId: AccessScopeIdSchema.make(scopeAkros),
          tenantId: TenantIdSchema.make(tenantA),
        }));
      const ownPay = (holder: ReturnType<typeof person> | ReturnType<typeof agentHolder>, assignment: string) =>
        expectedCell({
          assignedBy: jana,
          assignment,
          capabilityKey: payKey,
          deadline: '2095-01-01T00:00:00Z',
          grant: grantUncapped,
          holder,
          revision: roleUncappedRevision,
          role: roleUncapped,
        });
      const delegated = (capabilityKey: string, grant: string, ceiling?: ExpectedCeiling) =>
        expectedCell({
          assignedBy: eva,
          assignment: assignmentOndraCapped,
          capabilityKey,
          ceiling,
          deadline: '2096-01-01T00:00:00Z',
          grant,
          holder: person(ondra),
          revision: roleCappedRevision,
          role: roleCapped,
        });

      // (a)+(b) A person with two roles: the pay capability answers with both cells, the delegated one narrowed
      // from the role's CZK 50 000 to the envelope's CZK 10 000; the read is not amount-governed and keeps no ceiling.
      const ondraAnswers = yield* loader.loadAuthorityCellsMany(schema.scopeAkros, fixedQueries(person(ondra)));
      expect(ondraAnswers).toHaveLength(3);
      expect(byAssignment(ondraAnswers[0])).toEqual(
        byAssignment([
          delegated(payKey, grantCapped, ENVELOPE_CEILING),
          ownPay(person(ondra), assignmentOndraUncapped),
        ]),
      );
      expect(ondraAnswers[1]).toEqual([delegated(readKey, grantCappedRead)]);
      // (c) A capability the pinned catalog does not know leaves no delegated cell (fail closed).
      expect(ondraAnswers[2]).toEqual([]);

      // An agent: a delegation names people, so the agent's delegated role yields no cell at all (fail closed,
      // `delegatedCellCeiling`); only its own role answers. The unknown capability answers nothing either.
      const agentAnswers = yield* loader.loadAuthorityCellsMany(
        schema.scopeAkros,
        fixedQueries(agentHolder(janaAgent)),
      );
      expect(agentAnswers).toEqual([[ownPay(agentHolder(janaAgent), assignmentAgentUncapped)], [], []]);
    }),
  );
});

/**
 * Reads the company administration membership twice inside ONE transaction, with a real writer
 * committing a suspension between the two SELECTs.
 *
 * The interleaving is exact rather than hoped for: the writer is a single autocommitted UPDATE that
 * waits on a Deferred the reader releases after its first SELECT, and the reader then waits for that
 * commit before its second SELECT. Nothing here is timed, so the two reads are guaranteed to straddle
 * a committed change; and the change itself is then read again by a fresh transaction, so a reader that
 * keeps one snapshot is never mistaken for a reader that loses the update.
 */

/** The status of the one company-administration membership this suite watches, as one read sees it. */
const adminMembershipStatuses = (transaction: CoreTransaction) =>
  transaction
    .select({ status: accessMemberships.status })
    .from(accessMemberships)
    .where(eq(accessMemberships.membershipId, membershipAdminAkros))
    .pipe(Effect.map((rows) => rows.map(({ status }) => status)));

/** The one autocommitted UPDATE this suite races the reader with, released by the reader's first read. */
const suspendAfterFirstRead = (input: {
  readonly admin: PgClient.PgClient;
  readonly committed: Deferred.Deferred<boolean>;
  readonly firstReadDone: Deferred.Deferred<boolean>;
}) =>
  Effect.gen(function* commitSuspension() {
    yield* Deferred.await(input.firstReadDone);
    yield* input.admin
      .unsafe(
        `update "core"."access_memberships" set status = 'suspended' where membership_id = '${membershipAdminAkros}'`,
      )
      .pipe(Effect.orDie);
    yield* Deferred.succeed(input.committed, true);
  });

/** Two SELECTs of ONE transaction, with the writer's commit guaranteed to land between them. */
const readStatusesAroundCommit =
  (input: { readonly committed: Deferred.Deferred<boolean>; readonly firstReadDone: Deferred.Deferred<boolean> }) =>
  (transaction: CoreTransaction) =>
    Effect.gen(function* twoReadsOfOneTransaction() {
      const before = yield* adminMembershipStatuses(transaction);
      yield* Deferred.succeed(input.firstReadDone, true);
      yield* Deferred.await(input.committed);
      const after = yield* adminMembershipStatuses(transaction);
      return { after, before };
    });

const statusesAcrossCommittedSuspension = (input: {
  readonly admin: PgClient.PgClient;
  readonly database: AccessIntentDatabase;
  readonly run: ScopedRun;
  readonly scope: OperationalScope;
}) =>
  Effect.gen(function* statusesAcrossCommittedSuspensionEffect() {
    const firstReadDone = yield* Deferred.make<boolean>();
    const committed = yield* Deferred.make<boolean>();
    const gates = { committed, firstReadDone };
    const writer = yield* Effect.forkChild(suspendAfterFirstRead({ admin: input.admin, ...gates }));
    const seen = yield* input.run(input.database, input.scope, new Set<string>(), readStatusesAroundCommit(gates));
    yield* Fiber.join(writer);
    const next = yield* input.run(input.database, input.scope, new Set<string>(), adminMembershipStatuses);
    return { ...seen, next };
  });

/** The basis kinds one configure-bases read answers with, named without comparing `_tag` by hand. */
const basisKinds = (bases: readonly AccessConfigureBasis[]): readonly string[] =>
  bases.map((basis) =>
    Match.value(basis).pipe(
      Match.tag('Owner', () => 'owner'),
      Match.tag('ScopeAdmin', () => 'scope-admin'),
      Match.tag('DelegatedManager', () => 'delegated-manager'),
      Match.exhaustive,
    ),
  );

it.layer(NodeServices.layer)('the tenant intent loader read snapshot', (suite) => {
  suite.effect(
    'answers every SELECT of one read from one snapshot, and the next read from the committed change',
    Effect.fnUntraced(function* oneSnapshotAcrossSelects() {
      const schema = yield* makeIntentLoaderSchema;
      yield* seedIntent(schema.admin);
      yield* seedMemberships(schema);
      const database: AccessIntentDatabase = {
        enrollment: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        executor: schema.runtimeDatabase,
      };
      const shared = { admin: schema.admin, database, scope: schema.scopeTenant };
      const loader = onLiveClock(schema.loader);
      const bases = Effect.fn('readConfigureBases')(function* readConfigureBasesEffect() {
        return yield* loader.loadConfigureBases(schema.scopeTenant, {
          actor: PrincipalIdSchema.make(jana),
          at: yield* liveNow(),
          tenantId: TenantIdSchema.make(tenantA),
        });
      });
      const suspend = (status: 'active' | 'suspended') =>
        schema.admin
          .unsafe(
            `update "core"."access_memberships" set status = '${status}' where membership_id = '${membershipAdminAkros}'`,
          )
          .pipe(Effect.orDie);
      // The company administration this suite watches is live intent to begin with (O81).
      expect(basisKinds(yield* bases())).toEqual(['owner', 'scope-admin']);

      // Control: the same interleaving at the isolation the intent stores run with really does mix two
      // snapshots, which is what proves the gate lands between the two SELECTs rather than before them.
      const mixed = yield* statusesAcrossCommittedSuspension({ ...shared, run: runScoped });
      expect(mixed).toEqual({ after: ['suspended'], before: ['active'], next: ['suspended'] });

      yield* suspend('active');

      // The loader's own read isolation: a suspension committed between two SELECTs is not half-observed,
      // and the change is not lost either - a new read finds it.
      const coherent = yield* statusesAcrossCommittedSuspension({ ...shared, run: runScopedRead });
      expect(coherent).toEqual({ after: ['active'], before: ['active'], next: ['suspended'] });

      // The committed suspension is intent the next decision sees: the company administration basis is
      // gone from the configure bases the admin key is admitted from, and the owner basis stays (O81).
      expect(basisKinds(yield* bases())).toEqual(['owner']);
    }),
  );
});
