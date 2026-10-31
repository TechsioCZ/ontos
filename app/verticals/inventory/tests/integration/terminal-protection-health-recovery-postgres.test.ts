import {
  ActionTransactionError,
  OwnerAuthorizationOverlay,
  makeBusinessPermissionRelationshipMutationLive,
  runAction,
  findPostgresFailure,
  transactionalOwnerAuthorization,
} from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Cause,
  Clock,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Match,
  Path,
  Option,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { Reactivity } from 'effect/reactivity';
import { TestClock } from 'effect/testing';
import { assert, expect, it } from 'effect-rstest';

import type { InventoryEffectLedgerRecord } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryEffectLedgerEffectIdSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import type { AuthoritativeReservationEvidence } from '../../shared/domain/reservation-authority.ts';

import {
  CatalogToStockBindingSchema,
  CatalogToStockBindingRejected,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  CommitmentProtectionSchema,
  establishCommitmentProtection,
  markCommitmentProtectionAtRisk,
} from '../../shared/domain/commitment-protection.ts';
import type {
  CommitmentProtectionEffect,
  CommitmentProtectionEffectRequest,
} from '../../shared/domain/commitment-protection.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  AlreadyTerminalInventoryEffectResultSchema,
  AuthoritativeSuccessInventoryEffectRecoveryObservationSchema,
  IndeterminateInventoryEffectResultSchema,
} from '../../shared/domain/inventory-effect-recovery.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import { correctCatalogToStockBindingAction } from '../../src/actions/correct-catalog-to-stock-binding.action.ts';
import { recoverInventoryEffectAction } from '../../src/actions/recover-inventory-effect.action.ts';
import { InventoryEffectRecoveryAuthorityPort } from '../../src/services/inventory-effect-recovery-authority.ts';
import {
  INVENTORY_TABLES,
  inventoryRelations,
  inventoryCommitmentProtections,
  inventoryCommitmentProtectionHistory,
  inventoryCatalogToStockBindings,
  inventoryCatalogToStockBindingHistory,
  inventoryObligations,
  inventoryObligationRequirements,
  inventoryObligationAllocations,
} from '../../src/database/schema.ts';
import { makeDrizzleCatalogToStockBindingPersistence } from '../../src/persistence/catalog-to-stock-binding-repository.ts';
import {
  commitmentProtectionPersistenceForScope,
  finalizeCommitmentProtectionForWorkerRoutine,
} from '../../src/persistence/commitment-protection-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import { inventoryEffectLedgerPersistenceForScope } from '../../src/persistence/inventory-effect-ledger-repository.ts';
import {
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
} from '../../src/persistence/inventory-effect-ledger-table.ts';
import { inventoryObligationPersistenceForScope } from '../../src/persistence/inventory-obligation-repository.ts';
import { reservationCreateEffectPersistenceForScope } from '../../src/persistence/reservation-create-effect-repository.ts';
import { reservationConfirmationPersistenceForScope } from '../../src/persistence/reservation-confirmation-repository.ts';
import { inventoryStockItems } from '../../src/persistence/stock-item-table.ts';
import { makeDrizzleStockItemRepository } from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { stockPositionPersistenceForScope } from '../../src/persistence/stock-position-repository.ts';
import { makeCommitmentProtectionEstablishmentExecutionService } from '../../src/services/commitment-protection.service.ts';
import type {
  CommitmentProtectionExecutionScope,
  CommitmentProtectionEstablishmentExecutionService,
} from '../../src/services/commitment-protection.service.ts';
import {
  commitmentProtectionLedgerResolution,
  makeInventoryEffectLedgerService,
} from '../../src/services/inventory-effect-ledger.service.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const originalAt = '2026-09-25T10:10:00.000Z';
const laterAt = '2026-09-25T13:10:00.000Z';
const establishmentAt = '2026-09-25T10:11:00.000Z';
const topic = 'commerce.inventory.commitment-protection-establishment-requested.v1';
const uuidPattern = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gu;

const remap = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: S['Type'],
  identities: ReadonlyMap<string, string>,
) =>
  Schema.decodeUnknownEffect(schema)(
    JSON.parse(JSON.stringify(value).replace(uuidPattern, (source) => identities.get(source) ?? source)),
  );

