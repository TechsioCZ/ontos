import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { IndeterminateInventoryEffectResultSchema } from '../../shared/domain/inventory-effect-recovery.ts';
import {
  RecoverInventoryEffectActionRejected,
  RecoverInventoryEffectPayloadSchema,
} from '../../shared/actions/recover-inventory-effect.ts';
import { InventoryEffectLedgerRecordSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { ProvisionalInventoryReservationSchema } from '../../shared/domain/inventory-obligation.ts';
import {
  EstablishedReservationCreateEffectSchema,
  InventoryReservationCreateMutationIdSchema,
  InventoryReservationCreateRequestSchema,
} from '../../shared/domain/inventory-reservation-create.ts';
import { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import type { InventoryEffectRecoveryService } from '../../src/services/inventory-effect-recovery.service.ts';
import {
  handleRecoverInventoryEffect,
  makeRecoverInventoryEffectActionService,
  recoverInventoryEffectAction,
} from '../../src/actions/recover-inventory-effect.action.ts';

const compositionRevision = 'a'.repeat(64);

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const effectId = '88888888-8888-4888-8888-888888888888';
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const payload = Schema.decodeUnknownSync(RecoverInventoryEffectPayloadSchema)({
  effectId,
  expectedKind: 'PHYSICAL_ISSUE',
  targetRef: positionRef,
});
const original = Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
  currentState: 'INDETERMINATE',
  effectId,
  intent: {
    _tag: 'PHYSICAL_ISSUE',
    request: {
      actionInvocationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      backend: 'external_business_system',
      backendConfigurationRef: {
        moduleId: 'commerce.inventory',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.inventory.inventory-backend-configuration',
        tenantId,
      },
      backendId: 'erp-primary',
      customerConfigurationId: 'customer:primary',
      effectId,
      kind: 'ISSUE',
      legalEntityId,
      positionRef,
      quantity: {
        amount: '2',
        unitRef: {
          moduleId: 'commerce.catalog',
          resourceId: '55555555-5555-4555-8555-555555555555',
          resourceType: 'commerce.catalog.product-unit',
          tenantId,
        },
      },
      reason: { code: 'ORDER_FULFILLMENT', reference: 'order:42' },
      requestedAt: '2026-09-25T08:01:00.000Z',
      stockItemRef: {
        moduleId: 'commerce.inventory',
        resourceId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'commerce.inventory.stock-item',
        tenantId,
      },
      stockLocationRef: {
        moduleId: 'commerce.inventory',
        resourceId: '77777777-7777-4777-8777-777777777777',
        resourceType: 'commerce.inventory.stock-location',
        tenantId,
      },
    },
  },
  requestedAt: '2026-09-25T08:01:00.000Z',
  resolution: null,
  revision: 2,
  tenantId,
  updatedAt: '2026-09-25T08:02:00.000Z',
});

const actionScope = trustVerifiedGatewayPrincipalContext(
  {
    authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authContextRef: 'test:recover-inventory-effect',
    authMethod: 'api_key',
    correlationId: 'recover-inventory-effect-test',
    legalEntityId,
    principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    tenantId,
  },
  compositionRevision,
);

