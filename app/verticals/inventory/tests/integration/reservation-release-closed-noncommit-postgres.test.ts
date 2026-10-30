import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { ScopedRoutineInvocationError, findPostgresFailure } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { NativeReadTestContextOptions } from '@app/core-runtime/testing/native-reads';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { ChildProcess } from 'effect/process';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { and, eq, sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { CatalogToStockBindingSchema } from '../../shared/domain/catalog-to-stock-binding.ts';
import { CommitmentProtectionSchema } from '../../shared/domain/commitment-protection.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { ProvisionalInventoryReservation } from '../../shared/domain/inventory-obligation.ts';
import type { InventoryBackendConfiguration } from '../../shared/domain/inventory-backend-configuration.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  InventoryReservationReleaseRejected,
  ReleasedReservationEffectSchema,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseMutationIdSchema,
  ReservationReleaseBackendObservationSchema,
  ReservationReleaseProtectionAbsentTruthSchema,
  ReservationReleaseRequestSchema,
  RequestedReleaseEffectSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type {
  ReservationReleaseOrderTruth,
  ReservationReleaseProtectionTruth,
  ReservationReleaseRequest,
} from '../../shared/domain/inventory-reservation-release.ts';
import { ReservationConfirmationSchema } from '../../shared/domain/reservation-confirmation.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { StockLocationSchema } from '../../shared/domain/stock-location.ts';
import { StockPositionSchema } from '../../shared/domain/stock-position.ts';
import { INVENTORY_TABLES, inventoryRelations } from '../../src/database/schema.ts';
import { makeDrizzleCatalogToStockBindingPersistence } from '../../src/persistence/catalog-to-stock-binding-repository.ts';
import { commitmentProtectionPersistenceForScope } from '../../src/persistence/commitment-protection-repository.ts';
import { currentStockEvidenceForAvailabilityDependenciesForScope } from '../../src/persistence/current-stock-evidence-for-availability-repository.ts';
import { inventoryBackendConfigurationPersistenceForScope } from '../../src/persistence/inventory-backend-configuration-repository.ts';
import {
  inventoryEffectLedgerPersistenceForScope,
  inventoryEffectLedgerPersistenceForWorkerScope,
} from '../../src/persistence/inventory-effect-ledger-repository.ts';
import { inventoryEffectLedger } from '../../src/persistence/inventory-effect-ledger-table.ts';
import { inventoryObligationPersistenceForScope } from '../../src/persistence/inventory-obligation-repository.ts';
import {
  finalizeReservationReleaseEffectForWorkerRoutine,
  reservationReleaseEffectPersistenceForScope,
  reservationReleaseEffectPersistenceForWorkerScope,
} from '../../src/persistence/reservation-release-effect-repository.ts';
import {
  inventoryReservationReleaseEffectHistory,
  inventoryReservationReleaseEffects,
} from '../../src/persistence/reservation-release-effect-table.ts';
import { reservationCreateEffectPersistenceForScope } from '../../src/persistence/reservation-create-effect-repository.ts';
import { reservationConfirmationPersistenceForScope } from '../../src/persistence/reservation-confirmation-repository.ts';
import { makeDrizzleStockItemRepository } from '../../src/persistence/stock-item-repository.ts';
import { stockLocationPersistenceForScope } from '../../src/persistence/stock-location-repository.ts';
import { stockPositionPersistenceForScope } from '../../src/persistence/stock-position-repository.ts';
import { makeInventoryEffectLedgerService } from '../../src/services/inventory-effect-ledger.service.ts';
import {
  makeInventoryReservationReleaseExecutionService,
  makeInventoryReservationReleaseService,
  reservationReleaseUnavailable,
} from '../../src/services/inventory-reservation-release.service.ts';
import {
  buildInventoryOwnerAcceptanceBindingCorrectionLineage,
  inventoryOwnerAcceptanceBindingCorrectionFixture,
} from '../support/inventory-owner-acceptance-binding-correction.ts';

const instant = '2026-09-25T13:00:00.000Z';
const closed: ReservationReleaseOrderTruth = {
  _tag: 'NOT_COMMITTED_CLOSED',
  closureEvidenceRef: 'order-owner:attempt-closed-no-future-commit',
  nonCommitEvidenceRef: 'order-owner:authoritative-noncommit',
  observedAt: instant,
};

const fixtureUuidPattern = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gu;

// Native owner keys are global UUIDs; remap the complete synthetic lineage, never delete retained history.
const forTenant = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: S['Type'],
  identities: ReadonlyMap<string, string>,
) =>
  Schema.decodeUnknownEffect(schema)(
    JSON.parse(JSON.stringify(value).replace(fixtureUuidPattern, (source) => identities.get(source) ?? source)),
  );

