import { v1 } from '@authzed/authzed-node';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { NodeCrypto } from '@effect/platform-node';
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Predicate,
  Redacted,
  Result,
  Schema,
  Scope,
} from 'effect';
import { assert, afterAll, expect, it, rs } from 'effect-rstest';

import { AccessIntent } from '../../src/access/decision/authority.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { AccessPrincipalKindSource } from '../../src/access/enforcement/actor.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import type { GateCarrier } from '../../src/access/enforcement/contract.ts';
import { AccessDecisionLog } from '../../src/access/enforcement/decision-log.ts';
import { LegalEntityCandidates } from '../../src/access/enforcement/legal-entities.ts';
import {
  AccessScopeIdSchema,
  AgentConnectionIdSchema,
  CapabilityKeySchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ActionRuntime } from '../../src/actions/runtime.ts';
import { decodeAccessDeclarationOrThrow } from '../../src/authorization/access-declaration.ts';
import type { AccessDeclarationInput } from '../../src/authorization/access-declaration.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import type { DatabaseConfigValue } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext, SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
import {
  accessScopeFences,
  accessScopes,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { OperationalScopeResolver } from '../../src/operations/context.ts';
import {
  ContextAccess,
  toContextPermissionAccessObjectId,
  toIdentityNamespaceAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../src/permissions/context-access.ts';
import { ReadRuntime } from '../../src/reads/runtime.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT, FIXTURE_REQUEST_IDENTITY } from '../support/database-identities.ts';

import {
  makeLiveOperationFixture,
  makeLiveOperationFixtureRuntime,
  makeLiveOperationFixtureBootstrap,
  LiveOperationFixtureRuntimeHandoffSchema,
  LiveOperationFixtureBootstrapRequestSchema,
} from '../../src/testing/live-operations.ts';

type FixtureReadTable =
  | typeof principals
  | typeof legalEntities
  | typeof tenants
  | typeof principalAuthBindings
  | typeof tenantModuleStates;
type FixtureServiceRow = Pick<typeof principals.$inferSelect, 'kind' | 'principalId' | 'status' | 'tenantId'>;
type FixtureEntityRow = Pick<typeof legalEntities.$inferSelect, 'legalEntityId' | 'status' | 'tenantId'>;
type FixtureReadRow =
  | FixtureServiceRow
  | FixtureEntityRow
  | Pick<typeof tenants.$inferInsert, 'tenantId' | 'status'>
  | typeof principalAuthBindings.$inferInsert
  | typeof tenantModuleStates.$inferInsert;

type FixtureInsertTable =
  | typeof accessScopes
  | typeof accessScopeFences
  | typeof legalEntities
  | typeof principalAuthBindings
  | typeof principals
  | typeof tenantModuleStates
  | typeof tenants;
type FixtureInsertRow =
  | typeof accessScopes.$inferInsert
  | typeof accessScopeFences.$inferInsert
  | typeof legalEntities.$inferInsert
  | typeof principalAuthBindings.$inferInsert
  | typeof principals.$inferInsert
  | typeof tenantModuleStates.$inferInsert
  | typeof tenants.$inferInsert;
type FixtureInsertValues = FixtureInsertRow | readonly FixtureInsertRow[];

class FixtureModuleStateUpdateFailure extends Schema.TaggedError<FixtureModuleStateUpdateFailure>()(
  'FixtureModuleStateUpdateFailure',
  {},
) {}

const transport = rs.hoisted(() => ({
  checkPermission: rs.fn<(request: v1.CheckPermissionRequest) => Promise<v1.CheckPermissionResponse>>(),
  closeDatabase: rs.fn<(role: string) => void>(),
  connectionInsert: rs.fn<(role: string, table: FixtureInsertTable) => void>(),
  executeStatement: rs.fn<(statement: string) => void>(),
  insert: rs.fn<(table: FixtureInsertTable, value: FixtureInsertValues) => void>(),
  nativeRows: rs.fn<
    () => readonly {
      readonly bypass: boolean;
      readonly createDb: boolean;
      readonly createRole: boolean;
      readonly database: string;
      readonly role: string;
      readonly session: string;
      readonly superuser: boolean;
    }[]
  >(),
  openDatabase: rs.fn<(role: string) => void>(),
  selectRows: rs.fn<(table: FixtureReadTable, predicate?: SQL) => readonly FixtureReadRow[]>(),
  updateRows:
    rs.fn<
      (
        table: typeof tenantModuleStates,
        values: { readonly state: string },
        predicate: SQL,
      ) => Effect.Effect<
        readonly { readonly moduleKey: string; readonly tenantId: string }[],
        FixtureModuleStateUpdateFailure
      >
    >(),
  writeRelationships: rs.fn<(request: v1.WriteRelationshipsRequest) => Promise<v1.WriteRelationshipsResponse>>(),
}));

// A plain insert is itself the write; `onConflictDoNothing` is the production bootstrap's re-run-safe form of it.
const fixtureInsert = (table: FixtureInsertTable, role: string) => ({
  values: (value: FixtureInsertValues) => {
    const write = Effect.sync(() => {
      transport.connectionInsert(role, table);
      transport.insert(table, value);
    });
    return Object.assign(write, { onConflictDoNothing: () => write });
  },
});

const fixtureSelect = () => ({
  from: (table: FixtureReadTable) => ({
    where: (predicate?: SQL) => Effect.sync(() => transport.selectRows(table, predicate)),
  }),
});

const fixtureUpdate = (table: typeof tenantModuleStates) => ({
  set: (values: { readonly state: string }) => ({
    where: (predicate: SQL) => ({
      returning: () => transport.updateRows(table, values, predicate),
    }),
  }),
});

const fixtureDelete = () => ({
  where: () => Effect.die(new Error('The live fixture transport does not model DELETE statements')),
});

// The scripted connection uses the declared shared runtime identity, whose scope authority is
// session settings. Unknown roles must not acquire that authority merely by returning the settings.
const fixtureRuntimeRole = SHARED_RUNTIME_IDENTITY.role;

/** The real pool closes with the scope that owns it; mirror that so a test can prove both pools die. */
const closeFixtureDatabaseWithScope = (role: string) =>
  Effect.addFinalizer(() => Effect.sync(() => transport.closeDatabase(role)));

/**
 * One transaction's session settings. `set_config(..., true)` is transaction-local in Postgres, so each
 * transaction opens a fresh store and a scope installed in one transaction is never visible to another.
 */
const makeFixtureTransactionExecutor = (role: string) => {
  const sessionSettings = new Map<string, string>();
  return {
    delete: fixtureDelete,
    execute: (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement);
      // Statements run when the Effect is run, not when the Core builds it, so a verify that is built
      // before the install reads the settings the install has written by then.
      if (query.sql.includes('set_config(')) {
        const [tenantId, legalEntityId] = query.params;
        return Effect.sync(() => {
          transport.executeStatement(query.sql);
          sessionSettings.set('ontos.tenant_id', String(tenantId));
          sessionSettings.set('ontos.legal_entity_id', String(legalEntityId));
          return [];
        });
      }
      if (query.sql.includes('current_setting(')) {
        return Effect.sync(() => {
          transport.executeStatement(query.sql);
          return [
            {
              legal_entity_id: sessionSettings.get('ontos.legal_entity_id') ?? '',
              role,
              tenant_id: sessionSettings.get('ontos.tenant_id') ?? '',
            },
          ];
        });
      }
      return Effect.sync(() => {
        transport.executeStatement(query.sql);
        return transport.nativeRows();
      });
    },
    insert: (table: FixtureInsertTable) => fixtureInsert(table, role),
    select: fixtureSelect,
    update: fixtureUpdate,
  };
};

// Only external connections are replaced. The public fixture generates its actors and provisions its real tuples.
rs.mock('../../src/db/client.ts', () => ({
  ...rs.requireActual('../../src/db/client.ts'),
  makeCoreDatabase: (configuration: Pick<DatabaseConfigValue, 'expectedRole'>) => {
    const { expectedRole } = configuration;
    transport.openDatabase(expectedRole);
    const executor = makeFixtureTransactionExecutor(expectedRole);
    return Effect.succeed({
      executor: {
        ...executor,
        transaction: <Value, Failure, Requirements>(
          operation: (
            transaction: ReturnType<typeof makeFixtureTransactionExecutor>,
          ) => Effect.Effect<Value, Failure, Requirements>,
        ) => operation(makeFixtureTransactionExecutor(expectedRole)),
      },
    }).pipe(Effect.tap(() => closeFixtureDatabaseWithScope(expectedRole)));
  },
}));
rs.mock('../../src/permissions/config.ts', () => ({
  ...rs.requireActual('../../src/permissions/config.ts'),
  loadSpiceDbConfig: () => Effect.succeed({ endpoint: 'localhost:50051', preSharedKey: 'unit-only' }),
}));
rs.mock('../../src/permissions/spicedb-grpc-rpc.ts', () => ({
  ...rs.requireActual('../../src/permissions/spicedb-grpc-rpc.ts'),
  newSpiceDbGrpcClient: () => ({
    close: () => {},
    promises: { checkPermission: transport.checkPermission, writeRelationships: transport.writeRelationships },
  }),
}));

// With `isolate: false` one module registry is shared by every file a worker runs, so these
// replacements outlive this file and would leak into whatever runs next. Remove them and drop the
// modules they replaced, so the next file evaluates the real implementations.
afterAll(() => {
  rs.doUnmock('../../src/db/client.ts');
  rs.doUnmock('../../src/permissions/config.ts');
  rs.doUnmock('../../src/permissions/spicedb-grpc-rpc.ts');
  rs.resetModules();
});

const configuration = {
  actionKeys: ['commerce.catalog.activate-local-override', 'commerce.catalog.change-local-override'],
  adminConnectionString: Redacted.make('postgresql://unit_admin:unit@127.0.0.1/unit'),
  authenticationNamespaceId: 'fixture-manager-unit',
  compositionRevision: 'a'.repeat(64),
  runtimeConnectionString: Redacted.make(`postgresql://${fixtureRuntimeRole}:unit@127.0.0.1/unit`),
};

/** A dedicated gateway-grant actor role: it may never be granted session-setting scope authority. */
const dedicatedRuntimeConnectionString = Redacted.make(
  `postgresql://${FIXTURE_REQUEST_IDENTITY.role}:unit@127.0.0.1/unit`,
);
/** The shared runtime credential on the same disposable target; enrolled session-setting authority. */
const sharedBootstrapConnectionString = Redacted.make(`postgresql://${fixtureRuntimeRole}:unit@127.0.0.1/unit`);

const commerceProvisioningNamespace = 'ontos.commerce.portal.better-auth.v1';
const namespaceResourceType = 'identity_namespace';

const existingServiceId = '00000000-0000-4000-8000-000000001257';
const mockExistingService = (fixture: { readonly legalEntityId: string; readonly tenantId: string }) => {
  const service: FixtureServiceRow = {
    kind: 'service',
    principalId: existingServiceId,
    status: 'active',
    tenantId: fixture.tenantId,
  };
  const entity: FixtureEntityRow = {
    legalEntityId: fixture.legalEntityId,
    status: 'active',
    tenantId: fixture.tenantId,
  };
  transport.selectRows.mockImplementation((table) => (table === principals ? [service] : [entity]));
  return { entity, service };
};
const permissionResponse = (allowed: boolean) =>
  v1.CheckPermissionResponse.create({
    permissionship: allowed
      ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
      : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
  });

/** One protected capability the gate scripts: the key the per-key map routes on. */
const gateCapabilityKey = 'party.registry.party.read';
const gateCarrier = {
  accessDeclaration: decodeAccessDeclarationOrThrow(
    {
      key: gateCapabilityKey,
      kind: 'read',
      modes: ['run'],
      placement: { group: 'parties', level: 'basic' },
      risk: 'routine',
      selectors: [],
    } satisfies AccessDeclarationInput,
    defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'party.registry.api.party-list',
      moduleKey: 'party.registry',
      role: 'api',
    }),
  ),
} satisfies GateCarrier;
/** A request scope the scripted double never reads: it answers from the spec alone. */
const gateScope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '00000000-0000-4000-8000-0000000004a1',
    authContextRef: 'session:live-fixture-unit',
    authMethod: 'session',
    principalId: '00000000-0000-4000-8000-0000000004a2',
    tenantId: '00000000-0000-4000-8000-0000000004a3',
  }),
  correlationId: 'live-fixture-unit',
};
const gateDecisionTime = DateTime.toDateUtc(DateTime.makeUnsafe('2030-01-01T00:00:00Z'));

