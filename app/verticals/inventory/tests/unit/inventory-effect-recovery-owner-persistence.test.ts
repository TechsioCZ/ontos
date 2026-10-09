/* oxlint-disable sonarjs/no-nested-functions -- Focused in-memory owner ports keep the cross-store recovery invariants explicit; expires: 2027-03-31. */
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Ref, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CommitmentProtection,
  CommitmentProtectionPersistence,
} from '../../shared/domain/commitment-protection.ts';
import {
  CommitmentProtectionEffectRequestSchema,
  CommitmentProtectionSchema,
  establishCommitmentProtection,
} from '../../shared/domain/commitment-protection.ts';
import type {
  InventoryEffectLedgerIntent,
  InventoryEffectLedgerRecord,
  InventoryEffectLedgerResolution,
} from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryEffectLedgerEffectIdSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import {
  AlreadyTerminalInventoryEffectResultSchema,
  InventoryEffectRecoveryRejected,
  RecoveredInventoryEffectResultSchema,
} from '../../shared/domain/inventory-effect-recovery.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import type { InventoryObligation } from '../../shared/domain/inventory-obligation.ts';
import {
  ProvisionalInventoryReservationSchema,
  RuntimeCommittedInventoryObligationSchema,
} from '../../shared/domain/inventory-obligation.ts';
import type { PhysicalStockEffectRecord } from '../../shared/domain/physical-stock-effect.ts';
import {
  AppliedPhysicalStockEffectSchema,
  PhysicalStockEffectIdSchema,
  PhysicalStockEffectRecordSchema,
  PhysicalStockEffectRequestSchema,
  PhysicalStockEffectUnavailable,
  RequestedPhysicalStockEffectSchema,
} from '../../shared/domain/physical-stock-effect.ts';
import type { ReservationCreateEffect } from '../../shared/domain/inventory-reservation-create.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateMutationIdSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationReleaseEffect } from '../../shared/domain/inventory-reservation-release.ts';
import {
  ReleasedReservationEffectSchema,
  ReservationReleaseEffectIdSchema,
  ReservationReleaseMutationIdSchema,
  ReservationReleaseRequestSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import { establishReservationConfirmation } from '../../shared/domain/reservation-confirmation.ts';
import { AuthoritativeReservationEvidenceSchema } from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import type { InventoryObligationPersistence } from '../../src/persistence/inventory-obligation-repository.ts';
import type { PhysicalStockEffectPersistence } from '../../src/persistence/physical-stock-effect-repository.ts';
import type { InventoryEffectRecoveryAuthority } from '../../src/services/inventory-effect-recovery-authority.ts';
import {
  makeInventoryEffectRecoveryOwnerPersistence,
  makeInventoryEffectRecoveryService,
} from '../../src/services/inventory-effect-recovery.service.ts';
import type { InventoryEffectLedgerPersistence } from '../../src/services/inventory-effect-ledger.service.ts';
import {
  commitmentProtectionLedgerIntent,
  commitmentProtectionLedgerResolution,
  makeInventoryEffectLedgerService,
  physicalStockLedgerIntent,
  physicalStockLedgerResolution,
  reservationCreateLedgerIntent,
  reservationCreateLedgerResolution,
  reservationReleaseLedgerIntent,
  reservationReleaseLedgerResolution,
} from '../../src/services/inventory-effect-ledger.service.ts';
import type { ReservationCreateEffectPersistence } from '../../src/services/inventory-reservation-create.service.ts';
import type { ReservationReleaseEffectPersistence } from '../../src/services/inventory-reservation-release.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const reservationId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const requestedAt = '2026-09-24T10:00:00.000Z';
const establishedAt = '2026-09-24T10:14:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';
const learnedAt = '2026-09-24T10:20:00.000Z';
const attemptId = 'attempt-checkout-1';

const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const stockItemRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item' as const,
  tenantId,
};
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: positionId,
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' as const };
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: requestedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef,
  unitRef,
});
const authorityConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId,
  customerConfigurationId: 'customer-configuration-primary',
  revision: 1,
  selectedAt: requestedAt,
  selection: {
    backend: 'external_business_system',
    backendId: 'erp-primary',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const reservation = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
  authority: authorityConfiguration,
  establishedAt: requestedAt,
  lifecycleMeaning: 'PROVISIONAL_RESERVATION',
  origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
  ref: {
    moduleId: 'commerce.inventory',
    resourceId: reservationId,
    resourceType: 'commerce.inventory.inventory-reservation',
    tenantId,
  },
  requirements: [
    {
      allocations: [
        {
          allocationId: 'allocation-1',
          positionRef,
          quantity: { amount: '10', unitRef },
          stockItemRef,
        },
      ],
      bindingRef: {
        moduleId: 'commerce.inventory',
        resourceId: bindingId,
        resourceType: 'commerce.inventory.catalog-to-stock-binding',
        tenantId,
      },
      catalogSelection: selection,
      exactSelectionMeaning,
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      quantity: '10',
      stockItem,
      unitRef,
    },
  ],
});