interface ExecutionOptions {
  readonly backend?: 'COMMITTED' | 'INDETERMINATE' | 'WRONG_ISSUER' | 'WRONG_SCOPE' | 'WRONG_EFFECT';
  readonly order?: ReservationReleaseOrderTruth;
  readonly protection?: ReservationReleaseProtectionTruth;
  readonly rollback?: true;
}

const originalBackendFixture = (
  reservation: ProvisionalInventoryReservation,
  authority: InventoryBackendConfiguration,
  calls: Ref.Ref<readonly ReservationReleaseRequest[]>,
  released: Ref.Ref<boolean>,
  mode: ExecutionOptions['backend'],
) => ({
  release: Effect.fn('OriginalAuthorityFixture.release')(function* release(retained: ReservationReleaseRequest) {
    yield* Ref.update(calls, (previous) => [...previous, retained]);
    if (mode === 'COMMITTED') {
      return {
        _tag: 'COMMITTED' as const,
        effectId: retained.effectId,
        evidenceRef: 'original-backend:committed',
        observedAt: instant,
      };
    }
    if (mode === 'INDETERMINATE') {
      return {
        _tag: 'INDETERMINATE' as const,
        effectId: retained.effectId,
        observedAt: instant,
        reason: 'AUTHORITY_OUTCOME_UNKNOWN' as const,
      };
    }
    const already = yield* Ref.getAndSet(released, true);
    return yield* Schema.decodeUnknownEffect(ReservationReleaseBackendObservationSchema)({
      _tag: already ? 'ALREADY_RELEASED' : 'RELEASED',
      effectId: mode === 'WRONG_EFFECT' ? 'other-effect' : retained.effectId,
      issuer: {
        backend: authority.selection.backend,
        backendId: mode === 'WRONG_ISSUER' ? 'replacement' : authority.selection.backendId,
        origin: 'ONTOS_WMS',
      },
      ownerEvidenceRef: 'original-backend:whole-release-receipt',
      releasedAt: instant,
      scope: {
        allocations: reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ allocationId, positionRef: stockPositionRef, quantity, stockItemRef }) => ({
            allocationId,
            quantity,
            stockItemRef,
            stockPositionRef,
          })),
        ),
        attemptId: reservation.origin.attemptId,
        reservationId: mode === 'WRONG_SCOPE' ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' : reservation.ref.resourceId,
        tenantId: reservation.ref.tenantId,
      },
    }).pipe(Effect.orDie);
  }),
});