const recoverOriginal = Effect.fn('TerminalProtectionHealth.recoverOriginal')(function* recoverOriginal(
  record: InventoryEffectLedgerRecord,
  evidenceFor: (
    request: CommitmentProtectionEffectRequest,
  ) => Effect.Effect<AuthoritativeReservationEvidence, Schema.SchemaError>,
) {
  assert(Predicate.isTagged(record.intent, 'ESTABLISH_COMMITMENT_PROTECTION'));
  const { intent } = record;
  const evidence = yield* evidenceFor(intent.request);
  const established = yield* establishCommitmentProtection({
    authorityEvidence: evidence,
    confirmation: intent.request.confirmation,
    protectionRef: intent.request.protectionRef,
  });
  return yield* Schema.decodeUnknownEffect(AuthoritativeSuccessInventoryEffectRecoveryObservationSchema)({
    _tag: 'AUTHORITATIVE_SUCCESS',
    effectId: record.effectId,
    intent,
    kind: 'ESTABLISH_COMMITMENT_PROTECTION',
    learnedAt: laterAt,
    occurredAt: establishmentAt,
    ownerEvidenceRef: evidence.evidence.ownerEvidenceRef,
    resolution: commitmentProtectionLedgerResolution({
      _tag: 'PROTECTED',
      protection: established,
      request: intent.request,
    }),
  });
});
const executePrepared = Effect.fn('TerminalProtectionHealth.executePrepared')(function* executePrepared<
  TScope extends CommitmentProtectionExecutionScope,
>(
  execution: CommitmentProtectionEstablishmentExecutionService<TScope>,
  executionScope: TScope,
  request: CommitmentProtectionEffectRequest,
) {
  const prepared = yield* execution.prepare(executionScope, request);
  if (Predicate.isTagged(prepared, 'TERMINAL')) {
    return yield* Effect.void;
  }
  const outcome = yield* execution.attempt(prepared);
  return yield* Match.value(outcome).pipe(
    Match.tag('PENDING', () => Effect.void),
    Match.orElse((terminal) => execution.finalize(executionScope, prepared, terminal)),
  );
});
// Owner/native execution adapter: the real scoped transaction supplies routine authority.
// This does not attest an Outbox Worker capability or delivery.
const finalizeOwnerExecution = Effect.fn('TerminalProtectionHealth.finalizeOwnerExecution')(
  function* finalizeOwnerExecution(
    transaction: ScopedTransactionExecutor,
    expected: InventoryEffectLedgerRecord,
    effect: CommitmentProtectionEffect,
  ) {
    const [row] = yield* transaction.invoke(finalizeCommitmentProtectionForWorkerRoutine, [
      expected.effectId,
      expected.revision,
      expected.currentState,
      effect,
    ]);
    assert(row !== undefined);
    return row.record;
  },
);
const incrementCall = (count: number) => count + 1;