const makeLedgerHarness = (
  intent: InventoryEffectLedgerIntent,
  beforeLedgerTerminal: (record: InventoryEffectLedgerRecord) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* ledgerHarness() {
    const current = yield* Ref.make<Option.Option<InventoryEffectLedgerRecord>>(Option.none());
    const persistence: InventoryEffectLedgerPersistence = {
      createOrRead: (candidate) =>
        Effect.gen(function* createOrRead() {
          const stored = yield* Ref.get(current);
          if (Option.isSome(stored)) {
            return { outcome: 'EXISTING' as const, record: stored.value };
          }
          yield* Ref.set(current, Option.some(candidate));
          return { outcome: 'INSERTED' as const, record: candidate };
        }),
      read: () => Ref.get(current),
      save: (expected, next) =>
        Effect.gen(function* saveLedger() {
          const stored = yield* Ref.get(current);
          if (Option.isNone(stored) || stored.value.revision !== expected.revision) {
            return Option.none<InventoryEffectLedgerRecord>();
          }
          if (next.currentState === 'SUCCEEDED' || next.currentState === 'REJECTED') {
            yield* beforeLedgerTerminal(next);
          }
          yield* Ref.set(current, Option.some(next));
          return Option.some(next);
        }),
    };
    const ledger = makeInventoryEffectLedgerService(persistence, Effect.succeed(learnedAt));
    const effectId = InventoryEffectLedgerEffectIdSchema.make(intent.request.effectId);
    const claimed = yield* ledger.claim(tenantId, effectId, intent);
    yield* ledger.transition(claimed.record, { currentState: 'INDETERMINATE', resolution: null });
    return { current, effectId, ledger };
  });

const terminalAuthority = (
  resolution: InventoryEffectLedgerResolution,
  occurredAtValue: string,
  ownerEvidenceRef: string,
  learnedAtValue = learnedAt,
): InventoryEffectRecoveryAuthority => ({
  recoverOriginal: (record) =>
    Effect.succeed({
      _tag: 'AUTHORITATIVE_SUCCESS',
      effectId: record.effectId,
      intent: record.intent,
      kind: record.intent._tag,
      learnedAt: learnedAtValue,
      occurredAt: occurredAtValue,
      ownerEvidenceRef,
      resolution,
    }),
});

const makeCreatePersistence = (
  initial: ReservationCreateEffect,
  beforeSave: (next: ReservationCreateEffect) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* createPersistence() {
    const current = yield* Ref.make(initial);
    const persistence: ReservationCreateEffectPersistence = {
      createOrRead: () => Effect.die('not used'),
      findByAttempt: () => Ref.get(current).pipe(Effect.map(Option.some)),
      read: () => Ref.get(current).pipe(Effect.map(Option.some)),
      save: (_expected, next) => beforeSave(next).pipe(Effect.andThen(Ref.set(current, next)), Effect.as(next)),
    };
    return { current, persistence };
  });

const makeReleasePersistence = (initial: ReservationReleaseEffect) =>
  Effect.gen(function* releasePersistence() {
    const current = yield* Ref.make(initial);
    const persistence: ReservationReleaseEffectPersistence = {
      createOrRead: () => Effect.die('not used'),
      findByReservation: () => Ref.get(current).pipe(Effect.map(Option.some)),
      read: () => Ref.get(current).pipe(Effect.map(Option.some)),
      save: (_expected, next) => Ref.set(current, next).pipe(Effect.as(next)),
    };
    return { current, persistence };
  });

const makeProtectionPersistence = () =>
  Effect.gen(function* protectionPersistence() {
    const current = yield* Ref.make<Option.Option<CommitmentProtection>>(Option.none());
    const persistence: CommitmentProtectionPersistence = {
      createOrRead: (candidate) =>
        Effect.gen(function* createOrRead() {
          const stored = yield* Ref.get(current);
          if (Option.isSome(stored)) {
            return { outcome: 'EXISTING' as const, protection: stored.value };
          }
          yield* Ref.set(current, Option.some(candidate));
          return { outcome: 'INSERTED' as const, protection: candidate };
        }),
      findByRef: () => Ref.get(current),
      findByReservationAttempt: () => Ref.get(current),
      readHistory: () => Ref.get(current).pipe(Effect.map(Option.toArray)),
      saveRevision: ({ next }) => Ref.set(current, Option.some(next)).pipe(Effect.as(next)),
    };
    return { current, persistence };
  });

