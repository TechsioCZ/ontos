import {
  OwnerAuthorizationOverlay,
  makeBusinessPermissionRelationshipMutationLive,
  runAction,
  ScopedRoutineInvocationError,
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
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Clock,
  Crypto,
  DateTime,
  Effect,
  FileSystem,
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
import type { AuthoritativeReservationEvidence } from '../../shared/domain/reservation-authority.ts';

import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import {
  CommitmentProtectionSchema,
  establishCommitmentProtection,
} from '../../shared/domain/commitment-protection.ts';
import type {
  CommitmentProtectionEffect,
  CommitmentProtectionEffectRequest,
} from '../../shared/domain/commitment-protection.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import { AuthoritativeSuccessInventoryEffectRecoveryObservationSchema } from '../../shared/domain/inventory-effect-recovery.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import { INVENTORY_TABLES, inventoryRelations } from '../../src/database/schema.ts';
import { makeDrizzleCatalogToStockBindingPersistence } from '../../src/persistence/catalog-to-stock-binding-repository.ts';
import { finalizeCommitmentProtectionForWorkerRoutine } from '../../src/persistence/commitment-protection-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import { inventoryEffectLedgerPersistenceForScope } from '../../src/persistence/inventory-effect-ledger-repository.ts';
import {
  inventoryEffectLedger,
  inventoryEffectLedgerHistory,
} from '../../src/persistence/inventory-effect-ledger-table.ts';
import { inventoryObligationPersistenceForScope } from '../../src/persistence/inventory-obligation-repository.ts';
import { reservationCreateEffectPersistenceForScope } from '../../src/persistence/reservation-create-effect-repository.ts';
import { reservationConfirmationPersistenceForScope } from '../../src/persistence/reservation-confirmation-repository.ts';
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

const recoverOriginal = Effect.fn('ProtectionIntentReplay.recoverOriginal')(function* recoverOriginal(
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
const executePrepared = Effect.fn('ProtectionIntentReplay.executePrepared')(function* executePrepared<
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
const finalizeOwnerExecution = Effect.fn('ProtectionIntentReplay.finalizeOwnerExecution')(
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

const makeScenario = Effect.fn('ProtectionIntentReplay.makeScenario')(function* makeScenario() {
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1237-protection-intent',
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
  const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-protection-intent-empty-' });
  const configurationPath = path.join(temporary, 'drizzle.config.mjs');
  yield* filesystem.writeFileString(
    configurationPath,
    `export default {
    dialect: 'postgresql',
    out: process.env.ONTOS_PROTECTION_INTENT_MIGRATIONS,
    schema: process.env.ONTOS_PROTECTION_INTENT_SCHEMA,
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
        ONTOS_PROTECTION_INTENT_MIGRATIONS: new URL('../../drizzle/', import.meta.url).pathname,
        ONTOS_PROTECTION_INTENT_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
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
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(['inventory'], 'protection-intent-native');
  yield* isolated.publishInitialComposition(snapshot);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionKeys: [establishCommitmentProtectionAction.descriptor.actionKey],
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
  // Test-owned exact Establish admission only; production Import-only authorization is unchanged.
  const ownerAuthorization = Layer.succeed(
    OwnerAuthorizationOverlay,
    transactionalOwnerAuthorization((transaction, input) =>
      input.operation === 'action' &&
      input.operationKey === establishCommitmentProtectionAction.descriptor.actionKey &&
      input.owningModuleKey === 'commerce.inventory' &&
      input.scope.tenantId === fixture.tenantId &&
      input.scope.legalEntityId === fixture.legalEntityId
        ? reservationConfirmationPersistenceForScope(transaction, input.scope)
            .findByRef(confirmation.ref)
            .pipe(
              Effect.match({
                onFailure: () => 'unavailable' as const,
                onSuccess: (found) => (Option.isSome(found) ? ('allowed' as const) : ('unavailable' as const)),
              }),
            )
        : Effect.succeed('unavailable' as const),
    ),
  );
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
  yield* permission.mutate({
    operation: 'grant',
    permission: 'inventory.commitment_protection.establish',
    principal,
    target: businessTarget,
  });
  yield* Effect.addFinalizer(() =>
    permission
      .mutate({
        operation: 'revoke',
        permission: 'inventory.commitment_protection.establish',
        principal,
        target: businessTarget,
      })
      .pipe(Effect.orDie),
  );
  yield* fixture.grantResourceAccess(protection.ref, fixture.manager.principalId, 'writer');
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
              history: transaction.select().from(inventoryEffectLedgerHistory),
              ledger: transaction.select().from(inventoryEffectLedger),
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
  const tamperOriginal = (request: CommitmentProtectionEffectRequest) =>
    fixture
      .prepareOwner(
        (transaction) =>
          Effect.gen(function* rejectChangedOriginalProvenance() {
            const [record] = yield* transaction.select().from(inventoryEffectLedger);
            assert(record !== undefined);
            const evidence = yield* evidenceFor(request);
            const established = yield* establishCommitmentProtection({
              authorityEvidence: evidence,
              confirmation: request.confirmation,
              protectionRef: request.protectionRef,
            });
            return yield* transaction.invoke(finalizeCommitmentProtectionForWorkerRoutine, [
              record.effectId,
              record.currentRevision,
              record.currentState,
              {
                _tag: 'PROTECTED',
                protection: established,
                request: { ...request, sourceActionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9' },
              },
            ]);
          }),
        'required',
      )
      .pipe(Effect.provide(layer));
  return {
    calls,
    clock,
    coreEvidenceExecutor,
    execute,
    fixture,
    invoke,
    layer,
    observe,
    originalRequest,
    payload,
    principal,
    tamperOriginal,
  };
});

it.live(
  'real Action factory replays committed pending intent under a new key and preserves same-key, race and rollback boundaries',
  () =>
    Effect.scoped(
      Effect.gen(function* pendingReplay() {
        const scenario = yield* makeScenario();
        const denied = yield* runAction({
          payload: scenario.payload,
          principal: { ...scenario.fixture.denied, legalEntityId: scenario.fixture.legalEntityId },
          registration: establishCommitmentProtectionAction,
          transport: { correlationId: 'protection-denied', idempotencyKey: 'denied' },
        }).pipe(Effect.provide(scenario.layer), Effect.flip);
        expect(Predicate.isTagged(denied, 'OperationContextDenied')).toBe(true);
        const missingResourcePermission = yield* runAction({
          payload: scenario.payload,
          principal: scenario.fixture.legalEntityOnly,
          registration: establishCommitmentProtectionAction,
          transport: { correlationId: 'protection-missing-resource', idempotencyKey: 'missing-resource' },
        }).pipe(Effect.provide(scenario.layer), Effect.flip);
        expect(Predicate.isTagged(missingResourcePermission, 'ActionPermissionDenied')).toBe(true);
        expect((yield* scenario.observe()).ledger).toEqual([]);
        expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toEqual([]);
        const first = yield* scenario.invoke('original');
        expect(Predicate.isTagged(first, 'PENDING')).toBe(true);
        const original = yield* scenario.observe();
        const request = yield* scenario.originalRequest();
        yield* scenario.clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(laterAt)));
        const replay = yield* scenario.invoke('new-authorized-key');
        expect(Predicate.isTagged(replay, 'PENDING')).toBe(true);
        expect(replay.replayed).toBe(true);
        expect(yield* scenario.observe()).toEqual(original);
        expect(Predicate.isTagged(yield* scenario.invoke('original').pipe(Effect.flip), 'ActionAlreadyCommitted')).toBe(
          true,
        );
        const races = yield* Effect.all([scenario.invoke('race-a'), scenario.invoke('race-b')], { concurrency: 2 });
        expect(races.every((result) => result.replayed)).toBe(true);
        expect(yield* scenario.originalRequest()).toEqual(request);
        const evidence = yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor);
        expect(evidence.outbox.filter((message) => message.topic === topic)).toHaveLength(1);
        expect(evidence.invocations.filter((invocation) => invocation.status === 'succeeded')).toHaveLength(4);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

it.live('indeterminate and successful original effects survive fresh invocation and expiry without redispatch', () =>
  Effect.scoped(
    Effect.gen(function* terminalReplay() {
      const scenario = yield* makeScenario();
      yield* scenario.invoke('original');
      const request = yield* scenario.originalRequest();
      yield* scenario.execute(request);
      const indeterminate = yield* scenario.observe();
      expect(indeterminate.ledger).toMatchObject([{ currentState: 'INDETERMINATE' }]);
      const invalidResolution = yield* scenario.tamperOriginal(request).pipe(Effect.flip);
      assert(Schema.is(ScopedRoutineInvocationError)(invalidResolution));
      expect(invalidResolution.code).toBe('scoped_routine_invocation_failed');
      expect(invalidResolution.ownerModuleKey).toBe('commerce.inventory');
      expect(invalidResolution.routineKey).toBe('inventory.finalize-commitment-protection-for-worker');
      expect(invalidResolution.postgresCode).toEqual(Option.some('23514'));
      expect(invalidResolution.constraint).toEqual(
        Option.some('inventory_commitment_protection_worker_finalization_ck'),
      );
      expect(yield* scenario.observe()).toEqual(indeterminate);
      yield* scenario.clock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(laterAt)));
      const uncertainReplay = yield* scenario.invoke('uncertain-replay');
      expect(Predicate.isTagged(uncertainReplay, 'INDETERMINATE')).toBe(true);
      expect(uncertainReplay.replayed).toBe(true);
      expect(yield* scenario.observe()).toEqual(indeterminate);
      yield* scenario.execute(request);
      const succeeded = yield* scenario.observe();
      expect(succeeded.ledger).toMatchObject([{ currentState: 'SUCCEEDED' }]);
      const protectedReplay = yield* scenario.invoke('terminal-replay');
      expect(Predicate.isTagged(protectedReplay, 'PROTECTED')).toBe(true);
      expect(protectedReplay.replayed).toBe(true);
      expect(yield* scenario.observe()).toEqual(succeeded);
      expect(yield* scenario.calls.pipe(Ref.get)).toBe(1);
      expect(
        (yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox.filter(
          (message) => message.topic === topic,
        ),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('a definitely rolled back first Action does not become an original committed effect', () =>
  Effect.scoped(
    Effect.gen(function* rollbackFirstProtection() {
      const scenario = yield* makeScenario();
      scenario.fixture.faultNextTransaction('rollback');
      const failure = yield* scenario.invoke('rolled-back-first').pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'ActionTransactionError')).toBe(true);
      expect((yield* scenario.observe()).ledger).toEqual([]);
      expect((yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox).toEqual([]);
      const committed = yield* scenario.invoke('first-real-commit');
      expect(Predicate.isTagged(committed, 'PENDING')).toBe(true);
      expect(committed.replayed).toBe(false);
      expect(
        (yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox.filter(
          (message) => message.topic === topic,
        ),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(nativeServices)),
);

it.live('two concurrent genuine first Actions commit one original effect and dispatch', () =>
  Effect.scoped(
    Effect.gen(function* concurrentFirstProtection() {
      const scenario = yield* makeScenario();
      const results = yield* Effect.all([scenario.invoke('first-a'), scenario.invoke('first-b')], { concurrency: 2 });
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect(results.every((result) => Predicate.isTagged(result, 'PENDING'))).toBe(true);
      const stored = yield* scenario.observe();
      expect(stored.ledger).toHaveLength(1);
      expect(stored.history).toHaveLength(1);
      expect(
        (yield* scenario.fixture.evidence(scenario.coreEvidenceExecutor)).outbox.filter(
          (message) => message.topic === topic,
        ),
      ).toHaveLength(1);
    }),
  ).pipe(Effect.provide(nativeServices)),
);