const makeScenario = Effect.fn('ClosedNoncommitRelease.makeScenario')(function* makeScenario(
  protectionPresent: boolean,
  connections?: NativeReadTestContextOptions['connections'],
) {
  let configuration: NativeReadTestContextOptions = {
    contextPermissions: ['module.access'],
    moduleId: 'commerce.inventory',
    ownerFixtureRetention: 'retain-complete-context',
  };
  if (connections !== undefined) {
    configuration = { ...configuration, connections };
  }
  const fixture = yield* makeNativeReadTestContext(configuration);
  const { tenantId } = fixture.principal;
  const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
  const crypto = yield* Crypto.Crypto;
  const originalIds = [
    ...new Set(
      JSON.stringify({
        fixture: inventoryOwnerAcceptanceBindingCorrectionFixture,
        lineage,
        locationId: '66666666-6666-4666-8666-666666666666',
      }).match(fixtureUuidPattern),
    ),
  ];
  const identities = new Map([
    ...(yield* Effect.forEach(
      originalIds,
      (source) => crypto.randomUUIDv4().pipe(Effect.map((target) => [source, target] as const)),
      { concurrency: 1 },
    )),
    ['11111111-1111-4111-8111-111111111111', tenantId],
  ]);
  const locationId = identities.get('66666666-6666-4666-8666-666666666666');
  assert(locationId !== undefined);

  const reservation = yield* forTenant(ProvisionalInventoryReservationSchema, lineage.reservation, identities);
  const confirmation = yield* forTenant(ReservationConfirmationSchema, lineage.confirmation, identities);
  const protection = yield* forTenant(CommitmentProtectionSchema, lineage.protection, identities);
  const authority = yield* forTenant(
    InventoryBackendConfigurationSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.authority,
    identities,
  );
  const binding = yield* forTenant(
    CatalogToStockBindingSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.originalBinding,
    identities,
  );
  const item = yield* forTenant(
    StockItemSchema,
    inventoryOwnerAcceptanceBindingCorrectionFixture.originalStockItem,
    identities,
  );
  const [requirement] = reservation.requirements;
  const [allocation] = requirement?.allocations ?? [];
  assert(requirement !== undefined && allocation !== undefined);
  const { positionRef } = allocation;
  const configurationRef = {
    moduleId: 'commerce.inventory',
    resourceId: authority.configurationId,
    resourceType: 'commerce.inventory.inventory-backend-configuration',
    tenantId,
  } as const;
  const locationRef = {
    moduleId: 'commerce.inventory',
    resourceId: locationId,
    resourceType: 'commerce.inventory.stock-location',
    tenantId,
  } as const;
  yield* fixture
    .prepareOwner((transaction, scope) =>
      Effect.gen(function* produceOriginalOwnerLineage() {
        yield* inventoryBackendConfigurationPersistenceForScope(transaction, scope).insertInitial(authority);
        yield* makeDrizzleStockItemRepository(transaction).insert(item);
        yield* stockLocationPersistenceForScope(transaction, scope).create(
          yield* Schema.decodeUnknownEffect(StockLocationSchema)({
            displayName: 'Closed noncommit release native fixture',
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
              ownerConfigurationRef: configurationRef,
              unitRef: item.unitRef,
            },
            ref: positionRef,
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
              tenantId,
            },
            customerConfigurationId: authority.customerConfigurationId,
            evidenceRef: 'commerce-owner:native-release-context',
            observedAt: authority.selectedAt,
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: scope.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            status: 'CURRENT_OWNER_VERIFIED',
            storefrontRef: { appId: 'storefront-primary', tenantId },
            tenantId,
          },
          effectId: 'create:closed-noncommit-native',
          legalEntityId: scope.legalEntityId,
          mutationId: '88888888-8888-4888-8888-888888888888',
          requestedAt: reservation.establishedAt,
          reservation: { origin: reservation.origin, ref: reservation.ref, requirements: reservation.requirements },
          sourceActionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        });
        const createEffects = reservationCreateEffectPersistenceForScope(transaction, scope);
        const created = yield* createEffects.createOrRead(createRequest);
        yield* inventoryObligationPersistenceForScope(transaction, scope).establishReservation(reservation);
        yield* createEffects.save(
          created.effect,
          yield* Schema.decodeUnknownEffect(EstablishedReservationCreateEffectSchema)({
            _tag: 'ESTABLISHED',
            ownerEvidenceRef: 'original-backend:reservation-established',
            request: createRequest,
            reservation,
          }),
        );
        yield* reservationConfirmationPersistenceForScope(transaction, scope).createOrRead(confirmation);
        if (protectionPresent) {
          yield* commitmentProtectionPersistenceForScope(transaction, scope).createOrRead(protection);
        }
      }),
    )
    .pipe(Effect.provide(fixture.layer));
  const payload = {
    attemptId: reservation.origin.attemptId,
    releaseEffectId: ReservationReleaseEffectIdSchema.make('release:closed-noncommit-native'),
    reservationRef: reservation.ref,
    scope: { _tag: 'WHOLE_RESERVATION' },
  } as const;
  const established: ReservationReleaseProtectionTruth = {
    _tag: 'ESTABLISHED',
    establishedAt: protection.establishedAt,
    evidenceRef: protection.authorityEvidence.evidence.ownerEvidenceRef,
    observedAt: instant,
  };
  const calls = yield* Ref.make<readonly ReservationReleaseRequest[]>([]);
  const released = yield* Ref.make(false);
  const ownerReadUnavailable = () => reservationReleaseUnavailable(payload.releaseEffectId, 'Owner read failed');
  const request = () =>
    fixture
      .prepareOwner((transaction, scope) => {
        assert(scope.legalEntityId !== undefined);
        const obligations = inventoryObligationPersistenceForScope(transaction, scope);
        return makeInventoryReservationReleaseService({
          effects: reservationReleaseEffectPersistenceForScope(transaction, scope),
          ledger: makeInventoryEffectLedgerService(
            inventoryEffectLedgerPersistenceForScope(transaction, scope),
            Effect.succeed(instant),
          ),
          makeMutationId: Effect.succeed(
            ReservationReleaseMutationIdSchema.make('99999999-9999-4999-8999-999999999999'),
          ),
          obligations: {
            read: (ref) => obligations.read(ref).pipe(Effect.mapError(ownerReadUnavailable)),
          },
        }).request(payload, {
          actionInvocationId: ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
          legalEntityId: LegalEntityIdSchema.make(scope.legalEntityId),
          requestedAt: instant,
          tenantId,
        });
      })
      .pipe(Effect.provide(fixture.layer));
  const execute = (original: ReservationReleaseRequest, options?: ExecutionOptions) =>
    fixture
      .prepareOwner((transaction, scope) => {
        assert(scope.legalEntityId !== undefined);
        const workerScope = {
          completionPublisher: {
            publish: () => Effect.die(new Error('Completion is verified by the existing worker unit control')),
          },
          legalEntityId: scope.legalEntityId,
          routineInvoker: transaction,
          tenantId,
        };
        return makeInventoryReservationReleaseExecutionService({
          backend: originalBackendFixture(reservation, authority, calls, released, options?.backend),
          effects: reservationReleaseEffectPersistenceForWorkerScope(workerScope),
          ledger: makeInventoryEffectLedgerService(
            inventoryEffectLedgerPersistenceForWorkerScope(workerScope),
            Effect.succeed(instant),
          ),
          orderTruth: { read: () => Effect.succeed(options?.order ?? closed) },
          protectionTruth: { read: () => Effect.succeed(options?.protection ?? established) },
        })
          .execute({ legalEntityId: scope.legalEntityId, tenantId }, original)
          .pipe(Effect.andThen(options?.rollback ? Effect.fail('controlled-owner-rollback') : Effect.void));
      })
      .pipe(Effect.provide(fixture.layer));
  const observe = () =>
    fixture
      .prepareOwner((transaction: ScopedTransactionExecutor, scope: OperationalScope) =>
        Effect.gen(function* observeCommittedRelease() {
          const effect = yield* reservationReleaseEffectPersistenceForScope(transaction, scope).read(
            payload.releaseEffectId,
          );
          const history = yield* transaction
            .select()
            .from(inventoryReservationReleaseEffectHistory)
            .where(
              and(
                eq(inventoryReservationReleaseEffectHistory.tenantId, tenantId),
                eq(inventoryReservationReleaseEffectHistory.releaseEffectId, payload.releaseEffectId),
              ),
            );
          const ledger = yield* transaction
            .select()
            .from(inventoryEffectLedger)
            .where(eq(inventoryEffectLedger.tenantId, tenantId));
          const allocations = yield* currentStockEvidenceForAvailabilityDependenciesForScope(
            transaction,
            scope,
          ).listCurrentSuccessfulAllocations(positionRef);
          const retainedProtection = yield* commitmentProtectionPersistenceForScope(
            transaction,
            scope,
          ).findByReservationAttempt(reservation.ref.resourceId, reservation.origin.attemptId);
          return {
            allocations,
            effect: Option.getOrUndefined(effect),
            history,
            ledger,
            protection: Option.getOrUndefined(retainedProtection),
          };
        }),
      )
      .pipe(Effect.provide(fixture.layer));
  return { calls, established, execute, fixture, observe, payload, protection, request, reservation };
});

