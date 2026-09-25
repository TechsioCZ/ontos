/* oxlint-disable sonarjs/no-nested-functions -- Focused in-memory owner ports keep each protection invariant explicit; expires: 2027-03-31. */
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CommitmentProtection,
  CommitmentProtectionPersistence,
} from '../../shared/domain/commitment-protection.ts';
import {
  CommitmentProtectionAtRiskResultSchema,
  CommitmentProtectionIndeterminateResultSchema,
  CommitmentProtectionNotProtectableResultSchema,
  CommitmentProtectionProtectedResultSchema,
} from '../../shared/domain/commitment-protection.ts';
import { CommitmentProtectionConflict } from '../../shared/domain/commitment-protection-conflict.ts';
import type {
  ReservationConfirmation,
  ReservationConfirmationPersistence,
} from '../../shared/domain/reservation-confirmation.ts';
import {
  advanceReservationConfirmationHealth,
  establishReservationConfirmation,
} from '../../shared/domain/reservation-confirmation.ts';
import {
  EstablishInventoryReservationInputSchema,
  establishInventoryReservation,
} from '../../shared/domain/inventory-obligation.ts';
import type { ReservationAuthorityObservation } from '../../shared/domain/reservation-authority.ts';
import {
  AuthoritativeReservationEvidenceSchema,
  ReservationAuthorityObservationSchema,
} from '../../shared/domain/reservation-authority.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { LegalEntityIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { CommitmentProtectionRefSchema } from '../../shared/resources/commitment-protection.ts';
import { ReservationConfirmationRefSchema } from '../../shared/resources/reservation-confirmation.ts';
import { StockItemRefSchema } from '../../shared/resources/stock-item.ts';
import type { CommitmentProtectionAuthority } from '../../src/services/commitment-protection-authority.ts';
import { makeCommitmentProtectionService } from '../../src/services/commitment-protection.service.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = Schema.decodeUnknownSync(LegalEntityIdSchema)('12111111-1111-4111-8111-111111111111');
const reservationId = '22222222-2222-4222-8222-222222222222';
const confirmationId = '33333333-3333-4333-8333-333333333333';
const protectionId = '34333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const positionId = '66666666-6666-4666-8666-666666666666';
const configurationId = '77777777-7777-4777-8777-777777777777';
const bindingId = '88888888-8888-4888-8888-888888888888';
const issuedAt = '2026-09-24T10:00:00.000Z';
const requestedAt = '2026-09-24T10:10:00.000Z';
const establishedAt = '2026-09-24T10:14:00.000Z';
const expiresAt = '2026-09-24T10:15:00.000Z';
const attemptId = 'attempt-checkout-1';
const effectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('effect:protection:attempt-1');

const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const itemRef = Schema.decodeUnknownSync(StockItemRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: itemId,
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
});
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: issuedAt,
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: itemRef,
  unitRef,
});

const buildConfirmation = () =>
  Effect.gen(function* fixture() {
    const reservation = yield* establishInventoryReservation(
      Schema.decodeUnknownSync(EstablishInventoryReservationInputSchema)({
        authority: {
          configurationId,
          customerConfigurationId: 'customer-configuration-primary',
          revision: 1,
          selectedAt: '2026-09-24T09:00:00.000Z',
          selection: {
            backend: 'external_business_system',
            backendId: 'erp-primary',
            exactReservationCapability: 'SUPPORTED',
            stockCorrectionCapability: 'UNSUPPORTED',
          },
          tenantId,
        },
        establishedAt: issuedAt,
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
                positionRef: {
                  moduleId: 'commerce.inventory',
                  resourceId: positionId,
                  resourceType: 'commerce.inventory.stock-position',
                  tenantId,
                },
                quantity: { amount: '10', unitRef },
                stockItemRef: itemRef,
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
      }),
    );
    const confirmationRef = Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
      moduleId: 'commerce.inventory',
      resourceId: confirmationId,
      resourceType: 'commerce.inventory.reservation-confirmation',
      tenantId,
    });
    const confirmationEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)(
      'effect:confirmation:attempt-1',
    );
    const confirmationEvidence = Schema.decodeUnknownSync(AuthoritativeReservationEvidenceSchema)({
      effectId: confirmationEffectId,
      evidence: {
        allocations: reservation.requirements.flatMap(({ allocations }) =>
          allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
            allocationId,
            quantity,
            stockItemRef,
            stockPositionRef: positionRef,
          })),
        ),
        attemptId,
        customerConfigurationId: reservation.authority.customerConfigurationId,
        ownerEvidenceRef: 'owner-proof:confirmation:1',
        reservationId,
        tenantId,
        validFrom: issuedAt,
        validUntil: expiresAt,
      },
      issuer: {
        backend: 'external_business_system',
        backendId: 'erp-primary',
        origin: 'EXTERNAL_BUSINESS_SYSTEM',
      },
      kind: 'AUTHORITATIVE_RESERVATION_EVIDENCE',
      operation: 'RESERVATION_CONFIRMATION',
    });
    return yield* establishReservationConfirmation({
      authorityEvidence: confirmationEvidence,
      confirmationRef,
      reservation,
    });
  });