const recoveredReservationRecord = () => {
  const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
    productRef: {
      moduleId: 'commerce.catalog',
      resourceId: '14141414-1414-4414-8414-141414141414',
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog',
      resourceId: '15151515-1515-4515-8515-151515151515',
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
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.inventory.stock-item' as const,
    tenantId,
  };
  const reservationRef = {
    moduleId: 'commerce.inventory' as const,
    resourceId: '99999999-9999-4999-8999-999999999999',
    resourceType: 'commerce.inventory.inventory-reservation' as const,
    tenantId,
  };
  const requestedAt = '2026-09-25T08:01:00.000Z';
  const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
    configurationId: '77777777-7777-4777-8777-777777777777',
    customerConfigurationId: 'customer:primary',
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
  const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
    createdAt: requestedAt,
    exactSelectionMeaning: { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' },
    lifecycle: 'CURRENT',
    retiredAt: null,
    revision: 1,
    stockItemRef,
    unitRef,
  });
  const reservation = Schema.decodeUnknownSync(ProvisionalInventoryReservationSchema)({
    authority: configuration,
    establishedAt: requestedAt,
    lifecycleMeaning: 'PROVISIONAL_RESERVATION',
    origin: { attemptId: 'attempt-checkout-1', kind: 'ORDER_COMMITMENT_ATTEMPT' },
    ref: reservationRef,
    requirements: [
      {
        allocations: [
          {
            allocationId: 'allocation-1',
            positionRef,
            quantity: { amount: '2', unitRef },
            stockItemRef,
          },
        ],
        bindingRef: {
          moduleId: 'commerce.inventory',
          resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
          tenantId,
        },
        catalogSelection: selection,
        exactSelectionMeaning: stockItem.exactSelectionMeaning,
        purchaseDemandOccurrenceId: 'demand-1',
        quantity: '2',
        stockItem,
        unitRef,
      },
    ],
  });
  const request = Schema.decodeUnknownSync(InventoryReservationCreateRequestSchema)({
    authority: configuration,
    commerceContext: {
      channel: 'B2C',
      commerceMarketRef: {
        moduleId: 'commerce.market-catalog',
        resourceId: 'market-primary',
        resourceType: 'commerce.market-catalog.market',
        tenantId,
      },
      customerConfigurationId: configuration.customerConfigurationId,
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
    effectId: Schema.decodeUnknownSync(ReservationAuthorityEffectIdSchema)('create:attempt-checkout-1'),
    legalEntityId,
    mutationId: Schema.decodeUnknownSync(InventoryReservationCreateMutationIdSchema)(
      '12121212-1212-4212-8212-121212121212',
    ),
    requestedAt,
    reservation: { origin: reservation.origin, ref: reservation.ref, requirements: reservation.requirements },
    sourceActionInvocationId: '13131313-1313-4313-8313-131313131313',
  });
  const effect = Schema.decodeUnknownSync(EstablishedReservationCreateEffectSchema)({
    _tag: 'ESTABLISHED',
    ownerEvidenceRef: 'erp:create:1',
    request,
    reservation,
  });
  return Schema.decodeUnknownSync(InventoryEffectLedgerRecordSchema)({
    currentState: 'SUCCEEDED',
    effectId: request.effectId,
    intent: { _tag: 'RESERVATION_CREATE', request },
    requestedAt,
    resolution: { _tag: 'RESERVATION_CREATE', effect },
    revision: 3,
    tenantId,
    updatedAt: requestedAt,
  });
};