it.live(
  'closed noncommit releases the original whole Reservation with truthful historical Protection, native routines and availability proof',
  () =>
    Effect.gen(function* nativeClosedNoncommit() {
      const scenario = yield* makeScenario(true);
      const requested = yield* scenario.request();
      const original = requested.result.effect.request;
      const before = yield* scenario.observe();
      expect(before.allocations).toHaveLength(1);
      yield* Effect.all([scenario.execute(original), scenario.execute(original)], { concurrency: 2 });
      const committed = yield* scenario.observe();
      const effect = yield* Schema.decodeUnknownEffect(ReleasedReservationEffectSchema)(committed.effect);
      expect(effect.safeReleaseProof).toEqual({ order: closed, protection: scenario.established });
      expect(committed.allocations).toEqual([]);
      expect(committed.ledger).toMatchObject([{ currentState: 'SUCCEEDED' }]);
      expect(committed.history).toHaveLength(2);
      expect(committed.protection).toEqual(before.protection);
      expect(yield* Ref.get(scenario.calls)).toEqual([original]);
      expect((yield* scenario.request()).result.outcome).toBe('ALREADY_RELEASED');
      yield* scenario.execute(original);
      expect(yield* scenario.observe()).toEqual(committed);

      const rollback = yield* makeScenario(true);
      const pending = (yield* rollback.request()).result.effect.request;
      const pendingState = yield* rollback.observe();
      expect(yield* rollback.execute(pending, { rollback: true }).pipe(Effect.flip)).toBe('controlled-owner-rollback');
      expect(yield* rollback.observe()).toEqual(pendingState);
      yield* rollback.execute(pending);
      expect(
        yield* Schema.decodeUnknownEffect(ReleasedReservationEffectSchema)((yield* rollback.observe()).effect),
      ).toMatchObject({
        releaseOutcome: 'ALREADY_RELEASED',
        safelyReusable: true,
      });
      expect((yield* Ref.get(rollback.calls)).map(({ effectId }) => effectId)).toEqual([
        pending.effectId,
        pending.effectId,
      ]);

      const absent = yield* makeScenario(false);
      yield* absent.execute((yield* absent.request()).result.effect.request, {
        protection: { _tag: 'ABSENT_PROVEN', evidenceRef: 'protection-owner:absent', observedAt: instant },
      });
      const absentEffect = yield* Schema.decodeUnknownEffect(ReleasedReservationEffectSchema)(
        (yield* absent.observe()).effect,
      );
      expect(Schema.is(ReservationReleaseProtectionAbsentTruthSchema)(absentEffect.safeReleaseProof.protection)).toBe(
        true,
      );
      expect(absentEffect.safeReleaseProof.protection).toMatchObject({
        evidenceRef: 'protection-owner:absent',
        observedAt: instant,
      });

      const unresolved = yield* makeScenario(true);
      const unresolvedRequest = (yield* unresolved.request()).result.effect.request;
      yield* unresolved.execute(unresolvedRequest, {
        order: { _tag: 'NOT_COMMITTED_OPEN', evidenceRef: 'order-owner:still-open', observedAt: instant },
      });
      expect((yield* unresolved.observe()).allocations).toHaveLength(1);
      expect(yield* Ref.get(unresolved.calls)).toHaveLength(0);
      yield* unresolved.execute(unresolvedRequest, {
        order: { _tag: 'INDETERMINATE', observedAt: instant, reason: 'ORDER_EVIDENCE_UNAVAILABLE' },
      });
      yield* unresolved.execute(unresolvedRequest, {
        protection: { _tag: 'INDETERMINATE', observedAt: instant, reason: 'PROTECTION_EVIDENCE_UNAVAILABLE' },
      });
      expect(yield* Ref.get(unresolved.calls)).toHaveLength(0);
      yield* unresolved.execute(unresolvedRequest, { backend: 'INDETERMINATE' });
      expect((yield* unresolved.observe()).effect).toMatchObject({ safelyReusable: false });
      yield* unresolved.execute(unresolvedRequest, { backend: 'COMMITTED' });
      const committedFence = yield* unresolved.observe();
      expect(committedFence.allocations).toHaveLength(1);
      expect(committedFence.ledger).toMatchObject([{ currentState: 'REJECTED' }]);
      yield* unresolved.execute(unresolvedRequest);
      expect(yield* unresolved.observe()).toEqual(committedFence);
      expect(yield* Ref.get(unresolved.calls)).toHaveLength(2);

      const malformed = yield* makeScenario(true);
      const malformedRequest = (yield* malformed.request()).result.effect.request;
      const beforeMalformed = yield* malformed.observe();
      const invalidProof = yield* malformed.fixture
        .prepareOwner((transaction) =>
          transaction.invoke(finalizeReservationReleaseEffectForWorkerRoutine, [
            malformedRequest.effectId,
            1,
            {
              ...effect,
              request: malformedRequest,
              safeReleaseProof: { order: closed, protection: { ...malformed.established, establishedAt: null } },
            },
          ]),
        )
        .pipe(Effect.provide(malformed.fixture.layer), Effect.flip);
      assert(Schema.is(ScopedRoutineInvocationError)(invalidProof));
      expect(invalidProof.postgresCode).toEqual(Option.some('23514'));
      expect(yield* malformed.observe()).toEqual(beforeMalformed);
      const foreign = yield* forTenant(
        ReservationReleaseRequestSchema,
        malformedRequest,
        new Map([[malformedRequest.reservation.ref.tenantId, scenario.reservation.ref.tenantId]]),
      );
      const foreignFailure = yield* malformed.execute(foreign).pipe(Effect.flip);
      expect(Schema.is(InventoryReservationReleaseRejected)(foreignFailure)).toBe(true);
      expect(foreignFailure).toMatchObject({ reason: 'TENANT_SCOPE_MISMATCH' });
      expect(yield* malformed.observe()).toEqual(beforeMalformed);

      const hidden = yield* malformed.fixture
        .prepareOwner((transaction) =>
          transaction
            .select({ effectId: inventoryReservationReleaseEffects.releaseEffectId })
            .from(inventoryReservationReleaseEffects)
            .where(eq(inventoryReservationReleaseEffects.tenantId, scenario.reservation.ref.tenantId)),
        )
        .pipe(Effect.provide(malformed.fixture.layer));
      expect(hidden).toEqual([]);
      const requestedSnapshot = yield* Schema.decodeUnknownEffect(RequestedReleaseEffectSchema)(beforeMalformed.effect);
      const historical = yield* malformed.fixture
        .prepareOwner((transaction, scope) =>
          reservationReleaseEffectPersistenceForScope(transaction, scope).save(requestedSnapshot, {
            _tag: 'NOT_RELEASABLE',
            evidenceRef: 'historical-protection:terminal-refusal',
            observedAt: instant,
            reason: 'PROTECTION_ESTABLISHED',
            request: malformedRequest,
            revision: 2,
            safelyReusable: false,
          }),
        )
        .pipe(Effect.provide(malformed.fixture.layer));
      yield* malformed.execute(malformedRequest);
      const historicalState = yield* malformed.observe();
      expect(historicalState.effect).toEqual(historical);
      expect(historicalState.ledger).toMatchObject([{ currentState: 'REJECTED' }]);
      expect(yield* Ref.get(malformed.calls)).toHaveLength(0);
      const forbiddenRewrite = yield* malformed.fixture
        .prepareOwner((transaction, scope) =>
          reservationReleaseEffectPersistenceForScope(transaction, scope).save(historical, {
            ...effect,
            request: malformedRequest,
            revision: 3,
          }),
        )
        .pipe(Effect.provide(malformed.fixture.layer), Effect.flip);
      expect(Option.isSome(findPostgresFailure(forbiddenRewrite, ({ code }) => code === '23514'))).toBe(true);
      yield* malformed.execute(malformedRequest);
      expect(yield* malformed.observe()).toEqual(historicalState);

      yield* Effect.forEach(
        ['WRONG_ISSUER', 'WRONG_SCOPE', 'WRONG_EFFECT'] as const,
        (backend) =>
          Effect.gen(function* rejectWrongReceipt() {
            const wrong = yield* makeScenario(true);
            const originalRequest = (yield* wrong.request()).result.effect.request;
            const beforeWrong = yield* wrong.observe();
            const failure = yield* wrong.execute(originalRequest, { backend }).pipe(Effect.flip);
            expect(Schema.is(InventoryReservationReleaseRejected)(failure)).toBe(true);
            expect(failure).toMatchObject({ reason: 'INVALID_BACKEND_OBSERVATION' });
            expect(yield* wrong.observe()).toEqual(beforeWrong);
          }),
        { concurrency: 1 },
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
);

const freshNativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.live(
  'migrates the immutable full Inventory journal twice on a genuinely empty owned database and enforces Release proof',
  () =>
    Effect.scoped(
      Effect.gen(function* freshInventoryMigration() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'stabilization-1235-inventory-release',
        });
        expect(isolated.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
        expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
        expect(isolated.connections.admin.user).not.toBe(isolated.connections.runtime.user);
        yield* isolated.migrateCoreSchema();
        const client = PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        );
        const databaseServices = yield* Layer.build(client);
        const admin = yield* makeWithDefaults({ relations: inventoryRelations }).pipe(Effect.provide(databaseServices));
        const [before] = yield* admin.execute<{ readonly absent: boolean; readonly database: string }>(
          sql`select current_database() as database, to_regclass('inventory.reservation_release_effects') is null as absent`,
          'objects',
        );
        expect(before).toEqual({ absent: true, database: isolated.connections.admin.database });
        const filesystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* filesystem.makeTempDirectoryScoped({ prefix: 'ontos-inventory-release-empty-' });
        const configurationPath = path.join(temporary, 'drizzle.config.mjs');
        yield* filesystem.writeFileString(
          configurationPath,
          `export default {
      dialect: 'postgresql',
      out: process.env.ONTOS_INVENTORY_RELEASE_MIGRATIONS,
      schema: process.env.ONTOS_INVENTORY_RELEASE_SCHEMA,
      dbCredentials: { url: process.env.DATABASE_ADMIN_URL },
      migrations: { schema: 'drizzle', table: '__drizzle_migrations_inventory' }
    };`,
        );
        const ownerHistory = new URL('../../drizzle/', import.meta.url).pathname;
        const runInventoryCli = Effect.fn('InventoryFreshRelease.runCli')(function* runInventoryCli(
          cliArguments: readonly string[],
        ) {
          const process = yield* ChildProcess.make(
            'mise',
            ['exec', '--', 'pnpm', '--filter', '@app/inventory', 'exec', ...cliArguments],
            {
              cwd: new URL('../../../../', import.meta.url).pathname,
              env: {
                DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
                DATABASE_URL: isolated.connections.runtime.connectionString,
                ONTOS_INVENTORY_RELEASE_MIGRATIONS: ownerHistory,
                ONTOS_INVENTORY_RELEASE_SCHEMA: new URL('../../src/database/schema.ts', import.meta.url).pathname,
              },
              extendEnv: true,
              stderr: 'pipe',
              stdin: 'ignore',
              stdout: 'pipe',
            },
          );
          // CLI diagnostics can contain database URLs. Drain both pipes and assert status without printing credentials.
          const [status] = yield* Effect.all(
            [process.exitCode, Stream.runDrain(process.stdout), Stream.runDrain(process.stderr)],
            { concurrency: 3 },
          );
          expect(Number(status)).toBe(0);
        });
        yield* runInventoryCli(['drizzle-kit', 'migrate', '--config', configurationPath]);
        const journalRowSchema = Schema.Struct({
          appliedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
          hash: Schema.String,
          id: Schema.BigIntFromString,
          migrationTimestamp: Schema.BigIntFromString,
          name: Schema.String,
          nativeSnapshot: Schema.String,
        });
        const readJournal = () =>
          admin
            .execute<typeof journalRowSchema.Encoded>(
              sql`select to_char(applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "appliedAt", created_at::text as "migrationTimestamp", hash, id::text as id, name, row_to_json(journal)::text as "nativeSnapshot" from drizzle.__drizzle_migrations_inventory as journal order by name`,
              'objects',
            )
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(journalRowSchema))));
        const firstJournal = yield* readJournal();
        const historyFolders = EffectArray.sort(
          (yield* filesystem.readDirectory(ownerHistory)).filter((folder) => /^\d{14}_/u.test(folder)),
          Order.String,
        );
        expect(firstJournal.map(({ name }) => name)).toEqual(historyFolders);
        yield* runInventoryCli(['drizzle-kit', 'migrate', '--config', configurationPath]);
        expect(yield* readJournal()).toEqual(firstJournal);
        // Reproduce the ordinary Inventory runtime provisioning contract only inside this owned database.
        // The exact owner verifier checks forced RLS, private trigger denial, routine grants and no CREATE/BYPASSRLS.
        const runtimeRole = sql.identifier(isolated.connections.runtime.user);
        yield* admin.execute(sql`grant usage on schema inventory to ${runtimeRole}`, 'objects');
        yield* Effect.forEach(
          INVENTORY_TABLES,
          (table) =>
            admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects'),
          { concurrency: 1 },
        );
        yield* admin.execute(sql`grant usage,select on all sequences in schema inventory to ${runtimeRole}`, 'objects');
        yield* runInventoryCli(['node', 'scripts/verify-db-schema.mts']);
        const scenario = yield* makeScenario(true, {
          admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
          runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
        });
        const { request } = (yield* scenario.request()).result.effect;
        expect((yield* scenario.observe()).allocations).toHaveLength(1);
        yield* scenario.execute(request);
        const observed = yield* scenario.observe();
        const effect = yield* Schema.decodeUnknownEffect(ReleasedReservationEffectSchema)(observed.effect);
        expect(effect.safeReleaseProof).toEqual({ order: closed, protection: scenario.established });
        expect(observed.allocations).toEqual([]);
        expect(observed.ledger).toMatchObject([{ currentState: 'SUCCEEDED' }]);
        expect((yield* scenario.request()).result.outcome).toBe('ALREADY_RELEASED');
        expect(yield* scenario.observe()).toEqual(observed);
        expect(yield* readJournal()).toEqual(firstJournal);
      }),
    ).pipe(Effect.provide(freshNativeServices)),
);