const protectionRef = Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
  moduleId: 'commerce.inventory',
  resourceId: protectionId,
  resourceType: 'commerce.inventory.commitment-protection',
  tenantId,
});
const payload = {
  confirmationRef: Schema.decodeUnknownSync(ReservationConfirmationRefSchema)({
    moduleId: 'commerce.inventory',
    resourceId: confirmationId,
    resourceType: 'commerce.inventory.reservation-confirmation',
    tenantId,
  }),
  effectId,
  protectionRef,
};
const context = { legalEntityId, tenantId };

const makeHarness = (confirmation: ReservationConfirmation) =>
  Effect.gen(function* harness() {
    const currentConfirmation = yield* Ref.make(confirmation);
    const confirmationHistory = yield* Ref.make<readonly ReservationConfirmation[]>([confirmation]);
    const storedProtection = yield* Ref.make<Option.Option<CommitmentProtection>>(Option.none());
    const protectionHistory = yield* Ref.make<readonly CommitmentProtection[]>([]);
    const authorityCalls = yield* Ref.make(0);
    const observation = yield* Ref.make<ReservationAuthorityObservation>({
      competingFreshEffectAllowed: false,
      effectId,
      kind: 'INDETERMINATE',
      recovery: 'RECOVER_ORIGINAL_EFFECT',
    });
    const confirmations: ReservationConfirmationPersistence = {
      createOrRead: () => Effect.die('not used'),
      findByRef: () => Ref.get(currentConfirmation).pipe(Effect.map(Option.some)),
      findByReservationAttempt: () => Ref.get(currentConfirmation).pipe(Effect.map(Option.some)),
      readHistory: () => Ref.get(confirmationHistory),
      saveRevision: () => Effect.die('not used'),
    };
    const protections: CommitmentProtectionPersistence = {
      createOrRead: (candidate) =>
        Effect.gen(function* createProtection() {
          const stored = yield* Ref.modify(
            storedProtection,
            (
              existing,
            ): readonly [
              { readonly outcome: 'EXISTING' | 'INSERTED'; readonly protection: CommitmentProtection },
              Option.Option<CommitmentProtection>,
            ] =>
              Option.match(existing, {
                onNone: () => [{ outcome: 'INSERTED', protection: candidate }, Option.some(candidate)],
                onSome: (protection) => [{ outcome: 'EXISTING', protection }, existing],
              }),
          );
          if (stored.outcome === 'INSERTED') {
            yield* Ref.update(protectionHistory, (entries) => [...entries, stored.protection]);
          }
          return stored;
        }),
      findByRef: () => Ref.get(storedProtection),
      findByReservationAttempt: () => Ref.get(storedProtection),
      readHistory: () => Ref.get(protectionHistory),
      saveRevision: ({ next }) =>
        Ref.set(storedProtection, Option.some(next)).pipe(
          Effect.andThen(Ref.update(protectionHistory, (entries) => [...entries, next])),
          Effect.as(next),
        ),
    };
    const authority: CommitmentProtectionAuthority = {
      establish: () =>
        Ref.updateAndGet(authorityCalls, (count) => count + 1).pipe(Effect.andThen(Ref.get(observation))),
    };
    const service = makeCommitmentProtectionService({
      authority,
      confirmations,
      ledger: makeInMemoryInventoryEffectLedger(requestedAt),
      now: Effect.succeed('2026-09-24T10:20:00.000Z'),
      protections,
    });
    return {
      authorityCalls,
      confirmationHistory,
      currentConfirmation,
      observation,
      protectionHistory,
      service,
      storedProtection,
    };
  });