const makePhysicalPersistence = (initial: PhysicalStockEffectRecord, options: { readonly failSave?: boolean } = {}) =>
  Effect.gen(function* physicalPersistence() {
    const current = yield* Ref.make(initial);
    const saveCalls = yield* Ref.make(0);
    const persistence: PhysicalStockEffectPersistence = {
      createOrRead: () => Effect.die('not used'),
      read: () => Ref.get(current).pipe(Effect.map(Option.some)),
      saveTerminal: (expected, terminal) =>
        Effect.gen(function* saveTerminal() {
          yield* Ref.update(saveCalls, (count) => count + 1);
          if (options.failSave === true) {
            return yield* new PhysicalStockEffectUnavailable({
              code: 'physical_stock_effect_unavailable',
              effectId: expected.effectId,
              reason: 'Physical stock effect persistence is temporarily unavailable',
              retryable: true,
            });
          }
          yield* Ref.set(current, terminal);
          return terminal;
        }),
    };
    return { current, persistence, saveCalls };
  });

const makeObligationPersistence = (
  beforeEstablish: (candidate: typeof reservation) => Effect.Effect<void> = () => Effect.void,
  initial: Option.Option<InventoryObligation> = Option.none(),
) =>
  Effect.gen(function* obligationPersistence() {
    const current = yield* Ref.make(initial);
    const establishCalls = yield* Ref.make(0);
    const persistence: Pick<InventoryObligationPersistence, 'establishReservation' | 'read'> = {
      establishReservation: (candidate) =>
        Effect.gen(function* establishReservation() {
          const existing = yield* Ref.get(current);
          yield* Ref.update(establishCalls, (count) => count + 1);
          yield* beforeEstablish(candidate);
          if (Option.isSome(existing)) {
            if (!Schema.is(ProvisionalInventoryReservationSchema)(existing.value)) {
              return yield* Effect.die('unexpected descendant establishment');
            }
            return { obligation: existing.value, outcome: 'EXACT_REPLAY' as const };
          }
          yield* Ref.set(current, Option.some(candidate));
          return { obligation: candidate, outcome: 'ESTABLISHED' as const };
        }),
      read: () => Ref.get(current),
    };
    return { current, establishCalls, persistence };
  });

const unusedCreatePersistence: Pick<ReservationCreateEffectPersistence, 'read' | 'save'> = {
  read: () => Effect.die('unexpected create recovery'),
  save: () => Effect.die('unexpected create recovery'),
};
const unusedReleasePersistence: Pick<ReservationReleaseEffectPersistence, 'read' | 'save'> = {
  read: () => Effect.die('unexpected release recovery'),
  save: () => Effect.die('unexpected release recovery'),
};
const unusedProtectionPersistence: Pick<CommitmentProtectionPersistence, 'createOrRead'> = {
  createOrRead: () => Effect.die('unexpected Protection recovery'),
};
const unusedPhysicalPersistence: Pick<PhysicalStockEffectPersistence, 'read' | 'saveTerminal'> = {
  read: () => Effect.die('unexpected physical recovery'),
  saveTerminal: () => Effect.die('unexpected physical recovery'),
};
const unusedObligationPersistence: Pick<InventoryObligationPersistence, 'establishReservation' | 'read'> = {
  establishReservation: () => Effect.die('unexpected Reservation establishment'),
  read: () => Effect.die('unexpected Reservation establishment'),
};

type RecoveryOwnerDependencies = Parameters<typeof makeInventoryEffectRecoveryOwnerPersistence>[0] & {
  readonly obligations: Pick<InventoryObligationPersistence, 'establishReservation' | 'read'>;
  readonly physicalEffects: Pick<PhysicalStockEffectPersistence, 'read' | 'saveTerminal'>;
};

const makeRecoveryOwners = (overrides: Partial<RecoveryOwnerDependencies> = {}) =>
  makeInventoryEffectRecoveryOwnerPersistence({
    creates: unusedCreatePersistence,
    obligations: unusedObligationPersistence,
    physicalEffects: unusedPhysicalPersistence,
    protections: unusedProtectionPersistence,
    releases: unusedReleasePersistence,
    ...overrides,
  });

