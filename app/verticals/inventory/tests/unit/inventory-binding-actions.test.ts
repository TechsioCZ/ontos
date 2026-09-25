import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { DateTime, Effect, Option, Ref, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionBusinessPermissionTargetResolver,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import { CorrectCatalogToStockBindingPayloadSchema } from '../../shared/actions/correct-catalog-to-stock-binding.ts';
import { EndCatalogToStockBindingPayloadSchema } from '../../shared/actions/end-catalog-to-stock-binding.ts';
import { EstablishCatalogToStockBindingPayloadSchema } from '../../shared/actions/establish-catalog-to-stock-binding.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import { CatalogToStockBindingRejected } from '../../shared/domain/catalog-to-stock-binding.ts';
import { markCommitmentProtectionAtRisk } from '../../shared/domain/commitment-protection.ts';
import { advanceReservationConfirmationHealth } from '../../shared/domain/reservation-confirmation.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import {
  correctCatalogToStockBindingAction,
  handleCorrectCatalogToStockBinding,
} from '../../src/actions/correct-catalog-to-stock-binding.action.ts';
import type { CorrectCatalogToStockBindingServices } from '../../src/actions/correct-catalog-to-stock-binding.action.ts';
import { endCatalogToStockBindingAction } from '../../src/actions/end-catalog-to-stock-binding.action.ts';
import { establishCatalogToStockBindingAction } from '../../src/actions/establish-catalog-to-stock-binding.action.ts';
import { buildInventoryOwnerAcceptanceBindingCorrectionLineage } from '../support/inventory-owner-acceptance-binding-correction.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const bindingRef = {
  moduleId: 'commerce.inventory',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.inventory.catalog-to-stock-binding',
  tenantId,
} as const;
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: '2026-09-24T10:00:00.000Z',
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  unitRef,
});
const evidence = {
  authority: 'INVENTORY_BINDING_OWNER',
  ownerEvidenceRef: 'binding-owner-evidence-1',
} as const;
const candidate = { catalogSelection: selection, exactSelectionMeaning, stockItem };
const establishPayload = Schema.decodeUnknownSync(EstablishCatalogToStockBindingPayloadSchema)({
  bindingRef,
  candidate,
  evidence,
});
const correctPayload = Schema.decodeUnknownSync(CorrectCatalogToStockBindingPayloadSchema)({
  bindingRef,
  candidate,
  evidence,
});
const endPayload = Schema.decodeUnknownSync(EndCatalogToStockBindingPayloadSchema)({
  bindingRef,
  disposition: 'ENDED',
  evidence,
  exactSelectionMeaning,
});
const scope = trustVerifiedGatewayPrincipalContext({
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'test:inventory-binding-actions',
  authMethod: 'api_key',
  correlationId: 'inventory-binding-actions',
  principalId: '88888888-8888-4888-8888-888888888888',
  tenantId,
});

const actions = [
  [establishCatalogToStockBindingAction, establishPayload],
  [correctCatalogToStockBindingAction, correctPayload],
  [endCatalogToStockBindingAction, endPayload],
] as const;

