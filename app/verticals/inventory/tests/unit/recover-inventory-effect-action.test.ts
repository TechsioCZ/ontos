import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { IndeterminateInventoryEffectResultSchema } from '../../shared/domain/inventory-effect-recovery.ts';
import {
  RecoverInventoryEffectActionRejected,
  RecoverInventoryEffectPayloadSchema,
} from '../../shared/actions/recover-inventory-effect.ts';
import { InventoryEffectLedgerRecordSchema } from '../../shared/domain/inventory-effect-ledger.ts';
import type { InventoryEffectRecoveryService } from '../../src/services/inventory-effect-recovery.service.ts';
import {
  handleRecoverInventoryEffect,
  makeRecoverInventoryEffectActionService,
  recoverInventoryEffectAction,
} from '../../src/actions/recover-inventory-effect.action.ts';

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

const actionScope = trustVerifiedGatewayPrincipalContext({
  authBindingId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  authContextRef: 'test:recover-inventory-effect',
  authMethod: 'api_key',
  correlationId: 'recover-inventory-effect-test',
  legalEntityId,
  principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  tenantId,
});

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