const recover = Effect.fn('InventoryEffectRecoveryOwnerTest.recover')(function* recover(input: {
  readonly authority: InventoryEffectRecoveryAuthority;
  readonly beforeLedgerTerminal?: (record: InventoryEffectLedgerRecord) => Effect.Effect<void>;
  readonly intent: InventoryEffectLedgerIntent;
  readonly owners: ReturnType<typeof makeInventoryEffectRecoveryOwnerPersistence>;
}) {
  const ledgerHarness = yield* makeLedgerHarness(input.intent, input.beforeLedgerTerminal);
  const service = yield* makeInventoryEffectRecoveryService({
    authority: input.authority,
    ledger: ledgerHarness.ledger,
    owners: input.owners,
    records: { read: () => Ref.get(ledgerHarness.current) },
  });
  const result = yield* service.recover({
    effectId: ledgerHarness.effectId,
    expectedKind: input.intent._tag,
    tenantId,
  });
  const replay = yield* service.recover({
    effectId: ledgerHarness.effectId,
    expectedKind: input.intent._tag,
    tenantId,
  });
  return { ledger: yield* Ref.get(ledgerHarness.current), replay, result };
});

const physicalScenario = (kind: 'ISSUE' | 'RECEIPT', effectIdValue: string) => {
  const physicalEffectId = Schema.decodeUnknownSync(PhysicalStockEffectIdSchema)(effectIdValue);
  const request = Schema.decodeUnknownSync(PhysicalStockEffectRequestSchema)({
    actionInvocationId: '99999999-9999-4999-8999-999999999999',
    backend: 'external_business_system',
    backendConfigurationRef: {
      moduleId: 'commerce.inventory',
      resourceId: configurationId,
      resourceType: 'commerce.inventory.inventory-backend-configuration',
      tenantId,
    },
    backendId: 'erp-primary',
    customerConfigurationId: authorityConfiguration.customerConfigurationId,
    effectId: physicalEffectId,
    kind,
    legalEntityId,
    positionRef,
    quantity: { amount: '2', unitRef },
    reason: { code: kind === 'ISSUE' ? 'ORDER_FULFILLMENT' : 'GOODS_RECEIPT', reference: 'owner-recovery:1' },
    requestedAt,
    stockItemRef,
    stockLocationRef: {
      moduleId: 'commerce.inventory',
      resourceId: '12121212-1212-4212-8212-121212121212',
      resourceType: 'commerce.inventory.stock-location',
      tenantId,
    },
  });
  const terminal = Schema.decodeUnknownSync(AppliedPhysicalStockEffectSchema)({
    _tag: 'APPLIED',
    evidence: {
      appliedAt: establishedAt,
      backend: request.backend,
      backendConfigurationRef: request.backendConfigurationRef,
      backendEvidenceRef: `erp:${kind.toLowerCase()}:1`,
      backendId: request.backendId,
      effectId: request.effectId,
      issuer: 'erp-primary',
      kind,
      positionRef: request.positionRef,
      quantity: request.quantity,
    },
    request,
  });
  return { intent: physicalStockLedgerIntent({ _tag: 'REQUESTED', request }), terminal };
};

