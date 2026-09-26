import { Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import {
  CompensateInventoryPreCommitPayloadSchema,
  InventoryPreCommitCleanupObservationSchema,
  InventoryPreCommitCompensationRejected,
} from '../../shared/domain/inventory-pre-commit-compensation.ts';
import type { InventoryPreCommitCleanupObservation } from '../../shared/domain/inventory-pre-commit-compensation.ts';
import {
  InventoryReservationCreateMutationIdSchema,
  InventoryReservationCreateRequestSchema,
  ReservationCreateAllocationSchema,
  ResolvedNoReservationCreateEffectSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationCreateEffect } from '../../shared/domain/inventory-reservation-create.ts';
import { InventoryBackendIdSchema } from '../../shared/domain/inventory-backend-identifiers.ts';
import { ActionInvocationIdSchema, LegalEntityIdSchema } from '../../shared/domain/physical-stock-effect.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import {
  ReservationReleaseEffectIdSchema,
  ReservationReleaseMutationIdSchema,
} from '../../shared/domain/inventory-reservation-release.ts';
import type { ReservationReleaseEffect } from '../../shared/domain/inventory-reservation-release.ts';
import { compensateInventoryPreCommitAction } from '../../src/actions/compensate-inventory-pre-commit.action.ts';
import { makeInventoryReservationReleaseService } from '../../src/services/inventory-reservation-release.service.ts';
import type { ReservationReleaseEffectPersistence } from '../../src/services/inventory-reservation-release.service.ts';
import { makeInventoryPreCommitCompensationService } from '../../src/services/inventory-pre-commit-compensation.service.ts';
import type { InventoryPreCommitCleanupPort } from '../../src/services/inventory-pre-commit-compensation.service.ts';
import {
  inventoryEffectLedgerId,
  reservationCreateLedgerIntent,
} from '../../src/services/inventory-effect-ledger.service.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-09-24T10:00:00.000Z';
const attemptId = 'attempt-checkout-1';
const createEffectId = Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('reservation-create-effect-1');
const releaseEffectId = Schema.decodeUnknownSync(ReservationReleaseEffectIdSchema)(
  'pre-commit:reservation-create-effect-1',
);
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
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const stockItemRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.inventory.stock-item' as const,
  tenantId,
};
const positionRef = {
  moduleId: 'commerce.inventory' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.inventory.stock-position' as const,
  tenantId,
};
const allocation = Schema.decodeUnknownSync(ReservationCreateAllocationSchema)({
  allocationId: 'allocation-1',
  quantity: { amount: '6', unitRef },
  stockItemRef,
  stockPositionRef: positionRef,
});
const request = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
  authority: {
    configurationId: '77777777-7777-4777-8777-777777777777',
    customerConfigurationId: 'customer-configuration-primary',
    revision: 1,
    selectedAt: timestamp,
    selection: {
      backend: 'external_business_system',
      backendId: 'erp-primary',
      exactReservationCapability: 'SUPPORTED',
      stockCorrectionCapability: 'SUPPORTED',
    },
    tenantId,
  },
  commerceContext: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-primary',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId: 'customer-configuration-primary',
    evidenceRef: 'commerce-context:1',
    observedAt: timestamp,
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
    '88888888-8888-4888-8888-888888888888',
  ),
  requestedAt: timestamp,
  reservation: {
    origin: { attemptId, kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: {
      moduleId: 'commerce.inventory',
      resourceId: '33333333-3333-4333-8333-333333333333',
      resourceType: 'commerce.inventory.inventory-reservation',
      tenantId,
    },
    requirements: [
      {
        allocations: [
          {
            allocationId: allocation.allocationId,
            positionRef,
            quantity: allocation.quantity,
            stockItemRef,
          },
        ],
        bindingRef: {
          moduleId: 'commerce.inventory',
          resourceId: '99999999-9999-4999-8999-999999999999',
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
          tenantId,
        },
        catalogSelection: selection,
        exactSelectionMeaning: { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' },
        purchaseDemandOccurrenceId: 'demand-occurrence-1',
        quantity: '6',
        stockItem: {
          createdAt: timestamp,
          exactSelectionMeaning: { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' },
          lifecycle: 'CURRENT',
          retiredAt: null,
          revision: 1,
          stockItemRef,
          unitRef,
        },
        unitRef,
      },
    ],
  },
  sourceActionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
});

const partialEffect = (): ReservationCreateEffect => ({
  _tag: 'RECONCILIATION_REQUIRED',
  constrainedAllocations: [allocation],
  observedAt: timestamp,
  ownerEvidenceRef: 'erp:partial-hold:42',
  request,
});
const indeterminateEffect = (): ReservationCreateEffect => ({
  _tag: 'INDETERMINATE',
  observedAt: timestamp,
  possibleConstrainedAllocations: [allocation],
  reason: 'BACKEND_OUTCOME_UNKNOWN',
  request,
});
const establishedEffect = (): Extract<ReservationCreateEffect, { readonly _tag: 'ESTABLISHED' }> => ({
  _tag: 'ESTABLISHED',
  ownerEvidenceRef: 'erp:reservation:42',
  request,
  reservation: {
    authority: request.authority,
    establishedAt: timestamp,
    lifecycleMeaning: 'PROVISIONAL_RESERVATION',
    origin: request.reservation.origin,
    ref: request.reservation.ref,
    requirements: request.reservation.requirements,
  },
});
const closedTruth = {
  _tag: 'NOT_COMMITTED_CLOSED' as const,
  closureEvidenceRef: 'order:closed:1',
  nonCommitEvidenceRef: 'order:not-committed:1',
  observedAt: timestamp,
};
const context = {
  actionInvocationId: ActionInvocationIdSchema.make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
  legalEntityId: LegalEntityIdSchema.make(legalEntityId),
  requestedAt: timestamp,
  tenantId,
};
const payload = Schema.decodeUnknownSync(CompensateInventoryPreCommitPayloadSchema)({
  attemptId,
  authorizationTargetRef: request.reservation.ref,
  createEffectId,
});

const makeHarness = (
  initial: ReservationCreateEffect,
  input?: { readonly cleanup?: InventoryPreCommitCleanupObservation },
) =>
  Effect.gen(function* buildHarness() {
    const current = yield* Ref.make<ReservationCreateEffect>(initial);
    const cleanupCalls = yield* Ref.make<readonly ReservationCreateEffect[]>([]);
    const releaseCalls = yield* Ref.make<readonly string[]>([]);
    const ledger = makeInMemoryInventoryEffectLedger(timestamp);
    yield* ledger.claim(tenantId, inventoryEffectLedgerId(createEffectId), reservationCreateLedgerIntent(initial));

    const releaseEffects = yield* Ref.make<Option.Option<ReservationReleaseEffect>>(Option.none());
    const releasePersistence: ReservationReleaseEffectPersistence = {
      createOrRead: (candidate) =>
        Ref.modify(
          releaseEffects,
          (
            existing,
          ): [
            { readonly effect: ReservationReleaseEffect; readonly outcome: 'EXISTING' | 'INSERTED' },
            Option.Option<ReservationReleaseEffect>,
          ] => {
            if (Option.isNone(existing)) {
              return [{ effect: candidate, outcome: 'INSERTED' }, Option.some(candidate)];
            }
            return [{ effect: existing.value, outcome: 'EXISTING' }, existing];
          },
        ),
      findByReservation: () => Ref.get(releaseEffects),
      read: () => Ref.get(releaseEffects),
      save: (_expected, next) => Ref.set(releaseEffects, Option.some(next)).pipe(Effect.as(next)),
    };
    const releaseService = makeInventoryReservationReleaseService({
      effects: releasePersistence,
      ledger,
      makeMutationId: () => ReservationReleaseMutationIdSchema.make('99999999-9999-4999-8999-999999999999'),
      obligations: {
        read: () =>
          Ref.update(releaseCalls, (calls) => [...calls, request.reservation.ref.resourceId]).pipe(
            Effect.as(Option.some(establishedEffect().reservation)),
          ),
      },
    });
    const cleanup: InventoryPreCommitCleanupPort = {
      reconcile: (effect) =>
        Ref.update(cleanupCalls, (calls) => [...calls, effect]).pipe(
          Effect.as(
            Schema.decodeUnknownSync(InventoryPreCommitCleanupObservationSchema)(
              input?.cleanup ?? {
                _tag: 'CLEANED',
                authorityIssuer: {
                  backend: request.authority.selection.backend,
                  backendId: request.authority.selection.backendId,
                  origin: 'EXTERNAL_BUSINESS_SYSTEM',
                },
                cleanedAllocations: [allocation],
                cleanedAt: timestamp,
                cleanupEvidenceRef: 'erp:cleanup:42',
                effectAbsenceProven: true,
                effectId: createEffectId,
              },
            ),
          ),
        ),
    };
    const service = makeInventoryPreCommitCompensationService({
      cleanup,
      createEffects: {
        findByAttempt: () => Ref.get(current).pipe(Effect.map(Option.some)),
        read: () => Ref.get(current).pipe(Effect.map(Option.some)),
        save: (_expected, next) => Ref.set(current, next).pipe(Effect.as(next)),
      },
      ledger,
      makeReleaseEffectId: () => releaseEffectId,
      orderTruth: { read: () => Effect.succeed(closedTruth) },
      release: releaseService,
    });
    return { cleanupCalls, current, releaseCalls, service };
  });

describe('Inventory pre-commit compensation', () => {
  it('requires Inventory Recovery permission for the exact Reservation target', () => {
    const scope = trustVerifiedGatewayPrincipalContext({
      authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      authContextRef: 'test:inventory-pre-commit-compensation',
      authMethod: 'api_key',
      correlationId: 'inventory-pre-commit-compensation',
      legalEntityId,
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      tenantId,
    });

    expect(getActionBusinessPermissionTargetResolver(compensateInventoryPreCommitAction)?.(payload, scope)).toEqual({
      permission: 'inventory.recovery.execute',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: request.reservation.ref.moduleId,
          resourceId: request.reservation.ref.resourceId,
          resourceType: request.reservation.ref.resourceType,
        },
        tenantId,
      },
    });
  });

  it.effect('rejects a mismatched authorization target before release or cleanup', () =>
    Effect.gen(function* rejectMismatchedTarget() {
      const harness = yield* makeHarness(establishedEffect());
      const failure = yield* harness.service
        .compensate(
          Schema.decodeUnknownSync(CompensateInventoryPreCommitPayloadSchema)({
            ...payload,
            authorizationTargetRef: {
              ...payload.authorizationTargetRef,
              resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
            },
          }),
          context,
        )
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ reason: 'AUTHORIZATION_TARGET_MISMATCH' });
      expect(yield* Ref.get(harness.releaseCalls)).toHaveLength(0);
      expect(yield* Ref.get(harness.cleanupCalls)).toHaveLength(0);
      expect(yield* Ref.get(harness.current)).toEqual(establishedEffect());
    }),
  );

  it.effect('delegates an established provisional Reservation to the whole-Reservation release contract', () =>
    Effect.gen(function* releaseEstablished() {
      const harness = yield* makeHarness(establishedEffect());
      const result = yield* harness.service.compensate(payload, context);

      expect(result.result.outcome).toBe('RESERVATION_RELEASE');
      if (result.result.outcome === 'RESERVATION_RELEASE') {
        expect(result.result.release.effect.request.effectId).toBe(releaseEffectId);
        expect(result.result.release.effect.request.reservation).toEqual(establishedEffect().reservation);
      }
      expect(result.releaseDispatchRequested).toBe(true);
      expect(yield* Ref.get(harness.releaseCalls)).toHaveLength(1);
      expect(yield* Ref.get(harness.cleanupCalls)).toHaveLength(0);
    }),
  );

  it.effect('compensates an exact partial hold once under its original effect and authority', () =>
    Effect.gen(function* cleanPartial() {
      const harness = yield* makeHarness(partialEffect());
      const first = yield* harness.service.compensate(payload, context);
      const replay = yield* harness.service.compensate(payload, context);

      expect(first.result.outcome).toBe('CREATE_EFFECT_COMPENSATED');
      expect(replay.result.outcome).toBe('ALREADY_COMPENSATED');
      expect(yield* Ref.get(harness.cleanupCalls)).toHaveLength(1);
      const terminal = yield* Ref.get(harness.current);
      expect(Schema.is(ResolvedNoReservationCreateEffectSchema)(terminal)).toBe(true);
      if (Schema.is(ResolvedNoReservationCreateEffectSchema)(terminal)) {
        expect(terminal).toMatchObject({
          effectAbsenceProven: true,
          preCommitCompensation: {
            cleanedAllocations: [allocation],
            orderProof: closedTruth,
            originalEffectState: 'RECONCILIATION_REQUIRED',
            originalOwnerEvidenceRef: 'erp:partial-hold:42',
          },
          reason: 'PRE_COMMIT_COMPENSATED',
          request,
        });
      }
    }),
  );

  it.effect('keeps an indeterminate cleanup fenced under the original create effect', () =>
    Effect.gen(function* keepDebt() {
      const harness = yield* makeHarness(partialEffect(), {
        cleanup: {
          _tag: 'INDETERMINATE',
          effectId: createEffectId,
          observedAt: timestamp,
          reason: 'AUTHORITY_OUTCOME_UNKNOWN',
        },
      });
      const result = yield* harness.service.compensate(payload, context);

      expect(result).toMatchObject({
        releaseDispatchRequested: false,
        result: { outcome: 'RECONCILIATION_REQUIRED', safelyReusable: false },
      });
      expect(yield* Ref.get(harness.current)).toEqual(partialEffect());
      expect(yield* Ref.get(harness.cleanupCalls)).toHaveLength(1);
    }),
  );

  it.effect('accepts authoritative cleanup of an exact partial hold discovered from an indeterminate create', () =>
    Effect.gen(function* cleanDiscoveredPartial() {
      const exactPartial = Schema.decodeUnknownSync(ReservationCreateAllocationSchema)({
        ...allocation,
        quantity: { ...allocation.quantity, amount: '3' },
      });
      const harness = yield* makeHarness(indeterminateEffect(), {
        cleanup: {
          _tag: 'CLEANED',
          authorityIssuer: {
            backend: request.authority.selection.backend,
            backendId: request.authority.selection.backendId,
            origin: 'EXTERNAL_BUSINESS_SYSTEM',
          },
          cleanedAllocations: [exactPartial],
          cleanedAt: timestamp,
          cleanupEvidenceRef: 'erp:cleanup:discovered-partial',
          effectAbsenceProven: true,
          effectId: createEffectId,
        },
      });

      const result = yield* harness.service.compensate(payload, context);
      expect(result.result.outcome).toBe('CREATE_EFFECT_COMPENSATED');
      const terminal = yield* Ref.get(harness.current);
      if (Schema.is(ResolvedNoReservationCreateEffectSchema)(terminal)) {
        expect(terminal.preCommitCompensation?.cleanedAllocations).toEqual([exactPartial]);
      }
    }),
  );

  it.effect('blocks committed, open, and unknown Order truth without release or cleanup', () =>
    Effect.gen(function* blockUnsafeTruth() {
      const harness = yield* makeHarness(partialEffect());
      const truths = [
        { _tag: 'COMMITTED' as const, evidenceRef: 'order:committed:1', observedAt: timestamp },
        { _tag: 'NOT_COMMITTED_OPEN' as const, evidenceRef: 'order:open:1', observedAt: timestamp },
        { _tag: 'INDETERMINATE' as const, observedAt: timestamp, reason: 'ORDER_EVIDENCE_UNAVAILABLE' as const },
      ];
      const outcomes = yield* Effect.all(
        truths.map((truth) =>
          makeInventoryPreCommitCompensationService({
            cleanup: { reconcile: () => Effect.die('cleanup must stay fenced') },
            createEffects: {
              findByAttempt: () => Effect.succeedSome(partialEffect()),
              read: () => Effect.succeedSome(partialEffect()),
              save: () => Effect.die('unsafe truth must not mutate'),
            },
            ledger: makeInMemoryInventoryEffectLedger(timestamp),
            makeReleaseEffectId: () => releaseEffectId,
            orderTruth: { read: () => Effect.succeed(truth) },
            release: { request: () => Effect.die('release must stay fenced') },
          }).compensate(payload, context),
        ),
      );

      expect(outcomes.map(({ result }) => result.outcome)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
      expect(outcomes.map(({ result }) => (result.outcome === 'BLOCKED' ? result.reason : 'unexpected'))).toEqual([
        'ORDER_COMMITTED',
        'ATTEMPT_NOT_CLOSED',
        'ORDER_TRUTH_UNKNOWN',
      ]);
      expect(yield* Ref.get(harness.cleanupCalls)).toHaveLength(0);
    }),
  );

  it.effect('rejects replacement-authority cleanup evidence without changing the unresolved effect', () =>
    Effect.gen(function* rejectBackendSwitch() {
      const harness = yield* makeHarness(partialEffect(), {
        cleanup: {
          _tag: 'CLEANED',
          authorityIssuer: {
            backend: 'external_business_system',
            backendId: InventoryBackendIdSchema.make('erp-replacement'),
            origin: 'EXTERNAL_BUSINESS_SYSTEM',
          },
          cleanedAllocations: [allocation],
          cleanedAt: timestamp,
          cleanupEvidenceRef: 'erp:cleanup:replacement',
          effectAbsenceProven: true,
          effectId: createEffectId,
        },
      });
      const failure = yield* harness.service.compensate(payload, context).pipe(Effect.flip);

      expect(Schema.is(InventoryPreCommitCompensationRejected)(failure)).toBe(true);
      expect(failure).toMatchObject({ reason: 'INVALID_CLEANUP_OBSERVATION' });
      expect(yield* Ref.get(harness.current)).toEqual(partialEffect());
    }),
  );
});