describe('Catalog-to-Stock Binding Actions', () => {
  it('publishes three explicit, tenant-scoped, idempotent owner lifecycle operations', () => {
    expect(actions.map(([action]) => action.descriptor.actionKey)).toEqual([
      'commerce.inventory.establish-catalog-to-stock-binding',
      'commerce.inventory.correct-catalog-to-stock-binding',
      'commerce.inventory.end-catalog-to-stock-binding',
    ]);
    for (const [action] of actions) {
      expect(action.descriptor).toMatchObject({
        auditProfile: 'sensitive',
        idempotency: 'required',
        legalEntityScope: 'forbidden',
        owningModuleKey: 'commerce.inventory',
      });
      expect(action.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(action.descriptor.auditEvidenceSchema).toBeDefined();
    }
  });

  it('requires the exact manage authority and conjunctive Resource write for the durable binding ref', () => {
    const businessTarget = {
      permission: 'inventory.catalog_to_stock_binding.manage',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: bindingRef.moduleId,
          resourceId: bindingRef.resourceId,
          resourceType: bindingRef.resourceType,
        },
        tenantId,
      },
    };
    expect([
      getActionBusinessPermissionTargetResolver(establishCatalogToStockBindingAction)?.(establishPayload, scope),
      getActionBusinessPermissionTargetResolver(correctCatalogToStockBindingAction)?.(correctPayload, scope),
      getActionBusinessPermissionTargetResolver(endCatalogToStockBindingAction)?.(endPayload, scope),
    ]).toEqual([businessTarget, businessTarget, businessTarget]);
    const resourceTarget = { permission: 'write', resource: establishPayload.bindingRef };
    expect([
      getActionResourcePermissionTargetResolver(establishCatalogToStockBindingAction)?.(establishPayload, scope),
      getActionResourcePermissionTargetResolver(correctCatalogToStockBindingAction)?.(correctPayload, scope),
      getActionResourcePermissionTargetResolver(endCatalogToStockBindingAction)?.(endPayload, scope),
    ]).toEqual([resourceTarget, resourceTarget, resourceTarget]);
  });

  it('rejects a proposed binding identity outside the exact Selection Tenant at decoding', () => {
    expect(() =>
      Schema.decodeUnknownSync(EstablishCatalogToStockBindingPayloadSchema)({
        ...establishPayload,
        bindingRef: { ...bindingRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CorrectCatalogToStockBindingPayloadSchema)({
        ...correctPayload,
        bindingRef: { ...bindingRef, tenantId: '99999999-9999-4999-8999-999999999999' },
      }),
    ).toThrow();
  });

  it('declares typed lifecycle rejection and owner-unavailable outcomes on every operation', () => {
    const rejected = new CatalogToStockBindingRejected({
      bindingRef: establishPayload.bindingRef,
      code: 'catalog_to_stock_binding_rejected',
      reason: 'BINDING_ID_CONFLICT',
    });
    const unavailable = new CatalogToStockBindingUnavailable({
      code: 'catalog_to_stock_binding_unavailable',
      reason: 'Inventory binding owner is temporarily unavailable',
    });
    for (const [action] of actions) {
      expect(Schema.is(action.descriptor.domainErrorSchema)(rejected)).toBe(true);
      expect(Schema.is(action.descriptor.domainErrorSchema)(unavailable)).toBe(true);
    }
  });

  it.effect('propagates the correction to affected owner obligations before returning the corrected binding', () =>
    Effect.gen(function* propagateCorrection() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-25T10:05:00.000Z')));
      const correctedItem = Schema.decodeUnknownSync(StockItemSchema)({
        ...stockItem,
        stockItemRef: {
          ...stockItem.stockItemRef,
          resourceId: '67666666-6666-4666-8666-666666666666',
        },
      });
      const correction = Schema.decodeUnknownSync(CorrectCatalogToStockBindingPayloadSchema)({
        ...correctPayload,
        candidate: { ...correctPayload.candidate, stockItem: correctedItem },
      });
      let stored = Schema.decodeUnknownSync(correctCatalogToStockBindingAction.descriptor.resultSchema)({
        bindingRef,
        catalogSelection: selection,
        effectiveFrom: '2026-09-24T10:00:00.000Z',
        exactSelectionMeaning,
        revision: 1,
        stockItemRef: stockItem.stockItemRef,
        unitRef,
      });
      const impactCalls = yield* Ref.make<readonly unknown[]>([]);
      const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
      const observation = {
        _tag: 'BINDING_CORRECTION' as const,
        correctionEvidenceRef: evidence.ownerEvidenceRef,
        effectiveAt: '2026-09-25T10:05:00.000Z',
      };
      const confirmationAtRisk = yield* advanceReservationConfirmationHealth(lineage.confirmation, observation);
      const protectionAtRisk = yield* markCommitmentProtectionAtRisk(lineage.protection, observation);
      const services: CorrectCatalogToStockBindingServices = {
        bindings: {
          endCurrent: () => Effect.die('not used'),
          findCurrentByExactSelectionMeaning: () => Effect.succeed([stored]),
          findCurrentByStockItem: (ref) =>
            Effect.succeed(ref.resourceId === stored.stockItemRef.resourceId ? Option.some(stored) : Option.none()),
          insertCurrent: () => Effect.die('not used'),
          readHistory: () => Effect.succeed([]),
          replaceCurrent: ({ next }) => {
            stored = next;
            return Effect.succeed(next);
          },
        },
        impacts: {
          apply: (input) =>
            Ref.update(impactCalls, (calls) => [...calls, input]).pipe(
              Effect.as({
                affectedRequirements: 1,
                committedReconciliationChanges: [
                  {
                    bindingId: bindingRef.resourceId,
                    bindingRevision: 2,
                    correctedAt: observation.effectiveAt,
                    correctionEvidenceRef: observation.correctionEvidenceRef,
                    currentStockItemId: correctedItem.stockItemRef.resourceId,
                    historicalStockItemId: stockItem.stockItemRef.resourceId,
                    obligationId: lineage.reservation.ref.resourceId,
                    purchaseDemandOccurrenceId: 'binding-correction-demand-1',
                    subjectResourceType: 'commerce.inventory.inventory-reservation' as const,
                    tenantId,
                  },
                ],
                committedReconciliations: 1,
                confirmationChanges: [confirmationAtRisk],
                confirmationsAtRisk: 1,
                protectionChanges: [protectionAtRisk],
                protectionsAtRisk: 1,
              }),
            ),
        },
      };
      const collector = createActionCollector(
        correctCatalogToStockBindingAction.descriptor.domainEvents,
        'commerce.inventory',
        correctCatalogToStockBindingAction.descriptor.accessEvidencePolicy,
        correctCatalogToStockBindingAction.descriptor.auditEvidenceSchema,
      );

      const result = yield* handleCorrectCatalogToStockBinding(correction, {
        actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services,
      });
      const calls = yield* Ref.get(impactCalls);
      const events = collector.snapshot();

      expect(result.revision).toBe(2);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        correctedBinding: { revision: 2 },
        correctionEvidenceRef: evidence.ownerEvidenceRef,
        previousBinding: { revision: 1, stockItemRef: stockItem.stockItemRef },
      });
      expect(events.domainEvents.map(({ eventType }) => eventType)).toEqual([
        'commerce.inventory.reservation-guarantee-changed.v1',
        'commerce.inventory.commitment-protection-changed.v1',
        'commerce.inventory.committed-obligation-changed.v1',
      ]);
      expect(events.outboxMessages.map(({ message }) => message.topic)).toEqual([
        'commerce.inventory.reservation-guarantee-changed.v1',
        'commerce.inventory.commitment-protection-changed.v1',
        'commerce.inventory.committed-obligation-changed.v1',
      ]);
      expect(events.outboxMessages.map(({ message }) => message.payloadJson)).toMatchObject([
        {
          ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY' },
          state: 'AT_RISK',
          subjectRef: lineage.reservation.ref,
        },
        {
          ordering: { _tag: 'OWNER_AGGREGATE_REVISION', revision: 2 },
          state: 'AT_RISK',
          subjectRef: lineage.protection.ref,
        },
        {
          ordering: { _tag: 'IMMUTABLE_OCCURRENCE_IDENTITY' },
          state: 'RECONCILIATION_REQUIRED',
          subjectRef: lineage.reservation.ref,
        },
      ]);
    }),
  );
});