describe('Inventory recovery owner persistence', () => {
  it.effect('CAS-applies authoritative create and release outcomes before closing the ledger', () =>
    Effect.gen(function* applyCreateAndRelease() {
      const createEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('create:attempt-checkout-1');
      const createRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
        authority: authorityConfiguration,
        commerceContext: {
          channel: 'B2C',
          commerceMarketRef: {
            moduleId: 'commerce.market-catalog',
            resourceId: 'market-primary',
            resourceType: 'commerce.market-catalog.market',
            tenantId,
          },
          customerConfigurationId: authorityConfiguration.customerConfigurationId,
          evidenceRef: 'commerce-context:1',
          observedAt: requestedAt,
          sellingLegalEntityRef: {
            moduleId: 'core.identity',
            resourceId: legalEntityId,
            resourceType: 'core.identity.legal-entity',
            tenantId,
          },
          status: 'CURRENT_OWNER_VERIFIED',
          storefrontRef: { appId: 'storefront-primary', tenantId },
          tenantId,
        },
        effectId: createEffectId,
        legalEntityId,
        mutationId: Schema.decodeUnknownSync(InventoryReservationCreateMutationIdSchema)(
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        ),
        requestedAt,
        reservation: { origin: reservation.origin, ref: reservation.ref, requirements: reservation.requirements },
        sourceActionInvocationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      });
      const requestedCreate = { _tag: 'REQUESTED' as const, request: createRequest };
      const establishedCreate = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
        _tag: 'ESTABLISHED',
        ownerEvidenceRef: 'erp:create:1',
        request: createRequest,
        reservation,
      });
      const createWriteOrder = yield* Ref.make<readonly string[]>([]);
      const obligations = yield* makeObligationPersistence(() =>
        Ref.update(createWriteOrder, (order) => [...order, 'obligation']),
      );
      const creates = yield* makeCreatePersistence(requestedCreate, () =>
        Ref.update(createWriteOrder, (order) => [...order, 'effect']),
      );
      const createResolution = reservationCreateLedgerResolution(establishedCreate);
      const createRecovered = yield* recover({
        authority: terminalAuthority(createResolution, requestedAt, establishedCreate.ownerEvidenceRef),
        beforeLedgerTerminal: () =>
          Effect.gen(function* verifyCreateOwnerState() {
            expect(yield* Ref.get(obligations.current)).toEqual(Option.some(reservation));
            expect(yield* Ref.get(creates.current)).toEqual(establishedCreate);
            yield* Ref.update(createWriteOrder, (order) => [...order, 'ledger']);
          }),
        intent: reservationCreateLedgerIntent(requestedCreate),
        owners: makeRecoveryOwners({
          creates: creates.persistence,
          obligations: obligations.persistence,
        }),
      });

      const releaseEffectId = Schema.decodeUnknownSync(ReservationReleaseEffectIdSchema)('release:attempt-checkout-1');
      const releaseRequest = Schema.decodeUnknownSync(ReservationReleaseRequestSchema)({
        effectId: releaseEffectId,
        legalEntityId,
        mutationId: Schema.decodeUnknownSync(ReservationReleaseMutationIdSchema)(
          'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
        ),
        requestedAt,
        reservation,
        sourceActionInvocationId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
      });
      const requestedRelease = { _tag: 'REQUESTED' as const, request: releaseRequest, revision: 1 as const };
      const released = Schema.decodeUnknownSync(ReleasedReservationEffectSchema)({
        _tag: 'RELEASED',
        activeAllocations: [],
        authorityIssuer: {
          backend: 'external_business_system',
          backendId: 'erp-primary',
          origin: 'EXTERNAL_BUSINESS_SYSTEM',
        },
        ownerEvidenceRef: 'erp:release:1',
        releasedAt: establishedAt,
        releaseOutcome: 'RELEASED',
        request: releaseRequest,
        revision: 2,
        safelyReusable: true,
        safeReleaseProof: {
          order: {
            _tag: 'NOT_COMMITTED_CLOSED',
            closureEvidenceRef: 'order:closed',
            nonCommitEvidenceRef: 'order:not-committed',
            observedAt: establishedAt,
          },
          protection: { _tag: 'ABSENT_PROVEN', evidenceRef: 'protection:absent', observedAt: establishedAt },
        },
      });
      const releases = yield* makeReleasePersistence(requestedRelease);
      const releaseResolution = reservationReleaseLedgerResolution(released);
      const releaseRecovered = yield* recover({
        authority: terminalAuthority(releaseResolution, released.releasedAt, released.ownerEvidenceRef),
        intent: reservationReleaseLedgerIntent(requestedRelease),
        owners: makeRecoveryOwners({
          releases: releases.persistence,
        }),
      });

      expect(yield* Ref.get(creates.current)).toEqual(establishedCreate);
      expect(yield* Ref.get(obligations.current)).toEqual(Option.some(reservation));
      expect(yield* Ref.get(obligations.establishCalls)).toBe(1);
      expect(yield* Ref.get(createWriteOrder)).toEqual(['obligation', 'effect', 'ledger']);
      expect(Option.getOrThrow(createRecovered.ledger).currentState).toBe('SUCCEEDED');
      expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(createRecovered.replay)).toBe(true);
      expect(yield* Ref.get(releases.current)).toEqual(released);
      expect(Option.getOrThrow(releaseRecovered.ledger).currentState).toBe('SUCCEEDED');
    }),
  );

  it.effect(
    'accepts an exact committed Reservation descendant during terminal create replay without downgrading it',
    () =>
      Effect.gen(function* preserveCommittedReservation() {
        const createEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(
          'create:committed-at-replay',
        );
        const createRequest = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
          authority: authorityConfiguration,
          commerceContext: {
            channel: 'B2C',
            commerceMarketRef: {
              moduleId: 'commerce.market-catalog',
              resourceId: 'market-primary',
              resourceType: 'commerce.market-catalog.market',
              tenantId,
            },
            customerConfigurationId: authorityConfiguration.customerConfigurationId,
            evidenceRef: 'commerce-context:committed-replay',
            observedAt: requestedAt,
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
            status: 'CURRENT_OWNER_VERIFIED',
            storefrontRef: { appId: 'storefront-primary', tenantId },
            tenantId,
          },
          effectId: createEffectId,
          legalEntityId,
          mutationId: Schema.decodeUnknownSync(InventoryReservationCreateMutationIdSchema)(
            '19191919-1919-4919-8919-191919191919',
          ),
          requestedAt,
          reservation: { origin: reservation.origin, ref: reservation.ref, requirements: reservation.requirements },
          sourceActionInvocationId: '20202020-2020-4020-8020-202020202020',
        });
        const establishedCreate = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
          _tag: 'ESTABLISHED',
          ownerEvidenceRef: 'erp:create:committed-replay',
          request: createRequest,
          reservation,
        });
        const committed = Schema.decodeUnknownSync(RuntimeCommittedInventoryObligationSchema)({
          ...reservation,
          confirmationTerminationReleasesStock: false,
          historicalBindingPolicy: 'PRESERVE_AND_RECONCILE',
          lifecycleMeaning: 'COMMITTED_OBLIGATION',
          obligationReductionCreatesOnHand: false,
          orderProof: {
            acceptedOrderId: 'accepted-order-committed-replay',
            attemptId: reservation.origin.attemptId,
            authority: 'ORDER_COMMIT_PROOF_AUTHORITY',
            commitStatus: 'COMMITTED',
            evidenceRef: 'order-proof:committed-replay',
            observedAt: establishedAt,
            reservationRef: reservation.ref,
            tenantId,
          },
          physicalIssueBoundary: 'SEPARATE_INVENTORY_TRANSITION',
          remainingQuantityConstraint: 'OWNER_GOVERNED_TRANSITION_REQUIRED',
        });
        const obligations = yield* makeObligationPersistence(() => Effect.void, Option.some(committed));
        const creates = yield* makeCreatePersistence(establishedCreate);
        const resolution = reservationCreateLedgerResolution(establishedCreate);

        const recovered = yield* recover({
          authority: terminalAuthority(resolution, reservation.establishedAt, establishedCreate.ownerEvidenceRef),
          intent: reservationCreateLedgerIntent(establishedCreate),
          owners: makeRecoveryOwners({ creates: creates.persistence, obligations: obligations.persistence }),
        });

        expect(Schema.is(RecoveredInventoryEffectResultSchema)(recovered.result)).toBe(true);
        expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(recovered.replay)).toBe(true);
        expect(yield* Ref.get(obligations.current)).toEqual(Option.some(committed));
        expect(yield* Ref.get(obligations.establishCalls)).toBe(0);
        expect(yield* Ref.get(creates.current)).toEqual(establishedCreate);
      }),
  );

  for (const scenario of [
    physicalScenario('RECEIPT', '13131313-1313-4313-8313-131313131313'),
    physicalScenario('ISSUE', '14141414-1414-4414-8414-141414141414'),
  ]) {
    it.effect(`persists recovered physical ${scenario.terminal.request.kind} before terminal ledger state`, () =>
      Effect.gen(function* persistRecoveredPhysicalEffect() {
        const requested = { _tag: 'REQUESTED' as const, request: scenario.terminal.request };
        const physical = yield* makePhysicalPersistence(requested);
        const resolution = physicalStockLedgerResolution(scenario.terminal);
        const recovered = yield* recover({
          authority: terminalAuthority(
            resolution,
            scenario.terminal.evidence.appliedAt,
            scenario.terminal.evidence.backendEvidenceRef,
          ),
          beforeLedgerTerminal: () =>
            Effect.gen(function* verifyPhysicalOwnerState() {
              expect(yield* Ref.get(physical.current)).toEqual(scenario.terminal);
            }),
          intent: scenario.intent,
          owners: makeRecoveryOwners({ physicalEffects: physical.persistence }),
        });

        expect(yield* Ref.get(physical.current)).toEqual(scenario.terminal);
        expect(yield* Ref.get(physical.saveCalls)).toBe(1);
        expect(Schema.is(RecoveredInventoryEffectResultSchema)(recovered.result)).toBe(true);
        expect(Schema.is(AlreadyTerminalInventoryEffectResultSchema)(recovered.replay)).toBe(true);
        expect(Option.getOrThrow(recovered.ledger).currentState).toBe('SUCCEEDED');
      }),
    );
  }

  it.effect('rejects contradictory physical owner state without terminalizing the ledger', () =>
    Effect.gen(function* rejectContradictoryPhysicalOwner() {
      const scenario = physicalScenario('ISSUE', '15151515-1515-4515-8515-151515151515');
      const contradictory = Schema.decodeUnknownSync(PhysicalStockEffectRecordSchema)({
        _tag: 'REJECTED',
        reason: 'BACKEND_REJECTED',
        request: scenario.terminal.request,
      });
      const physical = yield* makePhysicalPersistence(contradictory);
      const ledgerHarness = yield* makeLedgerHarness(scenario.intent);
      const service = yield* makeInventoryEffectRecoveryService({
        authority: terminalAuthority(
          physicalStockLedgerResolution(scenario.terminal),
          scenario.terminal.evidence.appliedAt,
          scenario.terminal.evidence.backendEvidenceRef,
        ),
        ledger: ledgerHarness.ledger,
        owners: makeRecoveryOwners({ physicalEffects: physical.persistence }),
        records: { read: () => Ref.get(ledgerHarness.current) },
      });

      const failure = yield* Effect.flip(
        service.recover({ effectId: ledgerHarness.effectId, expectedKind: 'PHYSICAL_ISSUE', tenantId }),
      );

      expect(failure).toBeInstanceOf(InventoryEffectRecoveryRejected);
      expect(failure).toMatchObject({ reason: 'OWNER_STATE_CONFLICT' });
      expect(yield* Ref.get(physical.current)).toEqual(contradictory);
      expect(yield* Ref.get(physical.saveCalls)).toBe(0);
      expect(Option.getOrThrow(yield* Ref.get(ledgerHarness.current)).currentState).toBe('INDETERMINATE');
    }),
  );

  it.effect('keeps the ledger nonterminal when physical owner persistence fails', () =>
    Effect.gen(function* preserveNonterminalLedger() {
      const scenario = physicalScenario('RECEIPT', '16161616-1616-4616-8616-161616161616');
      const requested = { _tag: 'REQUESTED' as const, request: scenario.terminal.request };
      const physical = yield* makePhysicalPersistence(requested, { failSave: true });
      const ledgerHarness = yield* makeLedgerHarness(scenario.intent);
      const service = yield* makeInventoryEffectRecoveryService({
        authority: terminalAuthority(
          physicalStockLedgerResolution(scenario.terminal),
          scenario.terminal.evidence.appliedAt,
          scenario.terminal.evidence.backendEvidenceRef,
        ),
        ledger: ledgerHarness.ledger,
        owners: makeRecoveryOwners({ physicalEffects: physical.persistence }),
        records: { read: () => Ref.get(ledgerHarness.current) },
      });

      const failure = yield* Effect.flip(
        service.recover({ effectId: ledgerHarness.effectId, expectedKind: 'PHYSICAL_RECEIPT', tenantId }),
      );

      expect(failure).toBeInstanceOf(InventoryEffectRecoveryRejected);
      expect(failure).toMatchObject({ reason: 'OWNER_PERSISTENCE_UNAVAILABLE' });
      const preserved = yield* Ref.get(physical.current);
      expect(Schema.is(RequestedPhysicalStockEffectSchema)(preserved)).toBe(true);
      if (!Schema.is(RequestedPhysicalStockEffectSchema)(preserved)) {
        yield* Effect.die('expected requested physical effect to remain unchanged');
      }
      expect(preserved.request).toEqual(requested.request);
      expect(yield* Ref.get(physical.saveCalls)).toBe(1);
      expect(Option.getOrThrow(yield* Ref.get(ledgerHarness.current)).currentState).toBe('INDETERMINATE');
    }),
  );

  it.effect('accepts late-learned in-time Protection and rejects post-expiry or contradictory proof', () =>
    Effect.gen(function* protectionTime() {
      const confirmationEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('confirmation:1');
      const confirmation = yield* establishReservationConfirmation({
        authorityEvidence: Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
          effectId: confirmationEffectId,
          evidence: {
            allocations: reservation.requirements.flatMap(({ allocations }) =>
              allocations.map(({ allocationId, positionRef: stockPositionRef, quantity, stockItemRef: itemRef }) => ({
                allocationId,
                quantity,
                stockItemRef: itemRef,
                stockPositionRef,
              })),
            ),
            attemptId,
            customerConfigurationId: authorityConfiguration.customerConfigurationId,
            ownerEvidenceRef: 'erp:confirmation:1',
            reservationId,
            tenantId,
            validFrom: requestedAt,
            validUntil: expiresAt,
          },
          issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
          kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
          operation: 'RESERVATION_CONFIRMATION',
        }),
        confirmationRef: Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
          moduleId: 'commerce.inventory',
          resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          resourceType: 'commerce.inventory.reservation-confirmation',
          tenantId,
        }),
        reservation,
      });
      const protectionEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('protection:1');
      const protectionRequest = Schema.decodeUnknownSync(CommitmentProtectionEffectRequestSchema)({
        confirmation,
        effectId: protectionEffectId,
        legalEntityId,
        mutationId: '17171717-1717-4717-8717-171717171717',
        protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
          moduleId: 'commerce.inventory',
          resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          resourceType: 'commerce.inventory.commitment-protection',
          tenantId,
        }),
        requestedAt,
        sourceActionInvocationId: '18181818-1818-4818-8818-181818181818',
      });
      const authorityEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
        effectId: protectionEffectId,
        evidence: {
          allocations: confirmation.reservation.requirements.flatMap(({ allocations }) =>
            allocations.map(({ allocationId, positionRef: stockPositionRef, quantity, stockItemRef: itemRef }) => ({
              allocationId,
              quantity,
              stockItemRef: itemRef,
              stockPositionRef,
            })),
          ),
          attemptId,
          customerConfigurationId: authorityConfiguration.customerConfigurationId,
          ownerEvidenceRef: 'erp:protection:1',
          reservationId,
          tenantId,
          validFrom: establishedAt,
          validUntil: '2026-09-25T10:00:00.000Z',
        },
        issuer: { backend: 'external_business_system', backendId: 'erp-primary', origin: 'EXTERNAL_BUSINESS_SYSTEM' },
        kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
        operation: 'COMMITMENT_PROTECTION',
      });
      const protection = yield* establishCommitmentProtection({
        authorityEvidence,
        confirmation,
        protectionRef: protectionRequest.protectionRef,
      });
      const resolution = commitmentProtectionLedgerResolution({
        _tag: 'PROTECTED',
        protection,
        request: protectionRequest,
      });
      const protections = yield* makeProtectionPersistence();
      const recovered = yield* recover({
        authority: terminalAuthority(resolution, establishedAt, authorityEvidence.evidence.ownerEvidenceRef),
        intent: commitmentProtectionLedgerIntent(protectionRequest),
        owners: makeRecoveryOwners({
          protections: protections.persistence,
        }),
      });

      expect(Option.getOrThrow(yield* Ref.get(protections.current))).toEqual(protection);
      expect(Option.getOrThrow(recovered.ledger).currentState).toBe('SUCCEEDED');

      for (const contradiction of ['POST_EXPIRY', 'OCCURRED_AT_MISMATCH', 'EVIDENCE_REF_MISMATCH'] as const) {
        const candidate =
          contradiction === 'POST_EXPIRY'
            ? Schema.decodeUnknownSync(CommitmentProtectionSchema)({
                ...protection,
                authorityEvidence: {
                  ...protection.authorityEvidence,
                  evidence: { ...protection.authorityEvidence.evidence, validFrom: expiresAt },
                },
                establishedAt: expiresAt,
                health: {
                  ...protection.health,
                  observation: { ...protection.health.observation, effectiveAt: expiresAt },
                },
              })
            : protection;
        const candidateResolution = commitmentProtectionLedgerResolution({
          _tag: 'PROTECTED',
          protection: candidate,
          request: protectionRequest,
        });
        const emptyProtections = yield* makeProtectionPersistence();
        const failed = yield* Effect.result(
          recover({
            authority: terminalAuthority(
              candidateResolution,
              contradiction === 'OCCURRED_AT_MISMATCH' ? requestedAt : candidate.establishedAt,
              contradiction === 'EVIDENCE_REF_MISMATCH'
                ? 'erp:protection:contradictory'
                : candidate.authorityEvidence.evidence.ownerEvidenceRef,
            ),
            intent: commitmentProtectionLedgerIntent(protectionRequest),
            owners: makeRecoveryOwners({
              protections: emptyProtections.persistence,
            }),
          }),
        );

        expect(Result.isFailure(failed)).toBe(true);
        expect(Option.isNone(yield* Ref.get(emptyProtections.current))).toBe(true);
      }

      const offsetEstablishedAt = '2026-09-24T19:30:00.000-02:00';
      const offsetExpiresAt = '2026-09-24T20:00:00.000Z';
      const offsetProtection = Schema.decodeUnknownSync(CommitmentProtectionSchema)({
        ...protection,
        authorityEvidence: {
          ...protection.authorityEvidence,
          evidence: { ...protection.authorityEvidence.evidence, validFrom: offsetEstablishedAt },
        },
        confirmation: {
          ...protection.confirmation,
          authorityEvidence: {
            ...protection.confirmation.authorityEvidence,
            evidence: { ...protection.confirmation.authorityEvidence.evidence, validUntil: offsetExpiresAt },
          },
          expiresAt: offsetExpiresAt,
        },
        establishedAt: offsetEstablishedAt,
        health: {
          ...protection.health,
          observation: { ...protection.health.observation, effectiveAt: offsetEstablishedAt },
        },
      });
      const offsetProtections = yield* makeProtectionPersistence();
      const offsetFailure = yield* Effect.result(
        recover({
          authority: terminalAuthority(
            commitmentProtectionLedgerResolution({
              _tag: 'PROTECTED',
              protection: offsetProtection,
              request: protectionRequest,
            }),
            offsetEstablishedAt,
            offsetProtection.authorityEvidence.evidence.ownerEvidenceRef,
            '2026-09-24T22:00:00.000Z',
          ),
          intent: commitmentProtectionLedgerIntent(protectionRequest),
          owners: makeRecoveryOwners({
            protections: offsetProtections.persistence,
          }),
        }),
      );

      expect(Result.isFailure(offsetFailure)).toBe(true);
      expect(Option.isNone(yield* Ref.get(offsetProtections.current))).toBe(true);
    }),
  );
});