describe('Recover Inventory Effect Action', () => {
  it('declares explicit execution and exact Inventory Resource business permission gates', () => {
    expect(recoverInventoryEffectAction.descriptor).toMatchObject({
      actionKey: 'commerce.inventory.recover-inventory-effect',
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'commerce.inventory',
    });
    expect(recoverInventoryEffectAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(getActionBusinessPermissionTargetResolver(recoverInventoryEffectAction)?.(payload, actionScope)).toEqual({
      permission: 'inventory.recovery.execute',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: positionRef.moduleId,
          resourceId: positionRef.resourceId,
          resourceType: positionRef.resourceType,
        },
        tenantId,
      },
    });
  });

  it.effect('rejects retargeting before consulting recovery authority', () =>
    Effect.gen(function* rejectRetargeting() {
      let recoveryCalls = 0;
      const recovery: InventoryEffectRecoveryService = {
        recover: () =>
          Effect.sync(() => {
            recoveryCalls += 1;
            return {
              _tag: 'ALREADY_TERMINAL' as const,
              effectId: original.effectId,
              record: original,
            };
          }),
      };
      const service = makeRecoverInventoryEffectActionService({
        records: { read: () => Effect.succeedSome(original) },
        recovery,
      });
      const wrongTarget = {
        ...payload,
        targetRef: { ...positionRef, resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      };

      const failure = yield* Effect.flip(service.recover(wrongTarget, { legalEntityId, tenantId }));

      expect(failure).toBeInstanceOf(RecoverInventoryEffectActionRejected);
      expect(failure).toMatchObject({ reason: 'ORIGINAL_EFFECT_SCOPE_MISMATCH' });
      expect(recoveryCalls).toBe(0);
    }),
  );

  it.effect('recovers only the trusted tenant/legal-entity request and records bounded read evidence', () =>
    Effect.gen(function* recoverOriginal() {
      const result = {
        _tag: 'INDETERMINATE' as const,
        effectId: original.effectId,
        fence: 'PRESERVE_PHYSICAL_QUANTITY_UNCERTAINTY' as const,
        kind: 'PHYSICAL_ISSUE' as const,
        learnedAt: '2026-09-25T08:03:00.000Z',
        possibleEffectOccurred: true as const,
        reason: 'OWNER_UNAVAILABLE' as const,
        reconciliationRequired: true as const,
        record: original,
        tenantId,
      };
      const service = makeRecoverInventoryEffectActionService({
        records: { read: () => Effect.succeedSome(original) },
        recovery: { recover: () => Effect.succeed(result) },
      });
      const collector = createActionCollector(
        recoverInventoryEffectAction.descriptor.domainEvents,
        'commerce.inventory',
        recoverInventoryEffectAction.descriptor.accessEvidencePolicy,
        recoverInventoryEffectAction.descriptor.auditEvidenceSchema,
      );

      const recovered = yield* handleRecoverInventoryEffect(payload, {
        actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        compositionRevision,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope: actionScope,
        services: service,
      });

      expect(Schema.is(IndeterminateInventoryEffectResultSchema)(recovered)).toBe(true);
      expect(recovered.effectId).toBe(result.effectId);
      expect(collector.snapshot().dataAccessEvents).toEqual([
        expect.objectContaining({
          accessKind: 'read',
          queryHash: `inventory-effect-recovery:${effectId}`,
          resultCount: 1,
          targetResourceId: positionRef.resourceId,
          targetResourceType: positionRef.resourceType,
        }),
      ]);
    }),
  );

  it.effect('repairs a missing Confirmation request for an exactly replayed established Reservation', () =>
    Effect.gen(function* repairConfirmationRequest() {
      const record = recoveredReservationRecord();
      const establishedEffect = yield* Match.value(record.resolution).pipe(
        Match.when(null, () => Effect.die('expected Reservation create resolution')),
        Match.tag('RESERVATION_CREATE', ({ effect }) =>
          Schema.is(EstablishedReservationCreateEffectSchema)(effect)
            ? Effect.succeed(effect)
            : Effect.die('expected established Reservation create effect'),
        ),
        Match.orElse(() => Effect.die('expected Reservation create resolution')),
      );
      const reservationPayload = Schema.decodeUnknownSync(RecoverInventoryEffectPayloadSchema)({
        effectId: record.effectId,
        expectedKind: 'RESERVATION_CREATE',
        targetRef: establishedEffect.request.reservation.ref,
      });
      const service = makeRecoverInventoryEffectActionService({
        records: { read: () => Effect.succeedSome(record) },
        recovery: {
          recover: () => Effect.succeed({ _tag: 'ALREADY_TERMINAL', effectId: record.effectId, record }),
        },
      });
      const executeReplay = () => {
        const collector = createActionCollector(
          recoverInventoryEffectAction.descriptor.domainEvents,
          'commerce.inventory',
          recoverInventoryEffectAction.descriptor.accessEvidencePolicy,
          recoverInventoryEffectAction.descriptor.auditEvidenceSchema,
        );
        return handleRecoverInventoryEffect(reservationPayload, {
          actionInvocationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          addDomainEvent: collector.addDomainEvent,
          addOutboxMessage: collector.addOutboxMessage,
          compositionRevision,
          recordAuditEvidence: collector.recordAuditEvidence,
          recordDataAccess: collector.recordDataAccess,
          scope: actionScope,
          services: service,
        }).pipe(Effect.as(collector));
      };

      const first = yield* executeReplay();
      const replay = yield* executeReplay();
      const firstSnapshot = first.snapshot();
      const replaySnapshot = replay.snapshot();

      expect(firstSnapshot.domainEvents).toHaveLength(1);
      expect(firstSnapshot.outboxMessages).toHaveLength(1);
      expect(firstSnapshot.outboxMessages[0]?.message).toMatchObject({
        payloadJson: {
          request: {
            legalEntityId,
            mutationId: establishedEffect.request.mutationId,
            reservation: establishedEffect.reservation,
            sourceActionInvocationId: establishedEffect.request.sourceActionInvocationId,
          },
        },
        producerModuleKey: 'commerce.inventory',
        topic: 'commerce.inventory.reservation-confirmation-issuance-requested.v1',
      });
      expect(replaySnapshot.outboxMessages).toEqual(firstSnapshot.outboxMessages);
    }),
  );

  it('rejects a recovery kind that does not own the supplied durable target kind', () => {
    expect(() =>
      Schema.decodeUnknownSync(RecoverInventoryEffectPayloadSchema)({
        effectId,
        expectedKind: 'RESERVATION_RELEASE',
        targetRef: positionRef,
      }),
    ).toThrow();
  });
});