const makeScenario = Effect.fn('TerminalProtectionHealth.makeScenario')(function* makeScenario() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1264-terminal-protection-health',
  });
  yield* isolated.migrateCoreSchema();
  const databaseServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(databaseServices));
  const admin = yield* makeWithDefaults({ relations: inventoryRelations }).pipe(Effect.provide(databaseServices));
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-terminal-protection-health-' });
  const configurationPath = path.join(temporary, 'drizzle.config.mjs');
  yield* filesystem.writeFileString(
    configurationPath,
    `export default {
    dialect: 'postgresql',
    out: process.env.ONTOS_PROTECTION_HEALTH_MIGRATIONS,
    schema: process.env.ONTOS_PROTECTION_HEALTH_SCHEMA,
    dbCredentials: { url: process.env.DATABASE_ADMIN_URL },
    migrations: { schema: 'drizzle', table: '__drizzle_migrations_inventory' }
  };`,
  );
  const migration = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/inventory',
      'exec',
      'drizzle-kit',
      'migrate',
      '--config',
      configurationPath,
    ],
    {
      cwd: new URL('../../../../', import.meta.url).pathname,
      env: {
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        DATABASE_URL: isolated.connections.runtime.connectionString,
        ONTOS_PROTECTION_HEALTH_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
        ONTOS_PROTECTION_HEALTH_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  // Drain CLI output because diagnostics may contain connection credentials.
  const [migrationStatus] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
    { concurrency: 3 },
  );
  expect(Number(migrationStatus)).toBe(0);
  // Reproduce only the normal Inventory runtime grants in this newly created owned database.
  const runtimeRole = sql.identifier(isolated.connections.runtime.user);
  yield* admin.execute(sql`grant usage on schema inventory to ${runtimeRole}`, 'objects');
  yield* Effect.forEach(
    INVENTORY_TABLES,
    (table) => admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
    { concurrency: 1 },
  );
  yield* admin.execute(sql`grant usage,select on all sequences in schema inventory to ${runtimeRole}`, 'objects');
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(['inventory'], 'terminal-protection-health-native');
  yield* isolated.publishInitialComposition(snapshot);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [
        establishCommitmentProtectionAction,
        correctCatalogToStockBindingAction,
        recoverInventoryEffectAction,
      ].map((action) => action.descriptor.actionKey),
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['inventory'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.inventory'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (value) => value.close().pipe(Effect.orDie),
  );
  const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
  const ids = [
    ...new Set(
      JSON.stringify({
        lineage,
        locationId: '66666666-6666-4666-8666-666666666666',
        source: inventoryOwnerAcceptanceBindingCorrectionFixture,
      }).match(uuidPattern),
    ),
  ];
  const crypto = yield* Crypto.Crypto;
  const mappedIds = yield* Effect.forEach(
    ids,
    (source) => crypto.randomUUIDv4().pipe(Effect.map((target) => [source, target] as const)),
    { concurrency: 1 },
  );
  const identities = new Map([...mappedIds, ['11111111-1111-4111-8111-111111111111', fixture.tenantId]]);
  const reservation = yield* remap(ProvisionalInventoryReservationSchema, lineage.reservation, identities);
  const confirmation = yield* remap(ReservationConfirmationSchema, lineage.confirmation, identities);
  const protection = yield* remap(CommitmentProtectionSchema, lineage.protection, identities);
  const authority = yield* remap(
    InventoryBackendConfigurationSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.authority,
    identities,
  );
  const binding = yield* remap(
    CatalogToStockBindingSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.originalBinding,
    identities,
  );
  const item = yield* remap(
    StockItemSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.originalStockItem,
    identities,
  );
  const [requirement] = reservation.requirements;
  const [allocation] = requirement?.allocations ?? [];
  const locationId = identities.get('66666666-6666-4666-8666-666666666666');
  assert(requirement !== undefined && allocation !== undefined && locationId !== undefined);
  yield* fixture
    .prepareOwner(
      (transaction, scope) =>
        Effect.gen(function* createOriginalLineage() {
          yield* inventoryBackendConfigurationPersistenceForScope(transaction, scope).insertInitial(authority);
          yield* makeDrizzleStockItemRepository(transaction).insert(item);
          const locationRef = {
            moduleId: 'commerce.inventory',
            resourceId: locationId,
            resourceType: 'commerce.inventory.stock-location',
            tenantId: fixture.tenantId,
          };
          yield* stockLocationPersistenceForScope(transaction, scope).create(
            yield* Schema.decodeUnknownEffect(StockLocationSchema)({
              displayName: 'Protection retry native',
              lifecycle: { _tag: 'ACTIVE' },
              operationalScope: { _tag: 'LOGICAL_AGGREGATE', physicalSiteKeys: [] },
              ref: locationRef,
              revision: 1,
            }),
          );
          yield* stockPositionPersistenceForScope(transaction, scope).create(
            yield* Schema.decodeUnknownEffect(StockPositionSchema)({
              createdAt: authority.selectedAt,
              endedAt: null,
              lifecycle: 'CURRENT',
              onHand: {
                _tag: 'UNKNOWN',
                meaning: 'ON_HAND',
                ownerConfigurationRef: {
                  moduleId: 'commerce.inventory',
                  resourceId: authority.configurationId,
                  resourceType: 'commerce.inventory.inventory-backend-configuration',
                  tenantId: fixture.tenantId,
                },
                unitRef: item.unitRef,
              },
              ref: allocation.positionRef,
              revision: 1,
              scope: {
                customerConfigurationId: authority.customerConfigurationId,
                stockItemRef: item.stockItemRef,
                stockLocationRef: locationRef,
                unitRef: item.unitRef,
              },
            }),
          );
          yield* makeDrizzleCatalogToStockBindingPersistence(transaction).insertCurrent(binding);
          assert(scope.legalEntityId !== undefined);
          const createRequest = yield* Schema.decodeUnknownEffect(InventoryReservationCreateRequestSchema)({
            authority,
            commerceContext: {
              channel: 'B2C',
              commerceMarketRef: {
                moduleId: 'commerce.market-catalog',
                resourceId: 'market-primary',
                resourceType: 'commerce.market-catalog.market',
                tenantId: fixture.tenantId,
              },
              customerConfigurationId: authority.customerConfigurationId,
              evidenceRef: 'commerce-owner:native-protection',
              observedAt: authority.selectedAt,
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: scope.legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId: fixture.tenantId,
              },
              status: 'CURRENT_OWNER_VERIFIED',
              storefrontRef: { appId: 'storefront-primary', tenantId: fixture.tenantId },
              tenantId: fixture.tenantId,
            },
            effectId: 'create:native-protection-retry',
            legalEntityId: scope.legalEntityId,
            mutationId: '88888888-8888-4888-8888-888888888888',
            requestedAt: reservation.establishedAt,
            reservation: { origin: reservation.origin, ref: reservation.ref, requirements: reservation.requirements },
            sourceActionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          });
          const creates = reservationCreateEffectPersistenceForScope(transaction, scope);
          const created = yield* creates.createOrRead(createRequest);
          yield* inventoryObligationPersistenceForScope(transaction, scope).establishReservation(reservation);
          yield* creates.save(
            created.effect,
            yield* Schema.decodeUnknownEffect(EstablishedReservationCreateEffectSchema)({
              _tag: 'ESTABLISHED',
              ownerEvidenceRef: 'original-backend:reservation-established',
              request: createRequest,
              reservation,
            }),
          );
          yield* reservationConfirmationPersistenceForScope(transaction, scope).createOrRead(confirmation);
        }),
      'required',
    )
    .pipe(Effect.provide(fixture.layer));
  const payload = {
    confirmationRef: confirmation.ref,
    effectId: ReservationAuthorityEffectIdSchema.make('protection:native-retry'),
    protectionRef: protection.ref,
  };
  // Test-owned exact admission for these three real owner Actions; production remains unchanged.
  const ownerAuthorization = Layer.succeed(
    OwnerAuthorizationOverlay,
    transactionalOwnerAuthorization((transaction, input) => {
      if (
        input.operation !== 'action' ||
        input.owningModuleKey !== 'commerce.inventory' ||
        input.scope.tenantId !== fixture.tenantId
      ) {
        return Effect.succeed('unavailable' as const);
      }
      if (
        input.operationKey === correctCatalogToStockBindingAction.descriptor.actionKey &&
        input.scope.legalEntityId === undefined
      ) {
        return makeDrizzleCatalogToStockBindingPersistence(transaction)
          .findCurrentByExactSelectionMeaning(fixture.tenantId, binding.exactSelectionMeaning)
          .pipe(
            Effect.match({
              onFailure: () => 'unavailable' as const,
              onSuccess: (rows) => (rows.length === 1 ? ('allowed' as const) : ('unavailable' as const)),
            }),
          );
      }
      if (input.scope.legalEntityId !== fixture.legalEntityId) {
        return Effect.succeed('unavailable' as const);
      }
      if (
        input.operationKey === establishCommitmentProtectionAction.descriptor.actionKey ||
        input.operationKey === recoverInventoryEffectAction.descriptor.actionKey
      ) {
        return reservationConfirmationPersistenceForScope(transaction, input.scope)
          .findByRef(confirmation.ref)
          .pipe(
            Effect.match({
              onFailure: () => 'unavailable' as const,
              onSuccess: (found) => (Option.isSome(found) ? ('allowed' as const) : ('unavailable' as const)),
            }),
          );
      }
      return Effect.succeed('unavailable' as const);
    }),
  );
  const recoveryCalls = yield* Ref.make(0);
  const recoveryAuthority = Layer.succeed(InventoryEffectRecoveryAuthorityPort, {
    recoverOriginal: (record) =>
      Ref.update(recoveryCalls, incrementCall).pipe(
        Effect.as({
          _tag: 'INDETERMINATE' as const,
          effectId: record.effectId,
          intent: record.intent,
          kind: record.intent._tag,
          learnedAt: laterAt,
          reason: 'OWNER_UNAVAILABLE' as const,
        }),
      ),
  });
  const layer = fixture.layer.pipe(Layer.provide(ownerAuthorization));
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const permission = yield* makeBusinessPermissionRelationshipMutationLive();
  const businessTarget = {
    kind: 'inventory_resource' as const,
    resource: {
      moduleId: 'commerce.inventory' as const,
      resourceId: protection.ref.resourceId,
      resourceType: protection.ref.resourceType,
    },
    tenantId: fixture.tenantId,
  };
  const permissions = [
    { permission: 'inventory.commitment_protection.establish' as const, target: businessTarget },
    { permission: 'inventory.recovery.execute' as const, target: businessTarget },
    {
      permission: 'inventory.catalog_to_stock_binding.manage' as const,
      target: {
        ...businessTarget,
        resource: {
          moduleId: binding.bindingRef.moduleId,
          resourceId: binding.bindingRef.resourceId,
          resourceType: binding.bindingRef.resourceType,
        },
      },
    },
  ];
  for (const entry of permissions) {
    yield* permission.mutate({ ...entry, operation: 'grant', principal });
    yield* Effect.addFinalizer(() =>
      permission.mutate({ ...entry, operation: 'revoke', principal }).pipe(Effect.orDie),
    );
  }
  const correctionPermission = permissions.find(
    ({ permission: key }) => key === 'inventory.catalog_to_stock_binding.manage',
  );
  assert(correctionPermission !== undefined);
  const correctionBusiness = (operation: 'grant' | 'revoke') =>
    permission.mutate({ ...correctionPermission, operation, principal });
  yield* fixture.grantResourceAccess(protection.ref, fixture.manager.principalId, 'writer');
  yield* fixture.grantResourceAccess(binding.bindingRef, fixture.manager.principalId, 'writer');
  const clock = yield* TestClock.make();
  yield* clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(originalAt)));
  const invoke = (key: string) =>
    runAction({
      payload,
      principal,
      registration: establishCommitmentProtectionAction,
      transport: { correlationId: `protection-${key}`, idempotencyKey: key },
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  const observe = () =>
    fixture
      .prepareOwner(
        (transaction) =>
          Effect.all(
            {
              allocations: transaction.select().from(inventoryObligationAllocations),
              bindingHistory: transaction.select().from(inventoryCatalogToStockBindingHistory),
              bindings: transaction.select().from(inventoryCatalogToStockBindings),
              history: transaction.select().from(inventoryEffectLedgerHistory),
              ledger: transaction.select().from(inventoryEffectLedger),
              obligations: transaction.select().from(inventoryObligations),
              protectionHistory: transaction.select().from(inventoryCommitmentProtectionHistory),
              protections: transaction.select().from(inventoryCommitmentProtections),
              requirements: transaction.select().from(inventoryObligationRequirements),
              stockItems: transaction.select().from(inventoryStockItems).orderBy(inventoryStockItems.stockItemId),
            },
            { concurrency: 1 },
          ),
        'required',
      )
      .pipe(Effect.provide(layer));
  const originalRequest = () =>
    observe().pipe(
      Effect.map(({ ledger }) => {
        const [row] = ledger;
        assert(row !== undefined && Predicate.isTagged(row.snapshot.intent, 'ESTABLISH_COMMITMENT_PROTECTION'));
        return row.snapshot.intent.request;
      }),
    );
  const calls = yield* Ref.make(0);
  const evidenceFor = (request: CommitmentProtectionEffectRequest) =>
    Schema.decodeUnknownEffect(AuthoritativeReservationEvidenceSchema)({
      ...confirmation.authorityEvidence,
      effectId: request.effectId,
      evidence: {
        ...confirmation.authorityEvidence.evidence,
        ownerEvidenceRef: 'original-authority:protection-established',
        validFrom: establishmentAt,
      },
      operation: 'COMMITMENT_PROTECTION',
    });
  const execute = (request: CommitmentProtectionEffectRequest) =>
    fixture
      .prepareOwner((transaction, scope) => {
        assert(scope.legalEntityId !== undefined);
        const ownerIdentity = { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };
        const execution = makeCommitmentProtectionEstablishmentExecutionService({
          authority: {
            establish: (input) =>
              Ref.update(calls, incrementCall).pipe(
                Effect.as({
                  competingFreshEffectAllowed: false as const,
                  effectId: input.effectId,
                  kind: 'INDETERMINATE' as const,
                  recovery: 'RECOVER_ORIGINAL_EFFECT' as const,
                }),
              ),
          },
          confirmations: () => reservationConfirmationPersistenceForScope(transaction, scope),
          finalizer: (_identity, expected, effect) =>
            finalizeOwnerExecution(transaction, expected, effect).pipe(Effect.orDie),
          ledger: () =>
            makeInventoryEffectLedgerService(
              inventoryEffectLedgerPersistenceForScope(transaction, scope),
              DateTime.now.pipe(Effect.map(DateTime.formatIso)),
            ),
          recoveryAuthority: {
            recoverOriginal: (record) => recoverOriginal(record, evidenceFor).pipe(Effect.orDie),
          },
        });
        return executePrepared(execution, ownerIdentity, request);
      }, 'required')
      .pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  const recover = (key: string, actor = principal) =>
    runAction({
      payload: {
        effectId: InventoryEffectLedgerEffectIdSchema.make(payload.effectId),
        expectedKind: 'ESTABLISH_COMMITMENT_PROTECTION',
        targetRef: payload.protectionRef,
      },
      principal: actor,
      registration: recoverInventoryEffectAction,
      transport: { correlationId: `recovery-${key}`, idempotencyKey: `recovery-${key}` },
    }).pipe(Effect.provide(layer), Effect.provide(recoveryAuthority), Effect.provideService(Clock.Clock, clock));
  const correct = (
    options: {
      readonly actor?: typeof fixture.manager & { readonly legalEntityId?: typeof fixture.legalEntityId };
      readonly at?: string;
      readonly bindingRevision?: number;
      readonly itemRevision?: number;
      readonly key?: string;
      readonly sourceRef?: typeof item.stockItemRef;
    } = {},
  ) =>
    Effect.gen(function* correctOriginalBinding() {
      const correctedAt = options.at ?? '2026-09-25T10:12:00.000Z';
      yield* clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(correctedAt)));
      return yield* runAction({
        payload: {
          bindingRef: binding.bindingRef,
          candidate: {
            _tag: 'REPLACE_CURRENT_STOCK_ITEM',
            catalogSelection: binding.catalogSelection,
            exactSelectionMeaning: binding.exactSelectionMeaning,
            expectedBindingRevision: options.bindingRevision ?? binding.revision,
            expectedStockItemRef: options.sourceRef ?? item.stockItemRef,
            expectedStockItemRevision: options.itemRevision ?? item.revision,
          },
          evidence: { authority: 'INVENTORY_BINDING_OWNER', ownerEvidenceRef: 'terminal-health:binding-correction' },
        },
        principal: options.actor ?? fixture.manager,
        registration: correctCatalogToStockBindingAction,
        transport: {
          correlationId: 'supported-binding-correction',
          idempotencyKey: options.key ?? 'supported-binding-correction',
        },
      }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
    });
  const impair = (at: string) =>
    clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(at))).pipe(
      Effect.andThen(
        fixture
          .prepareOwner(
            (transaction, scope) =>
              Effect.gen(function* impairOriginalFence() {
                const persistence = commitmentProtectionPersistenceForScope(transaction, scope);
                const current = yield* persistence.findByRef(protection.ref).pipe(Effect.map(Option.getOrThrow));
                const next = yield* markCommitmentProtectionAtRisk(current, {
                  _tag: 'MATERIAL_IMPAIRMENT',
                  effectiveAt: at,
                  ownerEvidenceRef: 'terminal-health:later-impairment',
                });
                return yield* persistence.saveRevision({ current, next });
              }),
            'required',
          )
          .pipe(Effect.provide(layer)),
      ),
    );
  return {
    admin,
    binding,
    calls,
    clock,
    coreEvidenceExecutor,
    correct,
    correctionBusiness,
    execute,
    fixture,
    impair,
    invoke,
    item,
    layer,
    observe,
    originalRequest,
    payload,
    principal,
    recover,
    recoveryCalls,
  };
});