/** The fixture's scripted answer for one carrier, asked the way the runners ask it. */
const decideFixtureAccess = (
  fixture: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>,
  carrier: GateCarrier,
) =>
  fixture.scriptedAccess.bound.decide({
    carrier,
    legalEntityScope: 'forbidden',
    now: gateDecisionTime,
    scope: gateScope,
  });

const fixtureIoCounts = () => ({
  checks: transport.checkPermission.mock.calls.length,
  connections: transport.openDatabase.mock.calls.length,
  inserts: transport.insert.mock.calls.length,
  nativeReads: transport.nativeRows.mock.calls.length,
  selects: transport.selectRows.mock.calls.length,
  statements: transport.executeStatement.mock.calls.length,
  updates: transport.updateRows.mock.calls.length,
  writes: transport.writeRelationships.mock.calls.length,
});

it.layer(NodeCrypto.layer)('live operation fixture', (suite) => {
  suite.effect('keeps identity provisioning on admin and scoped bootstrap on the enrolled runtime', () =>
    Effect.scoped(
      Effect.gen(function* separateBootstrapAuthorities() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const start = transport.connectionInsert.mock.calls.length;
        const opens = transport.openDatabase.mock.calls.length;
        const fixture = yield* makeLiveOperationFixture(configuration);
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const writes = transport.connectionInsert.mock.calls.slice(start);
        expect(writes).toContainEqual(['unit_admin', tenants]);
        expect(writes).toContainEqual(['unit_admin', principals]);
        const scopedRoles = writes
          .filter((call) => call[1] === accessScopes || call[1] === accessScopeFences)
          .map((call) => call[0]);
        expect(scopedRoles).toEqual([fixtureRuntimeRole, fixtureRuntimeRole]);
        // No separate bootstrap credential means no second runtime pool: the runtime executor is reused.
        expect(transport.openDatabase.mock.calls.slice(opens).map(([role]) => role)).toEqual([
          fixtureRuntimeRole,
          'unit_admin',
        ]);
      }),
    ),
  );

  suite.effect('refuses scoped bootstrap on an unenrolled runtime role', () =>
    Effect.gen(function* refuseUnknownBootstrapRole() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          runtimeConnectionString: Redacted.make('postgresql://unregistered_fixture_runtime:unit@127.0.0.1/unit'),
        }),
      );
      expect(failure.reason).toBe('Unable to seed the live fixture access fences');
    }),
  );

  suite.effect(
    'keeps a dedicated gateway-grant actor runtime while scoped writers use the explicit bootstrap credential',
    () =>
      Effect.scoped(
        Effect.gen(function* separateActorRuntimeFromBootstrapAuthority() {
          transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
          const start = transport.connectionInsert.mock.calls.length;
          const opens = transport.openDatabase.mock.calls.length;
          const fixture = yield* makeLiveOperationFixture({
            ...configuration,
            bootstrapConnectionString: sharedBootstrapConnectionString,
            databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: dedicatedRuntimeConnectionString,
          });
          yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
          const writes = transport.connectionInsert.mock.calls.slice(start);
          expect(writes).toContainEqual(['unit_admin', tenants]);
          expect(writes).toContainEqual(['unit_admin', principals]);
          const scopedRoles = writes
            .filter((call) => call[1] === accessScopes || call[1] === accessScopeFences)
            .map((call) => call[0]);
          // Scope installs through the session-setting bootstrap identity, never the gateway-grant actor.
          expect(scopedRoles).toEqual([fixtureRuntimeRole, fixtureRuntimeRole]);
          // Two pools: the actor runtime keeps its dedicated role and the scoped writer takes the bootstrap.
          expect(transport.openDatabase.mock.calls.slice(opens).map(([role]) => role)).toEqual([
            FIXTURE_REQUEST_IDENTITY.role,
            fixtureRuntimeRole,
            'unit_admin',
          ]);
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
            fixture.runtimeHandoff,
          );
          // The creation-only bootstrap credential never reaches the serial handoff or its target pin.
          expect(encoded).not.toContain('bootstrapConnectionString');
          expect(encoded).not.toContain(fixtureRuntimeRole);
          expect(encoded).toContain(FIXTURE_REQUEST_IDENTITY.role);
        }),
      ),
  );

  suite.effect('refuses a bootstrap credential outside the runtime disposable local target before any write', () =>
    Effect.gen(function* refuseForeignBootstrapTarget() {
      const before = fixtureIoCounts();
      for (const [bootstrap, reason] of [
        [
          'postgresql://ontos_runtime:unit@127.0.0.1/other',
          'Fixture bootstrap credential must target the runtime disposable local database',
        ],
        [
          'postgresql://ontos_runtime:unit@127.0.0.1:5433/unit',
          'Fixture bootstrap credential must target the runtime disposable local database',
        ],
        [
          'postgresql://ontos_runtime:unit@db.example.test/unit',
          'Live test fixtures require disposable localhost services',
        ],
        ['postgresql://ontos_runtime:unit@10.0.0.5/unit', 'Live test fixtures require disposable localhost services'],
      ] as const) {
        const failure = yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            bootstrapConnectionString: Redacted.make(bootstrap),
            databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: dedicatedRuntimeConnectionString,
          }),
        );
        expect(failure.reason).toBe(reason);
      }
      expect(fixtureIoCounts()).toEqual(before);
    }),
  );

  suite.effect('refuses an explicit bootstrap credential without session-setting scope authority', () =>
    Effect.gen(function* refuseUnenrolledBootstrapCredential() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const bootstrapRole of ['unregistered_fixture_bootstrap', FIXTURE_REQUEST_IDENTITY.role]) {
        const failure = yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            bootstrapConnectionString: Redacted.make(`postgresql://${bootstrapRole}:unit@127.0.0.1/unit`),
            databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
            runtimeConnectionString: dedicatedRuntimeConnectionString,
          }),
        );
        expect(failure.reason).toBe('Unable to seed the live fixture access fences');
      }
    }),
  );

  suite.effect('closes the actor pool when bootstrap acquisition fails', () =>
    Effect.gen(function* failedBootstrapAcquisition() {
      const before = transport.closeDatabase.mock.calls.length;
      transport.openDatabase.mockImplementation((role) => {
        if (role === fixtureRuntimeRole) {
          throw new Error('Bootstrap pool acquisition failed');
        }
      });
      const outcome = yield* Effect.exit(
        makeLiveOperationFixture({
          ...configuration,
          bootstrapConnectionString: sharedBootstrapConnectionString,
          databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          runtimeConnectionString: dedicatedRuntimeConnectionString,
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => transport.openDatabase.mockReset())));
      expect(Exit.isFailure(outcome)).toBe(true);
      expect(transport.closeDatabase.mock.calls.slice(before).map(([role]) => role)).toEqual([
        FIXTURE_REQUEST_IDENTITY.role,
      ]);
    }),
  );

  suite.effect('closes the actor and bootstrap pools on failure and on interruption', () =>
    Effect.gen(function* closeBothAuthorityPools() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const failedBefore = transport.closeDatabase.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          bootstrapConnectionString: Redacted.make('postgresql://unregistered_fixture_bootstrap:unit@127.0.0.1/unit'),
          databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
          runtimeConnectionString: dedicatedRuntimeConnectionString,
        }),
      );
      expect(failure.reason).toBe('Unable to seed the live fixture access fences');
      const closedOnFailure = transport.closeDatabase.mock.calls.slice(failedBefore).map(([role]) => role);
      expect(closedOnFailure).toContain(FIXTURE_REQUEST_IDENTITY.role);
      expect(closedOnFailure).toContain('unregistered_fixture_bootstrap');
      expect(closedOnFailure).toContain('unit_admin');

      // The fiber suspends on the first SpiceDB write, after the actor and bootstrap pools are open.
      const reachedWrite = yield* Deferred.make<null>();
      const pendingWrite = Promise.withResolvers<v1.WriteRelationshipsResponse>();
      transport.writeRelationships.mockImplementation(() => {
        Deferred.doneUnsafe(reachedWrite, Effect.succeed(null));
        return pendingWrite.promise;
      });
      const interruptedBefore = transport.closeDatabase.mock.calls.length;
      const running = yield* makeLiveOperationFixture({
        ...configuration,
        bootstrapConnectionString: sharedBootstrapConnectionString,
        databaseIdentities: FIXTURE_DATABASE_IDENTITY_ENROLLMENT,
        runtimeConnectionString: dedicatedRuntimeConnectionString,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(reachedWrite);
      yield* Fiber.interrupt(running);
      const closedOnInterrupt = transport.closeDatabase.mock.calls.slice(interruptedBefore).map(([role]) => role);
      expect(closedOnInterrupt).toContain(FIXTURE_REQUEST_IDENTITY.role);
      expect(closedOnInterrupt).toContain(fixtureRuntimeRole);
      transport.writeRelationships.mockReset();
      transport.openDatabase.mockReset();
    }),
  );

  suite.effect('exports its exact services through one memoized layer without extra SQL, grants or connections', () =>
    Effect.scoped(
      Effect.gen(function* captureOriginalFixtureServices() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const fixture = yield* makeLiveOperationFixture({ ...configuration, access: 'allowed' });
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const before = fixtureIoCounts();
        const memoMap = yield* Layer.makeMemoMap;
        const scope = yield* Scope.Scope;
        const first = yield* Layer.buildWithMemoMap(fixture.layer, memoMap, scope);
        const second = yield* Layer.buildWithMemoMap(fixture.layer, memoMap, scope);

        expect(Context.get(first, AccessDecisionGate)).toBe(fixture.scriptedAccess.accessDecision);
        expect(Context.get(second, AccessDecisionGate)).toBe(fixture.scriptedAccess.accessDecision);
        expect(Context.get(first, OperationalScopeResolver)).toBe(Context.get(second, OperationalScopeResolver));
        expect(Context.get(first, ContextAccess)).toBe(Context.get(second, ContextAccess));
        expect(Context.get(first, AccessDecisionLog)).toBe(Context.get(second, AccessDecisionLog));
        expect(Context.get(first, AccessIntent)).toBe(Context.get(second, AccessIntent));
        expect(Context.get(first, AccessPrincipalKindSource)).toBe(Context.get(second, AccessPrincipalKindSource));
        expect(Context.get(first, DecisionCheck)).toBe(Context.get(second, DecisionCheck));
        expect(Context.get(first, LegalEntityCandidates)).toBe(Context.get(second, LegalEntityCandidates));
        expect(Context.get(first, CoreDatabase)).toBe(Context.get(second, CoreDatabase));
        expect(Context.get(first, DatabaseIdentityEnrollmentContext)).toBe(
          Context.get(second, DatabaseIdentityEnrollmentContext),
        );
        expect(Context.get(first, ActionRuntime)).toBe(Context.get(second, ActionRuntime));
        expect(Context.get(first, ReadRuntime)).toBe(Context.get(second, ReadRuntime));
        const question = {
          carrier: gateCarrier,
          legalEntityScope: 'forbidden',
          now: gateDecisionTime,
          scope: gateScope,
        } as const;
        expect((yield* Context.get(first, AccessDecisionGate).decide(question)).outcome).toBe('ALLOWED');
        expect((yield* fixture.scriptedAccess.bound.decide(question)).outcome).toBe('ALLOWED');
        expect(fixtureIoCounts()).toEqual(before);
      }),
    ),
  );

  suite.effect('exports inert authority ports that stay unavailable or empty without reading persistence', () =>
    Effect.scoped(
      Effect.gen(function* inertExportedPortsFailClosed() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const fixture = yield* makeLiveOperationFixture(configuration);
        yield* Effect.addFinalizer(() => fixture.close().pipe(Effect.orDie));
        const before = fixtureIoCounts();
        const context = yield* Layer.build(fixture.layer);
        const authority = Context.get(context, AccessIntent).authorityFor(gateScope);
        const tenantId = TenantIdSchema.make(gateScope.tenantId);
        const principalId = PrincipalIdSchema.make(gateScope.principalId);
        const holder = { _tag: 'Principal', principalId } as const;
        const scopeId = AccessScopeIdSchema.make('00000000-0000-4000-8000-0000000004a4');
        const failures = yield* Effect.all([
          authority.readScope({ holders: [holder], tenantId }).pipe(Effect.flip),
          authority
            .readConnection({
              connectionId: AgentConnectionIdSchema.make('00000000-0000-4000-8000-0000000004a5'),
              tenantId,
            })
            .pipe(Effect.flip),
          authority
            .readCells({
              capabilityKey: CapabilityKeySchema.make(gateCapabilityKey),
              holder,
              mode: 'run',
              scopeId,
              tenantId,
            })
            .pipe(Effect.flip),
          authority.readTeamIds({ holder, scopeId, tenantId }).pipe(Effect.flip),
          Context.get(context, AccessPrincipalKindSource)
            .readKind({ principalId, scope: gateScope, tenantId })
            .pipe(Effect.flip),
          Context.get(context, DecisionCheck).checkBulk([]).pipe(Effect.flip),
        ]);
        for (const failure of failures) {
          expect(Predicate.isTagged(failure, 'AccessDecisionUnavailable')).toBe(true);
        }
        expect(yield* Context.get(context, LegalEntityCandidates).listCandidateIds(gateScope)).toEqual([]);
        expect(
          (yield* Context.get(context, AccessDecisionGate).decide({
            carrier: gateCarrier,
            legalEntityScope: 'forbidden',
            now: gateDecisionTime,
            scope: gateScope,
          })).outcome,
        ).toBe('DENIED');
        expect(fixtureIoCounts()).toEqual(before);
      }),
    ),
  );

  suite.effect('refuses partial authoritative runtime bindings before seeding or loading authority', () =>
    Effect.gen(function* refusePartialRuntimeBindings() {
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeRelationships = transport.writeRelationships.mock.calls.length;
      const applicationComposition = { load: Effect.die('Partial runtime binding must not load authority') };
      const expectedDeployment = { appId: 'fixture-owner', buildMarker: 'fixture-build' };
      const failures = yield* Effect.all(
        [
          Effect.flip(makeLiveOperationFixture({ ...configuration, applicationComposition })),
          Effect.flip(makeLiveOperationFixture({ ...configuration, expectedDeployment })),
          Effect.flip(makeLiveOperationFixture({ ...configuration, applicationComposition, expectedDeployment })),
        ],
        { concurrency: 1 },
      );
      for (const failure of failures) {
        expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
        expect(failure.reason).toBe(
          'Authoritative fixture runtime requires Composition, deployment and owner registration',
        );
      }
      expect(transport.insert.mock.calls.length).toBe(beforeInsert);
      expect(transport.writeRelationships.mock.calls.length).toBe(beforeRelationships);
    }),
  );

  suite.effect('revokes and restores only its exact seeded primary-LE manager module accessor', () =>
    Effect.gen(function* mutateOnlyOwnedManagerAccessor() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, additionalLegalEntity: 'same-tenant' });
      const moduleObject = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      assert(moduleObject !== undefined);
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      for (const [operation, expectedOperation] of [
        ['revoke', v1.RelationshipUpdate_Operation.DELETE],
        ['grant', v1.RelationshipUpdate_Operation.TOUCH],
      ] as const) {
        yield* fixture.changeManagerModuleAccess('party.registry', operation);
        expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual([
          v1.RelationshipUpdate.create({
            operation: expectedOperation,
            relationship: v1.Relationship.create({
              relation: 'accessor',
              resource: { objectId: moduleObject, objectType: 'module_access' },
              subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
            }),
          }),
        ]);
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 2);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('updates one configured module in its fixed Tenant and returns authoritative readback', () =>
    Effect.gen(function* changeConfiguredModuleState() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const originalHandoff = yield* Schema.encodeEffect(
        Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema),
      )(fixture.runtimeHandoff);
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeUpdate = transport.updateRows.mock.calls.length;
      const beforeSelect = transport.selectRows.mock.calls.length;
      transport.updateRows.mockReturnValue(Effect.succeed([{ moduleKey, tenantId: fixture.tenantId }]));
      for (const state of ['suspended', 'active'] as const) {
        transport.selectRows.mockReturnValue([{ moduleKey, state, tenantId: fixture.tenantId }]);
        expect(yield* fixture.setConfiguredModuleState(moduleKey, state)).toEqual({ moduleKey, state });
        const update = transport.updateRows.mock.lastCall;
        assert(update !== undefined);
        expect(update[0]).toBe(tenantModuleStates);
        expect(update[1]).toEqual({ state });
        expect(new PgDialect().sqlToQuery(update[2]).params).toEqual([fixture.tenantId, moduleKey]);
        const read = transport.selectRows.mock.lastCall;
        assert(read !== undefined && read[1] !== undefined);
        expect(read[0]).toBe(tenantModuleStates);
        expect(new PgDialect().sqlToQuery(read[1]).params).toEqual([fixture.tenantId, moduleKey]);
      }
      expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate + 2);
      expect(transport.selectRows).toHaveBeenCalledTimes(beforeSelect + 2);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
          fixture.runtimeHandoff,
        ),
      ).toBe(originalHandoff);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unknown module keys, unsupported states and extra setter inputs before mutation', () =>
    Effect.gen(function* rejectUnboundedModuleStateMutation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const beforeUpdate = transport.updateRows.mock.calls.length;
      const beforeSelect = transport.selectRows.mock.calls.length;
      for (const key of ['commerce.unknown', '*', '', 'commerce.customer-context.*']) {
        const failure = yield* Effect.flip(fixture.setConfiguredModuleState(key, 'suspended'));
        expect(failure.reason).toBe('Invalid configured fixture module state mutation');
      }
      for (const state of ['quarantined', 'read_only', 'unknown', '*']) {
        const failure = yield* Effect.flip(
          // @ts-expect-error Runtime callers cannot request unsupported or unknown module states.
          fixture.setConfiguredModuleState(moduleKey, state),
        );
        expect(failure.reason).toBe('Invalid configured fixture module state mutation');
      }
      const extra = yield* Effect.flip(
        // @ts-expect-error Extra tenant selectors must not alter the captured fixture scope.
        fixture.setConfiguredModuleState(moduleKey, 'suspended', { tenantId: 'foreign' }),
      );
      expect(extra.reason).toBe('Invalid configured fixture module state mutation');
      expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate);
      expect(transport.selectRows).toHaveBeenCalledTimes(beforeSelect);
      yield* fixture.close();
    }),
  );

  suite.effect('preserves typed update and authoritative readback failures without inserting missing modules', () =>
    Effect.gen(function* rejectUnverifiedModuleStateMutation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const moduleKey = 'commerce.customer-context';
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: [moduleKey] });
      const beforeInsert = transport.insert.mock.calls.length;
      transport.updateRows.mockReturnValueOnce(Effect.fail(new FixtureModuleStateUpdateFailure({})));
      const failed = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
      expect(failed.reason).toBe('Unable to persist configured fixture module state');
      transport.updateRows.mockReturnValueOnce(Effect.succeed([]));
      const missing = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
      expect(missing.reason).toBe('Configured fixture module state update did not match exactly one existing row');
      transport.updateRows.mockReturnValue(Effect.succeed([{ moduleKey, tenantId: fixture.tenantId }]));
      for (const rows of [
        [],
        [{ moduleKey, state: 'active', tenantId: fixture.tenantId }],
        [{ moduleKey, state: 'suspended', tenantId: 'foreign' }],
        [{ moduleKey: 'commerce.unknown', state: 'suspended', tenantId: fixture.tenantId }],
      ]) {
        transport.selectRows.mockReturnValue(rows);
        const contradictory = yield* Effect.flip(fixture.setConfiguredModuleState(moduleKey, 'suspended'));
        expect(contradictory.reason).toBe('Configured fixture module state readback did not match the update');
      }
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('admits explicitly configured seeded module access and rejects unseeded modules before transport', () =>
    Effect.gen(function* enforceOwnedManagerModuleAllowlist() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const input of [
        configuration,
        { ...configuration, moduleAccess: 'configured-modules' as const, moduleKeys: ['privacy.core'] },
      ]) {
        const fixture = yield* makeLiveOperationFixture(input);
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const allowed = 'moduleAccess' in input;
        if (allowed) {
          yield* fixture.changeManagerModuleAccess('privacy.core', 'revoke');
          expect(transport.writeRelationships.mock.lastCall?.[0].updates).toMatchObject([
            {
              operation: v1.RelationshipUpdate_Operation.DELETE,
              relationship: {
                relation: 'accessor',
                resource: {
                  objectId: toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'privacy.core'),
                  objectType: 'module_access',
                },
                subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
              },
            },
          ]);
        }
        const cases = allowed ? ['commerce.unknown', '*', ''] : ['privacy.core', 'commerce.unknown', '*', ''];
        for (const moduleKey of cases) {
          const failure = yield* Effect.flip(fixture.changeManagerModuleAccess(moduleKey, 'grant'));
          expect(failure.reason).toBe('Module access mutation requires a fixture-owned manager grant');
        }
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + (allowed ? 1 : 0));
        yield* fixture.close();
      }
    }),
  );

  suite.effect('returns a typed module-access mutation failure without alternate grants when transport fails', () =>
    Effect.gen(function* preserveAccessorTransportFailure() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      transport.writeRelationships.mockRejectedValueOnce(new Error('unit-only write failure'));
      const failure = yield* Effect.flip(fixture.changeManagerModuleAccess('party.registry', 'revoke'));
      expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
      expect(failure.reason).toBe('Unable to change live fixture manager module access');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('child permission environment exposes only validated parser keys with a redacted credential', () =>
    Effect.gen(function* exposeBoundedPermissionEnvironment() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      expect(Object.keys(fixture.permissionEnvironment).toSorted()).toEqual([
        'SPICEDB_ENDPOINT',
        'SPICEDB_PRESHARED_KEY',
      ]);
      expect(fixture.permissionEnvironment.SPICEDB_ENDPOINT).toBe('localhost:50051');
      expect(Redacted.isRedacted(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY)).toBe(true);
      expect(Redacted.value(fixture.permissionEnvironment.SPICEDB_PRESHARED_KEY)).toBe('unit-only');
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(fixture.permissionEnvironment);
      expect(encoded).not.toContain('unit-only');
      expect(Object.isFrozen(fixture.permissionEnvironment)).toBe(true);
      yield* fixture.close();
    }),
  );

  suite.effect('scripts the gate answer per fixture: allowed, a per-key map and a fail-closed default', () =>
    Effect.gen(function* scriptGateAnswers() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const defaulted = yield* makeLiveOperationFixture(configuration);
      // No `access` stated: the fixture denies, so a live suite never inherits an allow (fail closed).
      expect((yield* decideFixtureAccess(defaulted, gateCarrier)).outcome).toBe('DENIED');
      const allowed = yield* makeLiveOperationFixture({ ...configuration, access: 'allowed' });
      expect((yield* decideFixtureAccess(allowed, gateCarrier)).outcome).toBe('ALLOWED');
      const perKey = yield* makeLiveOperationFixture({
        ...configuration,
        access: { [gateCapabilityKey]: 'allowed' },
      });
      expect((yield* decideFixtureAccess(perKey, gateCarrier)).outcome).toBe('ALLOWED');
      // A carrier the map does not name keeps the default, so one scripted key cannot widen another.
      expect((yield* decideFixtureAccess(perKey, {})).outcome).toBe('DENIED');
      yield* Effect.forEach([defaulted, allowed, perKey], (fixture) => fixture.close(), { discard: true });
    }),
  );

  suite.effect(
    'grants only an existing native active service the declared module, with no Action tuples or Action checks',
    () =>
      Effect.gen(function* grantExactExistingService() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        transport.checkPermission.mockResolvedValue(permissionResponse(true));
        const fixture = yield* makeLiveOperationFixture({
          ...configuration,
          actionExecutor: 'manager-only',
          moduleAccess: 'configured-modules',
          moduleKeys: ['commerce.catalog'],
        });
        mockExistingService(fixture);
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const beforeCheck = transport.checkPermission.mock.calls.length;
        yield* fixture.grantExistingService({
          actionKeys: configuration.actionKeys,
          legalEntityId: fixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        });
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
        const updates = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates;
        expect(updates?.every((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(true);
        const tuples = updates?.flatMap((update) => (update.relationship === undefined ? [] : [update.relationship]));
        expect(tuples).toHaveLength(5);
        // Authorization v2 has no executor tuples: an Action is decided from the holder's assignment.
        expect(tuples?.some(({ resource }) => resource?.objectType === 'action')).toBe(false);
        expect(
          tuples?.some(({ relation }) =>
            ['identity_admin', 'counterparty_manager', 'counterparty_reader'].includes(relation),
          ),
        ).toBe(false);
        expect(
          tuples?.filter(({ relation, resource }) => resource?.objectType === 'legal_entity' && relation === 'member'),
        ).toMatchObject([{ subject: { object: { objectId: existingServiceId } } }]);
        const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
        // Tenant, Legal Entity and the one module: Action admission is the gate's decision (O62).
        expect(checks).toHaveLength(3);
        expect(checks.every((request) => request.consistency?.requirement.oneofKind === 'fullyConsistent')).toBe(true);
        expect(checks.every((request) => request.subject?.object?.objectId === existingServiceId)).toBe(true);
        expect(checks.some((request) => request.resource?.objectType === 'action')).toBe(false);
        yield* fixture.close();
      }),
  );

  suite.effect('read-only service grants no executor and verifies undeclared modules stay denied', () =>
    Effect.gen(function* grantReadOnlyService() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog', 'party.registry'],
      });
      mockExistingService(fixture);
      const excludedModule = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      transport.checkPermission.mockImplementation((request) =>
        Promise.resolve(
          permissionResponse(
            request.resource?.objectType !== 'action' && request.resource?.objectId !== excludedModule,
          ),
        ),
      );
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      yield* fixture.grantExistingService({
        actionKeys: [],
        legalEntityId: fixture.legalEntityId,
        moduleKeys: ['commerce.catalog'],
        principalId: existingServiceId,
      });
      const tuples = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      expect(tuples).toHaveLength(5);
      expect(tuples?.some(({ resource }) => resource?.objectType === 'action')).toBe(false);
      const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
      expect(checks.some((request) => request.permission === 'execute')).toBe(false);
      expect(checks.some((request) => request.resource?.objectId === excludedModule)).toBe(true);
      yield* fixture.close();
    }),
  );

  suite.effect('service membership must not activate latent excluded module permissions', () =>
    Effect.gen(function* rejectMembershipActivatedGrants() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const latentKind of ['module_access']) {
        const fixture = yield* makeLiveOperationFixture({
          ...configuration,
          actionExecutor: 'manager-only',
          moduleKeys: ['commerce.catalog', 'party.registry'],
        });
        mockExistingService(fixture);
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const excludedModule = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
        transport.checkPermission.mockImplementation((request) => {
          const excluded = request.resource?.objectType === 'action' || request.resource?.objectId === excludedModule;
          const membershipWritten = transport.writeRelationships.mock.calls.length > beforeWrite;
          return Promise.resolve(
            permissionResponse(!excluded || (membershipWritten && request.resource?.objectType === latentKind)),
          );
        });
        const beforeCheck = transport.checkPermission.mock.calls.length;
        const failure = yield* Effect.flip(
          fixture.grantExistingService({
            actionKeys: [],
            legalEntityId: fixture.legalEntityId,
            moduleKeys: ['commerce.catalog'],
            principalId: existingServiceId,
          }),
        );
        expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
        expect(
          transport.checkPermission.mock.calls
            .slice(beforeCheck)
            .every(([request]) => request.consistency?.requirement.oneofKind === 'fullyConsistent'),
        ).toBe(true);
        yield* fixture.close();
      }
    }),
  );

  suite.effect(
    'service grants reject unknown, wildcard, duplicate, empty and cross-module declarations before writing',
    () =>
      Effect.gen(function* rejectUnboundedServiceGrants() {
        transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
        const fixture = yield* makeLiveOperationFixture({
          ...configuration,
          actionExecutor: 'manager-only',
          moduleKeys: ['commerce.catalog', 'party.registry'],
        });
        mockExistingService(fixture);
        const valid = {
          actionKeys: configuration.actionKeys,
          legalEntityId: fixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        };
        const cases = [
          { ...valid, moduleKeys: [] },
          { ...valid, moduleKeys: ['*'] },
          { ...valid, moduleKeys: [''] },
          { ...valid, moduleKeys: ['commerce.catalog', 'commerce.catalog'] },
          { ...valid, moduleKeys: ['commerce.unknown'] },
          { ...valid, actionKeys: ['*'] },
          { ...valid, actionKeys: [''] },
          { ...valid, actionKeys: ['commerce.catalog.unlisted'] },
          { ...valid, actionKeys: [configuration.actionKeys[0] ?? '', configuration.actionKeys[0] ?? ''] },
          { ...valid, moduleKeys: ['party.registry'] },
          { ...valid, legalEntityId: '00000000-0000-4000-8000-000000000001' },
        ];
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const input of cases) {
          const failure = yield* Effect.flip(fixture.grantExistingService(input));
          expect(failure.reason).toBe('Invalid existing service fixture authorization');
        }
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* fixture.close();
      }),
  );

  suite.effect('service grants require one exact active persisted service and primary same-Tenant Legal Entity', () =>
    Effect.gen(function* rejectForeignOrInactiveServiceRows() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog'],
      });
      const rows = mockExistingService(fixture);
      const cases: readonly {
        readonly entities: readonly FixtureEntityRow[];
        readonly services: readonly FixtureServiceRow[];
      }[] = [
        { entities: [rows.entity], services: [] },
        { entities: [rows.entity], services: [{ ...rows.service, kind: 'human' }] },
        { entities: [rows.entity], services: [{ ...rows.service, status: 'disabled' }] },
        { entities: [rows.entity], services: [{ ...rows.service, tenantId: '00000000-0000-4000-8000-000000000001' }] },
        { entities: [rows.entity], services: [{ ...rows.service, principalId: fixture.manager.principalId }] },
        { entities: [rows.entity], services: [rows.service, rows.service] },
        { entities: [], services: [rows.service] },
        { entities: [{ ...rows.entity, status: 'suspended' }], services: [rows.service] },
        { entities: [{ ...rows.entity, tenantId: '00000000-0000-4000-8000-000000000001' }], services: [rows.service] },
      ];
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      for (const testCase of cases) {
        transport.selectRows.mockImplementation((table) =>
          table === principals ? testCase.services : testCase.entities,
        );
        const failure = yield* Effect.flip(
          fixture.grantExistingService({
            actionKeys: configuration.actionKeys,
            legalEntityId: fixture.legalEntityId,
            moduleKeys: ['commerce.catalog'],
            principalId: existingServiceId,
          }),
        );
        expect(failure.reason).toBe('Invalid existing service fixture authorization');
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      yield* fixture.close();
    }),
  );

  suite.effect('service grants reject membership-default executors and preexisting undeclared permissions', () =>
    Effect.gen(function* rejectImplicitServiceExecutors() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const membershipFixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.catalog'] });
      const membershipBefore = transport.writeRelationships.mock.calls.length;
      const membershipFailure = yield* Effect.flip(
        membershipFixture.grantExistingService({
          actionKeys: [],
          legalEntityId: membershipFixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        }),
      );
      expect(membershipFailure.reason).toBe('Invalid existing service fixture authorization');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(membershipBefore);
      yield* membershipFixture.close();
      // A preexisting grant on a module the service did not request must refuse the reuse.
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        moduleKeys: ['commerce.catalog', 'party.registry'],
      });
      mockExistingService(fixture);
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const before = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        fixture.grantExistingService({
          actionKeys: [],
          legalEntityId: fixture.legalEntityId,
          moduleKeys: ['commerce.catalog'],
          principalId: existingServiceId,
        }),
      );
      expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
      yield* fixture.close();
    }),
  );

  suite.effect('namespace provisioning is exact, opt-in, verified and removed on close', () =>
    Effect.gen(function* exactOwnedNamespaceProvisioning() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockImplementation((request) => {
        const grantee = transport.writeRelationships.mock.calls
          .at(-1)?.[0]
          .updates.find((update) => update.relationship?.relation === 'provisioner')?.relationship?.subject
          ?.object?.objectId;
        return Promise.resolve(permissionResponse(request.subject?.object?.objectId === grantee));
      });
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        managerIdentityAdmin: true,
        managerProvisioningNamespaces: [commerceProvisioningNamespace],
      });
      const resourceId = toIdentityNamespaceAccessObjectId(fixture.tenantId, commerceProvisioningNamespace);
      assert(resourceId !== undefined);
      const granted = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.filter(
        (update) => update.relationship?.resource?.objectType === namespaceResourceType,
      );
      expect(granted).toEqual([
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'tenant',
            resource: { objectId: resourceId, objectType: namespaceResourceType },
            subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } },
          }),
        }),
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'provisioner',
            resource: { objectId: resourceId, objectType: namespaceResourceType },
            subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
          }),
        }),
      ]);
      const checks = transport.checkPermission.mock.calls
        .slice(beforeCheck)
        .map(([request]) => request)
        .filter((request) => request.resource?.objectType === namespaceResourceType);
      expect(checks).toHaveLength(4);
      expect(
        checks.every(
          (request) =>
            request.resource?.objectId === resourceId &&
            request.permission === 'provision' &&
            request.consistency?.requirement.oneofKind === 'fullyConsistent',
        ),
      ).toBe(true);
      expect(new Set(checks.map((request) => request.subject?.object?.objectId))).toEqual(
        new Set([
          fixture.manager.principalId,
          fixture.reader.principalId,
          fixture.denied.principalId,
          fixture.legalEntityOnly.principalId,
        ]),
      );
      yield* fixture.close();
      expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual(
        granted?.map((update) => ({ ...update, operation: v1.RelationshipUpdate_Operation.DELETE })),
      );
    }),
  );

  suite.effect('default fixture creates no namespace provisioning relationships', () =>
    Effect.gen(function* noImplicitNamespaceProvisioning() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture(configuration);
      expect(
        transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.some(
          (update) => update.relationship?.resource?.objectType === namespaceResourceType,
        ),
      ).toBe(false);
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
    }),
  );

  suite.effect('namespace provisioning rejects unbounded or implicit setup before writes', () =>
    Effect.gen(function* rejectInvalidNamespaceProvisioning() {
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeInsert = transport.insert.mock.calls.length;
      for (const namespaces of [[], [''], ['*'], ['same', 'same']]) {
        yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            actionExecutor: 'manager-only',
            managerIdentityAdmin: true,
            managerProvisioningNamespaces: namespaces,
          }),
        );
      }
      for (const options of [{}, { managerIdentityAdmin: true }, { actionExecutor: 'manager-only' as const }]) {
        yield* Effect.flip(
          makeLiveOperationFixture({
            ...configuration,
            ...options,
            managerProvisioningNamespaces: [commerceProvisioningNamespace],
          }),
        );
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
    }),
  );

  suite.effect('identity administration is opt-in and verifies only the fixture manager is allowed', () =>
    Effect.gen(function* grantManagerIdentityAdministration() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockImplementation((request) => {
        const grantee = transport.writeRelationships.mock.calls
          .at(-1)?.[0]
          .updates.find((update) => update.relationship?.relation === 'identity_admin')?.relationship?.subject
          ?.object?.objectId;
        return Promise.resolve(permissionResponse(request.subject?.object?.objectId === grantee));
      });
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({ ...configuration, managerIdentityAdmin: true });
      const tuples = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship?.relation === 'identity_admin' ? [update.relationship] : [],
      );
      expect(tuples).toMatchObject([
        {
          resource: { objectId: fixture.tenantId, objectType: 'tenant' },
          subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
        },
      ]);
      expect(tuples).toHaveLength(1);
      const checks = transport.checkPermission.mock.calls.slice(beforeCheck).map(([request]) => request);
      expect(checks).toHaveLength(4);
      expect(
        checks.every(
          (request) =>
            request.resource?.objectId === fixture.tenantId &&
            request.permission === 'manage_identity' &&
            request.consistency?.requirement.oneofKind === 'fullyConsistent',
        ),
      ).toBe(true);
      expect(new Set(checks.map((request) => request.subject?.object?.objectId))).toEqual(
        new Set([
          fixture.manager.principalId,
          fixture.legalEntityOnly.principalId,
          fixture.denied.principalId,
          fixture.reader.principalId,
        ]),
      );
      yield* fixture.close();
    }),
  );

  suite.effect('default and disabled identity administration retain original grants without extra checks', () =>
    Effect.gen(function* preserveDefaultIdentityAdministration() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      for (const input of [configuration, { ...configuration, managerIdentityAdmin: false }]) {
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const beforeCheck = transport.checkPermission.mock.calls.length;
        const fixture = yield* makeLiveOperationFixture(input);
        expect(
          transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.some(
            (update) => update.relationship?.relation === 'identity_admin',
          ),
        ).toBe(false);
        expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
        yield* fixture.close();
      }
    }),
  );

  suite.effect('identity administration rejects unexpected permission to another actor', () =>
    Effect.gen(function* rejectIdentityPrivilegeLeak() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const failure = yield* Effect.flip(makeLiveOperationFixture({ ...configuration, managerIdentityAdmin: true }));
      expect(failure.reason).toBe('Live fixture authorization does not match its exact declared grants');
    }),
  );

  suite.effect('configured module access grants only the primary Legal Entity manager and LE-only actor', () =>
    Effect.gen(function* grantConfiguredModuleAccess() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        additionalLegalEntity: 'same-tenant',
        moduleAccess: 'configured-modules',
        moduleKeys: ['privacy.core', 'commerce.catalog', 'party.registry'],
      });
      assert(fixture.secondaryLegalEntity !== undefined);
      const relations = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      const modules = relations?.filter(({ resource }) => resource?.objectType === 'module_access');
      const primaryParty = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry');
      const privacy = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'privacy.core');
      const catalog = toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'commerce.catalog');
      const secondaryParty = toModuleAccessObjectId(
        fixture.tenantId,
        fixture.secondaryLegalEntity.legalEntityId,
        'party.registry',
      );
      expect(new Set(modules?.map(({ resource }) => resource?.objectId))).toEqual(
        new Set([primaryParty, privacy, catalog, secondaryParty]),
      );
      expect(modules).toHaveLength(11);
      const entityObject = toLegalEntityAccessObjectId(fixture.tenantId, fixture.legalEntityId);
      for (const objectId of [primaryParty, privacy, catalog]) {
        const exactModule = modules?.filter(({ resource }) => resource?.objectId === objectId);
        expect(exactModule).toHaveLength(3);
        expect(exactModule?.filter(({ relation }) => relation === 'legal_entity')).toMatchObject([
          { subject: { object: { objectId: entityObject, objectType: 'legal_entity' } } },
        ]);
        expect(
          exactModule?.filter(({ relation }) => relation === 'accessor').map(({ subject }) => subject?.object),
        ).toEqual([
          { objectId: fixture.manager.principalId, objectType: 'principal' },
          { objectId: fixture.legalEntityOnly.principalId, objectType: 'principal' },
        ]);
      }
      expect(relations?.some(({ resource }) => resource?.objectType === 'context_permission')).toBe(false);
      expect(relations?.some(({ resource }) => resource?.objectType === 'resource')).toBe(false);
      expect(relations?.some(({ resource }) => resource?.objectType === 'action')).toBe(false);
      const beforeClose = transport.writeRelationships.mock.calls.length;
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeClose);
    }),
  );

  suite.effect('module state configuration alone retains the original Party-only module authorization', () =>
    Effect.gen(function* retainDefaultModuleAccess() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['privacy.core'] });
      const modules = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship?.resource?.objectType === 'module_access' ? [update.relationship] : [],
      );
      expect(modules).toHaveLength(3);
      expect(new Set(modules?.map(({ resource }) => resource?.objectId))).toEqual(
        new Set([toModuleAccessObjectId(fixture.tenantId, fixture.legalEntityId, 'party.registry')]),
      );
      yield* fixture.close();
    }),
  );

  suite.effect(
    'configured module access rejects missing, empty, duplicate and malformed modules before provisioning',
    () =>
      Effect.gen(function* rejectInvalidConfiguredModules() {
        const inputs = [
          { ...configuration, moduleAccess: 'configured-modules' as const },
          ...[[], ['privacy.core', 'privacy.core'], [''], ['x'.repeat(1024)]].map((moduleKeys) => ({
            ...configuration,
            moduleAccess: 'configured-modules' as const,
            moduleKeys,
          })),
        ];
        for (const input of inputs) {
          const beforeInsert = transport.insert.mock.calls.length;
          const beforeWrite = transport.writeRelationships.mock.calls.length;
          const failure = yield* Effect.flip(makeLiveOperationFixture(input));
          expect(failure.reason).toBe('Invalid live operation fixture configuration');
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        }
      }),
  );

  suite.effect('rejects unsupported module access modes before provisioning', () =>
    Effect.gen(function* rejectUnknownModuleAccessMode() {
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Runtime callers cannot enable arbitrary module authorization modes.
          moduleAccess: 'all-modules',
          moduleKeys: ['privacy.core'],
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
    }),
  );

  suite.effect('creates exactly one opt-in same-Tenant Legal Entity for the existing manager identity', () =>
    Effect.gen(function* createSecondaryLegalEntity() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture({
        ...configuration,
        actionExecutor: 'manager-only',
        additionalLegalEntity: 'same-tenant',
      });
      const inserts = transport.insert.mock.calls.slice(beforeInsert);
      const entities = inserts.filter(([table]) => table === legalEntities);
      expect(entities).toHaveLength(2);
      assert(fixture.secondaryLegalEntity !== undefined);
      const secondary = fixture.secondaryLegalEntity;
      expect(secondary.legalEntityId).not.toBe(fixture.legalEntityId);
      expect(secondary.manager).toEqual({ ...fixture.manager, legalEntityId: secondary.legalEntityId });
      expect(entities[1]?.[1]).toMatchObject({
        legalEntityId: secondary.legalEntityId,
        status: 'active',
        tenantId: fixture.tenantId,
      });
      expect(inserts.filter(([table]) => table === principals)).toHaveLength(1);
      expect(inserts.filter(([table]) => table === principalAuthBindings)).toHaveLength(1);
      const relations = transport.writeRelationships.mock.calls[beforeWrite]?.[0].updates.flatMap((update) =>
        update.relationship === undefined ? [] : [update.relationship],
      );
      const entityObject = toLegalEntityAccessObjectId(fixture.tenantId, secondary.legalEntityId);
      const moduleObject = toModuleAccessObjectId(fixture.tenantId, secondary.legalEntityId, 'party.registry');
      const secondaryRelations = relations?.filter(
        ({ resource }) => resource?.objectId === entityObject || resource?.objectId === moduleObject,
      );
      expect(secondaryRelations).toHaveLength(6);
      expect(
        secondaryRelations?.filter(
          ({ relation, resource }) => resource?.objectId === entityObject && relation === 'tenant',
        ),
      ).toMatchObject([{ subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } } }]);
      expect(
        secondaryRelations
          ?.filter(({ subject }) => subject?.object?.objectType === 'principal')
          .map(({ subject }) => subject?.object?.objectId),
      ).toEqual(Array.from({ length: 4 }, () => fixture.manager.principalId));
      expect(
        secondaryRelations
          ?.filter(({ relation, resource }) => resource?.objectId === entityObject && relation !== 'tenant')
          .map(({ relation }) => relation),
      ).toEqual(['member', 'counterparty_manager', 'counterparty_reader']);
      // No executor tuple is written for an Action; the v2 gate reads the holder's assignment instead.
      expect(relations?.some(({ resource }) => resource?.objectType === 'action')).toBe(false);
      yield* fixture.close();
    }),
  );

  suite.effect('default provisioning retains one Legal Entity and no secondary context', () =>
    Effect.gen(function* retainSingleLegalEntity() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const before = transport.insert.mock.calls.length;
      const fixture = yield* makeLiveOperationFixture(configuration);
      const inserts = transport.insert.mock.calls.slice(before);
      expect(inserts.filter(([table]) => table === legalEntities)).toHaveLength(1);
      const scopes = inserts
        .filter(([table]) => table === accessScopes)
        .flatMap(([, rows]) => rows)
        .map((row) => {
          assert('scopeId' in row);
          return row;
        });
      expect(scopes).toEqual([
        {
          legalEntityId: null,
          scopeId: expect.any(String),
          tenantContextId: fixture.tenantId,
          tenantId: fixture.tenantId,
        },
        {
          legalEntityId: fixture.legalEntityId,
          scopeId: expect.any(String),
          tenantContextId: null,
          tenantId: fixture.tenantId,
        },
      ]);
      expect(new Set(scopes.map((row) => row.scopeId)).size).toBe(2);
      expect(inserts.filter(([table]) => table === accessScopeFences).flatMap(([, rows]) => rows)).toEqual(
        scopes.map((row) => ({
          owningOperationId: null,
          revision: 1,
          scopeId: row.scopeId,
          state: 'Ready',
          tenantId: fixture.tenantId,
        })),
      );
      expect(fixture.secondaryLegalEntity).toBeUndefined();
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unsupported additional Legal Entity modes before identity provisioning', () =>
    Effect.gen(function* rejectUnboundedLegalEntityMode() {
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Invalid runtime callers cannot request arbitrary Legal Entity creation.
          additionalLegalEntity: 'arbitrary',
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
    }),
  );

  suite.effect('grants and verifies only the explicit named permission for the exact fixture actor and scope', () =>
    Effect.gen(function* grantExactContextPermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      transport.checkPermission.mockResolvedValue(permissionResponse(true));
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const objectId = toContextPermissionAccessObjectId(fixture.tenantId, fixture.legalEntityId, target);
      assert(objectId !== undefined);
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeInsert = transport.insert.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      expect(
        transport.writeRelationships.mock.lastCall?.[0].updates.some(
          (update) => update.relationship?.resource?.objectType === 'context_permission',
        ),
      ).toBe(false);
      yield* fixture.grantContextPermissionAccess(target, fixture.manager.principalId);
      expect(transport.writeRelationships.mock.lastCall?.[0].updates).toEqual([
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'tenant',
            resource: { objectId, objectType: 'context_permission' },
            subject: { object: { objectId: fixture.tenantId, objectType: 'tenant' } },
          }),
        }),
        v1.RelationshipUpdate.create({
          operation: v1.RelationshipUpdate_Operation.TOUCH,
          relationship: v1.Relationship.create({
            relation: 'grantee',
            resource: { objectId, objectType: 'context_permission' },
            subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
          }),
        }),
      ]);
      expect(transport.checkPermission.mock.lastCall?.[0]).toMatchObject({
        consistency: { requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' } },
        permission: 'access',
        resource: { objectId, objectType: 'context_permission' },
        subject: { object: { objectId: fixture.manager.principalId, objectType: 'principal' } },
      });
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 1);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck + 1);
      expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects foreign actors, unconfigured modules and supplied context scope before grant I/O', () =>
    Effect.gen(function* rejectUnboundedContextPermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const foreignId = '00000000-0000-4000-8000-000000000099';
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      for (const attempted of [
        { ...target, moduleId: 'commerce.unknown' },
        { ...target, moduleId: 'commerce.*' },
        { ...target, moduleId: '' },
        { ...target, permission: '*' },
        { ...target, permission: '' },
        { ...target, permission: 'market catalog read' },
        { ...target, tenantId: foreignId },
        { ...target, legalEntityId: foreignId },
        { ...target, principalId: fixture.reader.principalId },
      ]) {
        const failure = yield* Effect.flip(
          fixture.grantContextPermissionAccess(attempted, fixture.manager.principalId),
        );
        expect(failure.reason).toBe('Invalid live fixture context permission grant');
      }
      for (const principalId of [foreignId, '*', '']) {
        const failure = yield* Effect.flip(fixture.grantContextPermissionAccess(target, principalId));
        expect(failure.reason).toBe('Invalid live fixture context permission grant');
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
      yield* fixture.close();
    }),
  );

  suite.effect('preserves named permission write and verification failures without broader grants', () =>
    Effect.gen(function* failClosedContextPermissionGrant() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture({ ...configuration, moduleKeys: ['commerce.customer-context'] });
      const target = { moduleId: 'commerce.customer-context', permission: 'market.catalog.read' };
      const beforeWrite = transport.writeRelationships.mock.calls.length;
      const beforeCheck = transport.checkPermission.mock.calls.length;
      transport.writeRelationships.mockRejectedValueOnce(new Error('unit-only context grant failure'));
      const writeFailure = yield* Effect.flip(
        fixture.grantContextPermissionAccess(target, fixture.manager.principalId),
      );
      expect(writeFailure.reason).toBe('Unable to grant live fixture context permission access');
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck);
      transport.checkPermission.mockResolvedValueOnce(permissionResponse(false));
      const denied = yield* Effect.flip(fixture.grantContextPermissionAccess(target, fixture.manager.principalId));
      expect(denied.reason).toBe('Live fixture authorization does not match its exact declared grants');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite + 2);
      expect(transport.checkPermission).toHaveBeenCalledTimes(beforeCheck + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('revokes only the exact granted resource permission tuple for each principal and permission', () =>
    Effect.gen(function* revokeExactResourcePermission() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const resource = { moduleId: 'commerce.catalog', resourceId: 'owned-product', resourceType: 'product' };
      for (const principalId of [fixture.manager.principalId, fixture.reader.principalId]) {
        for (const permission of ['reader', 'writer'] as const) {
          const before = transport.writeRelationships.mock.calls.length;
          yield* fixture.grantResourceAccess(resource, principalId, permission);
          yield* fixture.revokeResourceAccess(resource, principalId, permission);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 2);
          const grant = transport.writeRelationships.mock.calls[before]?.[0];
          const revoke = transport.writeRelationships.mock.calls[before + 1]?.[0];
          expect(grant?.updates).toHaveLength(4);
          expect(grant?.updates.every((update) => update.operation === v1.RelationshipUpdate_Operation.TOUCH)).toBe(
            true,
          );
          const grantedPermission = grant?.updates[3]?.relationship;
          expect(grantedPermission).toMatchObject({
            relation: permission,
            resource: { objectType: 'resource' },
            subject: { object: { objectId: principalId } },
          });
          expect(revoke?.updates).toHaveLength(1);
          expect(revoke?.updates[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
          expect(revoke?.updates[0]?.relationship).toEqual(grantedPermission);
          expect(grant?.updates.slice(0, 3).map((update) => update.relationship?.relation)).toEqual([
            'legal_entity',
            'accessor',
            'module',
          ]);
        }
      }
      yield* fixture.close();
    }),
  );

  suite.effect('duplicate TOUCH grants are not reference counted and close does not automatically revoke tuples', () =>
    Effect.gen(function* retainExplicitGrantOwnership() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const resource = { moduleId: 'commerce.catalog', resourceId: 'fresh-product', resourceType: 'product' };
      const before = transport.writeRelationships.mock.calls.length;
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      expect(transport.writeRelationships.mock.calls[before]?.[0]).toEqual(
        transport.writeRelationships.mock.calls[before + 1]?.[0],
      );
      yield* fixture.revokeResourceAccess(resource, fixture.manager.principalId);
      const updates = transport.writeRelationships.mock.calls[before + 2]?.[0].updates;
      expect(updates).toHaveLength(1);
      expect(updates?.[0]?.relationship?.relation).toBe('reader');
      expect(updates?.[0]?.operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
      yield* fixture.close();
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 3);
    }),
  );

  suite.effect('resource revocation preserves invalid-target and external-write failures as typed errors', () =>
    Effect.gen(function* rejectInvalidResourceRevocation() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const fixture = yield* makeLiveOperationFixture(configuration);
      const before = transport.writeRelationships.mock.calls.length;
      for (const resource of [
        { moduleId: '', resourceId: 'product', resourceType: 'product' },
        { moduleId: 'commerce.catalog', resourceId: '', resourceType: 'product' },
        { moduleId: 'commerce.catalog', resourceId: 'product', resourceType: '' },
        { moduleId: 'commerce.catalog', resourceId: 'x'.repeat(1024), resourceType: 'product' },
      ]) {
        for (const operation of [fixture.grantResourceAccess, fixture.revokeResourceAccess]) {
          const failure = yield* Effect.flip(operation(resource, fixture.manager.principalId));
          expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
          expect(failure.reason).toBe('Invalid resource fixture');
        }
      }
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
      const cause = new Error('unit-only transport unavailable');
      transport.writeRelationships.mockRejectedValueOnce(cause);
      const failure = yield* Effect.flip(
        fixture.revokeResourceAccess(
          { moduleId: 'commerce.catalog', resourceId: 'owned-product', resourceType: 'product' },
          fixture.manager.principalId,
        ),
      );
      expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
      expect(failure.reason).toBe('Unable to revoke live fixture resource access');
      expect(failure.cause).toBe(cause);
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before + 1);
      yield* fixture.close();
    }),
  );

  suite.effect('rejects unknown executor modes before provisioning', () =>
    Effect.gen(function* rejectUnknownExecutor() {
      transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
      const before = transport.writeRelationships.mock.calls.length;
      const failure = yield* Effect.flip(
        makeLiveOperationFixture({
          ...configuration,
          // @ts-expect-error Foreign callers can still supply an unsupported executor mode at runtime.
          actionExecutor: 'everybody',
        }),
      );
      expect(failure.reason).toBe('Invalid live operation fixture configuration');
      expect(transport.writeRelationships).toHaveBeenCalledTimes(before);
    }),
  );

  suite.effect(
    'live fixture rejects missing and malformed release pins before reading configuration or opening services',
    () =>
      Effect.gen(function* rejectInvalidFixtureRelease() {
        for (const compositionRevision of ['', 'latest', 'a'.repeat(63), 'A'.repeat(64)]) {
          const failure = yield* Effect.flip(
            makeLiveOperationFixture({
              authenticationNamespaceId: 'fixture-release-unit',
              compositionRevision,
              runtimeConnectionString: Redacted.make(`postgresql://${fixtureRuntimeRole}:unit@127.0.0.1/unit`),
            }),
          );
          expect(Predicate.isTagged(failure, 'LiveOperationFixtureError')).toBe(true);
          expect(failure.reason).toBe('Invalid live operation fixture configuration');
        }
      }),
  );
});