const confirmedObservation = (
  confirmation: ReservationConfirmation,
  at = establishedAt,
): ReservationAuthorityObservation =>
  Schema.decodeUnknownSync(ReservationAuthorityObservationSchema)({
    effectId,
    evidence: {
      allocations: confirmation.reservation.requirements.flatMap(({ allocations }) =>
        allocations.map(({ allocationId, positionRef, quantity, stockItemRef }) => ({
          allocationId,
          quantity,
          stockItemRef,
          stockPositionRef: positionRef,
        })),
      ),
      attemptId,
      customerConfigurationId: confirmation.reservation.authority.customerConfigurationId,
      ownerEvidenceRef: 'owner-proof:protection:1',
      reservationId,
      tenantId,
      validFrom: at,
      validUntil: '2026-09-25T10:00:00.000Z',
    },
    issuer: {
      backend: 'external_business_system',
      backendId: 'erp-primary',
      origin: 'EXTERNAL_BUSINESS_SYSTEM',
    },
    kind: 'CONFIRMED',
    operation: 'COMMITMENT_PROTECTION',
  });

describe('Inventory Commitment Protection', () => {
  it.effect('establishes one exact fence and replays the same identity without another authority call', () =>
    Effect.gen(function* protectExactlyOnce() {
      const confirmation = yield* buildConfirmation();
      const harness = yield* makeHarness(confirmation);
      yield* Ref.set(harness.observation, confirmedObservation(confirmation));

      const first = yield* harness.service.establish(payload, context);
      const replay = yield* harness.service.establish(payload, context);
      const protectedResult = yield* Schema.decodeUnknownEffect(CommitmentProtectionProtectedResultSchema)(first).pipe(
        Effect.orDie,
      );

      expect(Schema.is(CommitmentProtectionProtectedResultSchema)(first)).toBe(true);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(yield* Ref.get(harness.authorityCalls)).toBe(1);
      expect(protectedResult.protection.confirmation.reservation.requirements[0]?.quantity).toBe('10');
      expect(
        protectedResult.protection.confirmation.reservation.requirements[0]?.allocations[0]?.quantity,
      ).toMatchObject({
        amount: '10',
        unitRef: { resourceId: unitId },
      });
    }),
  );

  it.effect('reports an indeterminate outcome without claiming protected or reusable stock', () =>
    Effect.gen(function* remainFenced() {
      const confirmation = yield* buildConfirmation();
      const harness = yield* makeHarness(confirmation);

      const result = yield* harness.service.establish(payload, context);

      expect(Schema.is(CommitmentProtectionIndeterminateResultSchema)(result)).toBe(true);
      expect(result).toMatchObject({ fence: 'BLOCKED_PENDING_RECOVERY', recovery: 'RECOVER_ORIGINAL_EFFECT' });
      expect(Option.isNone(yield* Ref.get(harness.storedProtection))).toBe(true);
    }),
  );

  it.effect('collapses concurrent exact attempts and rejects changed intent under the original effect identity', () =>
    Effect.gen(function* concurrentCollapse() {
      const confirmation = yield* buildConfirmation();
      const harness = yield* makeHarness(confirmation);
      yield* Ref.set(harness.observation, confirmedObservation(confirmation));

      const results = yield* Effect.all(
        [harness.service.establish(payload, context), harness.service.establish(payload, context)],
        { concurrency: 'unbounded' },
      );
      const changed = yield* harness.service
        .establish(
          {
            ...payload,
            protectionRef: Schema.decodeUnknownSync(CommitmentProtectionRefSchema)({
              ...protectionRef,
              resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            }),
          },
          context,
        )
        .pipe(Effect.flip);

      expect(results.some(Schema.is(CommitmentProtectionProtectedResultSchema))).toBe(true);
      expect(yield* Ref.get(harness.authorityCalls)).toBe(1);
      expect(Schema.is(CommitmentProtectionConflict)(changed)).toBe(true);
      expect(changed).toMatchObject({ reason: 'MATERIAL_INTENT_CONFLICT' });
    }),
  );

  it.effect('recovers a lost response after expiry when authoritative establishment was before expiry', () =>
    Effect.gen(function* recoverAfterExpiry() {
      const confirmation = yield* buildConfirmation();
      const harness = yield* makeHarness(confirmation);
      yield* harness.service.establish(payload, context);
      const expired = yield* advanceReservationConfirmationHealth(confirmation, {
        _tag: 'VALIDITY_ELAPSED',
        effectiveAt: expiresAt,
      });
      yield* Ref.set(harness.currentConfirmation, expired);
      yield* Ref.update(harness.confirmationHistory, (entries) => [...entries, expired]);
      yield* Ref.set(harness.observation, confirmedObservation(confirmation));

      const recovered = yield* harness.service.establish(payload, context);
      const protectedResult = yield* Schema.decodeUnknownEffect(CommitmentProtectionProtectedResultSchema)(
        recovered,
      ).pipe(Effect.orDie);

      expect(Schema.is(CommitmentProtectionProtectedResultSchema)(recovered)).toBe(true);
      expect(protectedResult.protection.establishedAt).toBe(establishedAt);
      expect(protectedResult.protection.confirmation.expiresAt).toBe(expiresAt);
    }),
  );

  it.effect('rejects a new Protection effect after Confirmation expiry without calling an authority', () =>
    Effect.gen(function* rejectLateEffect() {
      const confirmation = yield* buildConfirmation();
      const expired = yield* advanceReservationConfirmationHealth(confirmation, {
        _tag: 'VALIDITY_ELAPSED',
        effectiveAt: expiresAt,
      });
      const harness = yield* makeHarness(expired);
      yield* Ref.set(harness.confirmationHistory, [confirmation, expired]);
      const service = makeCommitmentProtectionService({
        authority: { establish: () => Ref.get(harness.observation) },
        confirmations: {
          createOrRead: () => Effect.die('not used'),
          findByRef: () => Effect.succeedSome(expired),
          findByReservationAttempt: () => Effect.succeedSome(expired),
          readHistory: () => Effect.succeed([confirmation, expired]),
          saveRevision: () => Effect.die('not used'),
        },
        ledger: makeInMemoryInventoryEffectLedger('2026-09-24T10:15:00.000Z'),
        now: Effect.succeed('2026-09-24T10:15:00.000Z'),
        protections: {
          createOrRead: () => Effect.die('not used'),
          findByRef: () => Effect.succeedNone,
          findByReservationAttempt: () => Effect.succeedNone,
          readHistory: () => Effect.succeed([]),
          saveRevision: () => Effect.die('not used'),
        },
      });

      const result = yield* service.establish(payload, context);

      expect(Schema.is(CommitmentProtectionNotProtectableResultSchema)(result)).toBe(true);
      expect(result).toMatchObject({ reason: 'CONFIRMATION_EXPIRED' });
    }),
  );

  it.effect('marks a binding correction AT_RISK without retargeting or releasing the original Item', () =>
    Effect.gen(function* preserveOriginalLineage() {
      const confirmation = yield* buildConfirmation();
      const harness = yield* makeHarness(confirmation);
      yield* Ref.set(harness.observation, confirmedObservation(confirmation));
      const established = yield* harness.service.establish(payload, context);
      const protectedResult = yield* Schema.decodeUnknownEffect(CommitmentProtectionProtectedResultSchema)(
        established,
      ).pipe(Effect.orDie);

      const atRisk = yield* harness.service.recordAtRisk({
        observation: {
          _tag: 'BINDING_CORRECTION',
          correctionEvidenceRef: 'catalog-binding-correction:1',
          effectiveAt: '2026-09-24T10:16:00.000Z',
        },
        protection: protectedResult.protection,
      });
      const replay = yield* harness.service.establish(payload, context);

      expect(atRisk.health).toMatchObject({ reconciliationRequired: true, state: 'AT_RISK' });
      expect(Schema.is(CommitmentProtectionAtRiskResultSchema)(replay)).toBe(true);
      expect(replay).toMatchObject({ reconciliationRequired: true, replayed: true });
      expect(atRisk.confirmation.reservation.requirements[0]?.stockItem.stockItemRef.resourceId).toBe(itemId);
      expect(atRisk).not.toHaveProperty('releasedAt');
    }),
  );
});