it.live(
  'governed terminal Recovery preserves historical success after real Binding Correction and later health revisions',
  () =>
    Effect.scoped(
      Effect.gen(function* terminalHealthRecovery() {
        const scenario = yield* makeScenario();
        yield* scenario.invoke('establish-original');
        const request = yield* scenario.originalRequest();
        yield* scenario.execute(request);
        yield* scenario.execute(request);
        const original = yield* scenario.observe();
        const [ledger] = original.ledger;
        const [initial] = original.protections;
        assert(ledger !== undefined && initial !== undefined);
        expect(ledger.currentState).toBe('SUCCEEDED');
        expect(initial.currentHealthState).toBe('PROTECTED');
        const beforeCorrection = yield* scenario.recover('before-correction');
        expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(beforeCorrection)).toBe(true);
        expect(yield* scenario.observe()).toEqual(original);
        const corrected = yield* scenario.correct();
        const affected = yield* scenario.observe();
        const [current] = affected.protections;
        assert(current !== undefined);
        expect(current.currentHealthState).toBe('AT_RISK');
        expect(current.currentRevision).toBe(2);
        expect(corrected.bindingRef).toEqual(scenario.binding.bindingRef);
        expect(corrected.revision).toBe(2);
        expect(affected.bindingHistory).toHaveLength(1);
        expect(affected.bindingHistory[0]?.transition).toBe('CORRECTED');
        const retired = affected.stockItems.find((row) => row.stockItemId === scenario.item.stockItemRef.resourceId);
        const replacement = affected.stockItems.find((row) => row.stockItemId === corrected.stockItemRef.resourceId);
        expect(retired).toMatchObject({ lifecycleState: 'RETIRED', revision: 2 });
        expect(replacement).toMatchObject({
          exactSelectionMeaningId: scenario.item.exactSelectionMeaning.id,
          lifecycleState: 'CURRENT',
          revision: 1,
        });
        expect(affected.stockItems.filter((row) => row.lifecycleState === 'CURRENT')).toHaveLength(1);
        expect(current.snapshot.health.reconciliationRequired).toBe(true);
        expect(current.snapshot.confirmation).toEqual(initial.snapshot.confirmation);
        expect(current.snapshot.authorityEvidence).toEqual(initial.snapshot.authorityEvidence);
        expect(affected.ledger).toEqual(original.ledger);
        expect(affected.history).toEqual(original.history);
        expect(affected.obligations).toEqual(original.obligations);
        expect(affected.requirements).toEqual(original.requirements);
        expect(affected.allocations).toEqual(original.allocations);
        expect(corrected.stockItemRef).not.toEqual(
          initial.snapshot.confirmation.reservation.requirements[0]?.stockItem.stockItemRef,
        );
        const recovered = yield* scenario.recover('after-correction');
        expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(recovered)).toBe(true);
        expect(recovered.record).toEqual(ledger.snapshot);
        expect(yield* scenario.observe()).toEqual(affected);
        // Negative SQL guard only: a skipped revision cannot become native owner history.
        const invalidRevision = yield* scenario.fixture
          .prepareOwner(
            (transaction) =>
              transaction
                .update(inventoryCommitmentProtections)
                .set({
                  currentRevision: current.currentRevision + 2,
                  snapshot: { ...current.snapshot, revision: current.currentRevision + 2 },
                })
                .where(eq(inventoryCommitmentProtections.protectionId, current.protectionId)),
            'required',
          )
          .pipe(Effect.provide(scenario.layer), Effect.exit);
        assert(Exit.isFailure(invalidRevision));
        expect(Option.isSome(findPostgresFailure(invalidRevision.cause, ({ code }) => code === '23514'))).toBe(true);
        expect(yield* scenario.observe()).toEqual(affected);
        const replay = yield* scenario.recover('after-correction').pipe(Effect.flip);
        expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
        expect(yield* scenario.observe()).toEqual(affected);
        const denied = yield* scenario
          .recover('denied', { ...scenario.fixture.denied, legalEntityId: scenario.fixture.legalEntityId })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(denied, 'OperationContextDenied')).toBe(true);
        expect(yield* scenario.observe()).toEqual(affected);
        const executorDenied = yield* scenario
          .recover('executor-denied', {
            ...scenario.fixture.legalEntityOnly,
            legalEntityId: scenario.fixture.legalEntityId,
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(executorDenied, 'ActionPermissionDenied')).toBe(true);
        expect(yield* scenario.observe()).toEqual(affected);
        yield* scenario.impair('2026-09-25T10:13:00.000Z');
        const later = yield* scenario.observe();
        const concurrent = yield* Effect.all([scenario.recover('parallel-a'), scenario.recover('parallel-b')], {
          concurrency: 2,
        });
        expect(concurrent.every(Schema.is(AlreadyTerminalInventoryEffectResultSchema))).toBe(true);
        expect(yield* scenario.observe()).toEqual(later);
        expect(later.protectionHistory.map((entry) => entry.revision)).toEqual([1, 2, 3]);
        const raced = yield* Effect.all(
          [scenario.recover('concurrent-health'), scenario.impair('2026-09-25T10:14:00.000Z')],
          { concurrency: 2 },
        );
        expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(raced[0])).toBe(true);
        const afterRace = yield* scenario.observe();
        expect(afterRace.protectionHistory.map((entry) => entry.revision)).toEqual([1, 2, 3, 4]);
        expect(afterRace.protections.map((entry) => entry.currentHealthState)).toEqual(['AT_RISK']);
        expect(afterRace.ledger).toEqual(original.ledger);
        expect(afterRace.history).toEqual(original.history);
        expect(afterRace.obligations).toEqual(original.obligations);
        expect(afterRace.requirements).toEqual(original.requirements);
        expect(afterRace.allocations).toEqual(original.allocations);
        expect(yield* Ref.get(scenario.recoveryCalls)).toBe(0);
        expect(yield* Ref.get(scenario.calls)).toBe(1);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

it.live('nonterminal Recovery still queries the original authority and preserves uncertainty', () =>
  Effect.scoped(
    Effect.gen(function* nonterminalRecovery() {
      const scenario = yield* makeScenario();
      yield* scenario.invoke('establish-pending');
      const result = yield* scenario.recover('pending');
      expect(Schema.is(IndeterminateInventoryEffectResultSchema)(result)).toBe(true);
      expect(yield* Ref.get(scenario.recoveryCalls)).toBe(1);
      const observed = yield* scenario.observe();
      expect(observed.protections).toEqual([]);
      expect(observed.protectionHistory).toEqual([]);
      expect(observed.ledger.map((record) => record.currentState)).toEqual(['INDETERMINATE']);
      expect(
        (yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox.filter(
          (message) => message.topic === topic,
        ),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live(
  'rolls back replacement when actual Protection impacts reject and preserves source/scope/permission guards',
  () =>
    Effect.scoped(
      Effect.gen(function* atomicReplacementRollback() {
        const scenario = yield* makeScenario();
        yield* scenario.invoke('rollback-establishment');
        const request = yield* scenario.originalRequest();
        yield* scenario.execute(request);
        yield* scenario.execute(request);
        const before = yield* scenario.observe();
        const boundRetirement = yield* scenario.fixture
          .prepareOwner(
            (transaction) =>
              makeDrizzleStockItemRepository(transaction).retire(scenario.item, '2026-09-25T10:12:00.000Z'),
            'required',
          )
          .pipe(Effect.provide(scenario.layer), Effect.exit);
        assert(Exit.isFailure(boundRetirement));
        expect(
          Option.isSome(
            findPostgresFailure(
              boundRetirement.cause,
              ({ code, constraint }) =>
                code === '23514' && constraint === 'inventory_stock_items_current_binding_target_ck',
            ),
          ),
        ).toBe(true);
        expect(yield* scenario.observe()).toEqual(before);
        for (const options of [
          { bindingRevision: 2, key: 'wrong-binding-revision' },
          { itemRevision: 2, key: 'wrong-item-revision' },
          {
            key: 'wrong-source',
            sourceRef: yield* Schema.decodeUnknownEffect(StockItemSchema.fields.stockItemRef)({
              ...scenario.item.stockItemRef,
              resourceId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
            }),
          },
        ]) {
          const failure = yield* scenario.correct(options).pipe(Effect.flip);
          assert(Schema.is(CatalogToStockBindingRejected)(failure));
          expect(failure.reason).toBe('REVISION_CONFLICT');
          expect(yield* scenario.observe()).toEqual(before);
        }
        const foreignSource = yield* scenario
          .correct({
            key: 'foreign-source',
            sourceRef: yield* Schema.decodeUnknownEffect(StockItemSchema.fields.stockItemRef)({
              ...scenario.item.stockItemRef,
              tenantId: yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()),
            }),
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(foreignSource)).toBe(true);
        expect(yield* scenario.observe()).toEqual(before);
        const denied = yield* scenario
          .correct({ actor: scenario.fixture.denied, key: 'denied-correction' })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(denied, 'ActionPermissionDenied')).toBe(true);
        expect(yield* scenario.observe()).toEqual(before);
        yield* scenario.correctionBusiness('revoke');
        const businessDenied = yield* scenario.correct({ key: 'business-denied' }).pipe(Effect.flip);
        expect(Predicate.isTagged(businessDenied, 'ActionPermissionDenied')).toBe(true);
        expect(yield* scenario.observe()).toEqual(before);
        yield* scenario.correctionBusiness('grant');
        const wrongLegalEntity = yield* scenario
          .correct({
            actor: { ...scenario.fixture.manager, legalEntityId: scenario.fixture.legalEntityId },
            key: 'forbidden-legal-entity',
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(wrongLegalEntity)).toBe(true);
        expect(yield* scenario.observe()).toEqual(before);
        // The binding transition is later than B1, but the genuine P1 health is later still.
        // Actual owner impacts reject after Item/binding rotation; the same Action rolls it all back.
        const rollback = yield* scenario
          .correct({ at: '2026-09-25T10:10:30.000Z', key: 'impact-rejection' })
          .pipe(Effect.flip);
        assert(Schema.is(CatalogToStockBindingUnavailable)(rollback));
        expect(rollback.code).toBe('catalog_to_stock_binding_unavailable');
        expect(rollback.reason).toBe('Binding correction impact propagation is temporarily unavailable');
        expect(yield* scenario.observe()).toEqual(before);
        yield* Effect.sync(() => scenario.fixture.faultNextTransaction('rollback'));
        const evidenceRollback = yield* scenario.correct({ key: 'evidence-rollback' }).pipe(Effect.flip);
        assert(Schema.is(ActionTransactionError)(evidenceRollback));
        expect(evidenceRollback.code).toBe('action_transaction_failed');
        expect(evidenceRollback.reason).toBe('Controlled precommit rollback');
        expect(yield* scenario.observe()).toEqual(before);
        yield* scenario.correct({ key: 'lawful-after-rollback' });
        const after = yield* scenario.observe();
        expect(after.stockItems).toHaveLength(2);
        expect(after.bindingHistory).toHaveLength(1);
        expect(after.bindingHistory[0]?.transition).toBe('CORRECTED');
        expect(after.protections[0]?.currentHealthState).toBe('AT_RISK');
        expect(after.ledger).toEqual(before.ledger);
        expect(after.history).toEqual(before.history);
        const replay = yield* scenario.correct({ key: 'lawful-after-rollback' }).pipe(Effect.flip);
        expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
        expect(yield* scenario.observe()).toEqual(after);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

it.live('serializes concurrent same-source replacements into one Correction and one immutable history revision', () =>
  Effect.scoped(
    Effect.gen(function* concurrentReplacement() {
      const scenario = yield* makeScenario();
      yield* scenario.invoke('concurrent-replacement-establishment');
      const request = yield* scenario.originalRequest();
      yield* scenario.execute(request);
      yield* scenario.execute(request);
      const original = yield* scenario.observe();
      expect(original.ledger.map((record) => record.currentState)).toEqual(['SUCCEEDED']);
      expect(original.protections.map((record) => record.currentHealthState)).toEqual(['PROTECTED']);
      expect(original.protectionHistory.map((record) => record.revision)).toEqual([1]);
      const results = yield* Effect.all(
        [
          scenario.correct({ key: 'replace-a' }).pipe(Effect.exit),
          scenario.correct({ key: 'replace-b' }).pipe(Effect.exit),
        ],
        { concurrency: 2 },
      );
      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      const failures = results.filter(Exit.isFailure);
      expect(failures).toHaveLength(1);
      const [loser] = failures;
      assert(loser !== undefined);
      const rejected = Option.getOrUndefined(Cause.findErrorOption(loser.cause));
      assert(Schema.is(CatalogToStockBindingRejected)(rejected));
      expect(rejected.code).toBe('catalog_to_stock_binding_rejected');
      expect(rejected.reason).toBe('REVISION_CONFLICT');
      const observed = yield* scenario.observe();
      expect(observed.bindings).toHaveLength(1);
      expect(observed.bindings[0]?.bindingId).toBe(scenario.binding.bindingRef.resourceId);
      expect(observed.bindings[0]?.currentRevision).toBe(2);
      expect(observed.bindingHistory).toHaveLength(1);
      expect(observed.bindingHistory[0]?.transition).toBe('CORRECTED');
      expect(observed.stockItems.filter((row) => row.lifecycleState === 'CURRENT')).toHaveLength(1);
      expect(observed.stockItems.filter((row) => row.lifecycleState === 'RETIRED')).toHaveLength(1);
      expect(observed.protectionHistory.map((record) => record.revision)).toEqual([1, 2]);
      expect(observed.protections.map((record) => record.currentRevision)).toEqual([2]);
      expect(observed.protections.map((record) => record.currentHealthState)).toEqual(['AT_RISK']);
      expect(observed.ledger).toEqual(original.ledger);
      expect(observed.history).toEqual(original.history);
      expect(observed.obligations).toEqual(original.obligations);
      expect(observed.requirements).toEqual(original.requirements);
      expect(observed.allocations).toEqual(original.allocations);
      expect(yield* Ref.get(scenario.calls)).toBe(1);
      expect(yield* Ref.get(scenario.recoveryCalls)).toBe(0);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live(
  'keeps concurrent readers on a valid committed binding while atomic replacement has removed its Current tuple',
  () =>
    Effect.scoped(
      Effect.gen(function* atomicReplacementReaders() {
        const scenario = yield* makeScenario();
        const locked = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();
        const blocker = yield* scenario.admin
          .transaction((transaction) =>
            Effect.gen(function* holdItemTable() {
              // Native infrastructure barrier: SHARE permits SELECT FOR UPDATE but blocks the Item UPDATE.
              yield* transaction.execute(sql`lock table inventory.stock_items in share mode`, 'objects');
              yield* Deferred.succeed(locked, null);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        const correcting = yield* scenario.correct({ key: 'reader-barrier' }).pipe(Effect.forkScoped);
        let blocked = false;
        for (let observation = 0; observation < 1000 && !blocked; observation += 1) {
          const [state] = yield* scenario.admin.execute<{ readonly blocked: boolean }>(
            sql`select exists(
        select 1 from pg_locks where relation = 'inventory.stock_items'::regclass
          and mode = 'RowExclusiveLock' and not granted
      ) as blocked`,
            'objects',
          );
          blocked = state?.blocked;
        }
        expect(blocked).toBe(true);
        const duringBindings = yield* scenario.admin.select().from(inventoryCatalogToStockBindings);
        const duringItems = yield* scenario.admin.select().from(inventoryStockItems);
        const duringHistory = yield* scenario.admin.select().from(inventoryCatalogToStockBindingHistory);
        expect(duringBindings).toHaveLength(1);
        expect(duringBindings[0]?.stockItemId).toBe(scenario.item.stockItemRef.resourceId);
        expect(duringBindings[0]?.currentRevision).toBe(1);
        expect(duringItems.map((row) => row.lifecycleState)).toEqual(['CURRENT']);
        expect(duringHistory).toEqual([]);
        yield* Deferred.succeed(release, null);
        yield* Fiber.join(blocker);
        const corrected = yield* Fiber.join(correcting);
        const after = yield* scenario.observe();
        expect(after.bindings[0]?.stockItemId).toBe(corrected.stockItemRef.resourceId);
        expect(after.bindings[0]?.currentRevision).toBe(2);
        expect(after.stockItems.filter((row) => row.lifecycleState === 'CURRENT')).toHaveLength(1);
        expect(after.bindingHistory).toHaveLength(1);
      }),
    ).pipe(Effect.provide(nativeServices)),
);