const attachmentDatabase = `ontos_test_party_gateway_${'a'.repeat(32)}`;
const attachmentConfiguration = {
  ...configuration,
  adminConnectionString: Redacted.make(`postgresql://unit_admin:unit@127.0.0.1/${attachmentDatabase}`),
  runtimeConnectionString: Redacted.make(`postgresql://${fixtureRuntimeRole}:unit@127.0.0.1/${attachmentDatabase}`),
};
const safeNative = {
  bypass: false,
  createDb: false,
  createRole: false,
  database: attachmentDatabase,
  role: fixtureRuntimeRole,
  session: fixtureRuntimeRole,
  superuser: false,
};
const prepareAttachment = Effect.gen(function* prepareAttachment() {
  transport.writeRelationships.mockResolvedValue(v1.WriteRelationshipsResponse.create());
  const before = transport.insert.mock.calls.length;
  const creator = yield* makeLiveOperationFixture({
    ...attachmentConfiguration,
    actionExecutor: 'manager-only',
    managerProviderSubjectId: 'user-1',
    readerProviderSubjectId: 'user-2',
  });
  const seeded = transport.insert.mock.calls.slice(before);
  transport.nativeRows.mockReturnValue([safeNative]);
  transport.selectRows.mockImplementation((table) =>
    seeded.flatMap(([insertedTable, rows]) => {
      if (insertedTable !== table) {
        return [];
      }
      return Array.isArray(rows) ? rows : [rows];
    }),
  );
  return { creator, seeded };
});

const foreignFixtureIdentity = '00000000-0000-4000-8000-000000000099';
const faultedFixtureRows =
  (
    seeded: readonly (readonly [FixtureInsertTable, FixtureInsertValues])[],
    refusedTable: FixtureReadTable,
    fault: 'missing' | 'inactive' | 'mismatched',
  ) =>
  (table: FixtureReadTable) =>
    seeded.flatMap(([insertedTable, rows]) => {
      if (insertedTable !== table) {
        return [];
      }
      const values = Array.isArray(rows) ? rows : [rows];
      if (table !== refusedTable) {
        return values;
      }
      if (fault === 'missing') {
        return [];
      }
      return values.map((row) =>
        fault === 'inactive'
          ? { ...row, state: 'inactive', status: 'suspended' }
          : {
              ...row,
              legalEntityId: foreignFixtureIdentity,
              moduleKey: 'foreign.module',
              principalAuthBindingId: foreignFixtureIdentity,
              principalId: foreignFixtureIdentity,
              tenantId: foreignFixtureIdentity,
            },
      );
    });

it.layer(Layer.mergeAll(NodeCrypto.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({}))))(
  'runtime-only live fixture attachment',
  (suite) => {
    suite.effect('attaches with no admin configuration and performs no identity or grant writes', () =>
      Effect.gen(function* runtimeWithoutAdmin() {
        const { creator } = yield* prepareAttachment;
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        const runtime = yield* makeLiveOperationFixtureRuntime({
          configuration: creator.runtimeHandoff.configuration,
          handoff: creator.runtimeHandoff,
          runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
        });
        expect(runtime.manager).toEqual(creator.manager);
        expect(runtime.tenantId).toBe(creator.tenantId);
        expect(runtime.legalEntityId).toBe(creator.legalEntityId);
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
          creator.runtimeHandoff,
        );
        expect(encoded).not.toContain('postgresql:');
        expect(encoded).not.toContain('connectionString');
        expect(encoded).not.toContain('executor');
        yield* runtime.close();
        yield* creator.close();
      }),
    );

    suite.effect(
      'runtime-only attachment rejects module-state administration without a mutation or admin capability',
      () =>
        Effect.gen(function* rejectAttachedModuleStateMutation() {
          const { creator } = yield* prepareAttachment;
          const runtime = yield* makeLiveOperationFixtureRuntime({
            configuration: creator.runtimeHandoff.configuration,
            handoff: creator.runtimeHandoff,
            runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
          });
          const beforeUpdate = transport.updateRows.mock.calls.length;
          const beforeInsert = transport.insert.mock.calls.length;
          const failure = yield* Effect.flip(runtime.setConfiguredModuleState('party.registry', 'suspended'));
          expect(failure.reason).toBe('Configured module state mutation requires the fixture creator');
          expect(transport.updateRows).toHaveBeenCalledTimes(beforeUpdate);
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(LiveOperationFixtureRuntimeHandoffSchema))(
            runtime.runtimeHandoff,
          );
          expect(encoded).not.toContain('adminConnectionString');
          yield* runtime.close();
          yield* creator.close();
        }),
    );

    suite.effect('refuses foreign targets, configuration drift and unsafe native roles before setup capabilities', () =>
      Effect.gen(function* refuseUnsafeAttachment() {
        const { creator } = yield* prepareAttachment;
        const original = creator.runtimeHandoff;
        const inputs = [
          { ...original, target: { ...original.target, database: 'foreign' } },
          { ...original, configuration: { ...original.configuration, compositionRevision: 'b'.repeat(64) } },
          { ...original, configuration: { ...original.configuration, managerProviderSubjectId: 'other-user' } },
          { ...original, configuration: { ...original.configuration, readerProviderSubjectId: 'other-reader' } },
          { ...original, manager: { ...original.manager, tenantId: '00000000-0000-4000-8000-000000000001' } },
        ];
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const handoff of inputs) {
          const result = yield* Effect.result(
            makeLiveOperationFixtureRuntime({
              configuration: original.configuration,
              handoff,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
        }
        for (const native of [
          { ...safeNative, superuser: true },
          { ...safeNative, bypass: true },
          { ...safeNative, createDb: true },
          { ...safeNative, createRole: true },
          { ...safeNative, database: 'foreign' },
          { ...safeNative, session: 'administrator' },
        ]) {
          transport.nativeRows.mockReturnValue([native]);
          const result = yield* Effect.result(
            makeLiveOperationFixtureRuntime({
              configuration: original.configuration,
              handoff: original,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
        }
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* creator.close();
      }),
    );

    suite.effect(
      'rejects persisted reader subject substitution and invalid reader handoff selection without writes',
      () =>
        Effect.gen(function* refuseReaderIdentitySubstitution() {
          const { creator, seeded } = yield* prepareAttachment;
          const beforeInsert = transport.insert.mock.calls.length;
          const beforeWrite = transport.writeRelationships.mock.calls.length;
          const malformed = yield* Effect.result(
            Schema.decodeUnknownEffect(LiveOperationFixtureRuntimeHandoffSchema)({
              ...creator.runtimeHandoff,
              configuration: {
                ...creator.runtimeHandoff.configuration,
                readerProviderSubjectId: '',
              },
            }),
          );
          expect(Result.isFailure(malformed)).toBe(true);
          transport.selectRows.mockImplementation((table) => {
            const selected: FixtureReadRow[] = [];
            for (const [insertedTable, rows] of seeded) {
              if (insertedTable !== table) {
                continue;
              }
              for (const row of Array.isArray(rows) ? rows : [rows]) {
                selected.push(
                  table === principalAuthBindings &&
                    'principalId' in row &&
                    row.principalId === creator.reader.principalId
                    ? { ...row, providerSubjectId: 'substituted-reader' }
                    : row,
                );
              }
            }
            return selected;
          });
          const failure = yield* Effect.flip(
            makeLiveOperationFixtureRuntime({
              configuration: creator.runtimeHandoff.configuration,
              handoff: creator.runtimeHandoff,
              runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
            }),
          );
          assert(Predicate.isTagged(failure, 'LiveOperationFixtureError'));
          expect(failure.reason).toBe('Runtime fixture identities are not the active persisted creator state');
          expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
          expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
          yield* creator.close();
        }),
    );

    suite.effect('refuses inactive, contradictory or missing persisted creator identities', () =>
      Effect.gen(function* refuseMissingCreatorState() {
        const { creator, seeded } = yield* prepareAttachment;
        const beforeInsert = transport.insert.mock.calls.length;
        const beforeWrite = transport.writeRelationships.mock.calls.length;
        for (const refusedTable of [tenants, legalEntities, principals, principalAuthBindings, tenantModuleStates]) {
          for (const fault of ['missing', 'inactive', 'mismatched'] as const) {
            transport.selectRows.mockImplementation(faultedFixtureRows(seeded, refusedTable, fault));
            const result = yield* Effect.result(
              makeLiveOperationFixtureRuntime({
                configuration: creator.runtimeHandoff.configuration,
                handoff: creator.runtimeHandoff,
                runtimeConnectionString: attachmentConfiguration.runtimeConnectionString,
              }),
            );
            expect(Result.isFailure(result)).toBe(true);
          }
        }
        expect(transport.insert).toHaveBeenCalledTimes(beforeInsert);
        expect(transport.writeRelationships).toHaveBeenCalledTimes(beforeWrite);
        yield* creator.close();
      }),
    );

    suite.effect(
      'accepts one closed bootstrap request and rejects malformed or repeated requests without another seed',
      () =>
        Effect.gen(function* oneShotBootstrap() {
          const { creator } = yield* prepareAttachment;
          let calls = 0;
          const bootstrap = yield* makeLiveOperationFixtureBootstrap(() =>
            Effect.sync(() => {
              calls += 1;
              return creator.runtimeHandoff;
            }),
          );
          for (const request of [
            { sql: 'forbidden', type: 'execute-sql' },
            { type: 'auth-user-created' },
            { adminConnectionString: 'forbidden', providerSubjectId: 'user-1', type: 'auth-user-created' },
          ]) {
            expect(
              Result.isFailure(
                yield* Effect.result(
                  Schema.decodeUnknownEffect(LiveOperationFixtureBootstrapRequestSchema, { onExcessProperty: 'error' })(
                    request,
                  ),
                ),
              ),
            ).toBe(true);
          }
          expect(calls).toBe(0);
          expect((yield* bootstrap({ providerSubjectId: 'user-1', type: 'auth-user-created' })).handoff).toEqual(
            creator.runtimeHandoff,
          );
          expect(
            Result.isFailure(
              yield* Effect.result(bootstrap({ providerSubjectId: 'user-2', type: 'auth-user-created' })),
            ),
          ).toBe(true);
          expect(calls).toBe(1);
          const mismatched = yield* makeLiveOperationFixtureBootstrap(() => Effect.succeed(creator.runtimeHandoff));
          expect(
            Result.isFailure(
              yield* Effect.result(mismatched({ providerSubjectId: 'other-user', type: 'auth-user-created' })),
            ),
          ).toBe(true);
          yield* creator.close();
        }),
    );
  },
);
