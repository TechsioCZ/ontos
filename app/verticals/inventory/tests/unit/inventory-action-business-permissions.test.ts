import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { getActionBusinessPermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';

import { CorrectStockPositionPayloadSchema } from '../../shared/actions/correct-stock-position.ts';
import { CreateInventoryReservationPayloadSchema } from '../../shared/actions/create-inventory-reservation.ts';
import { EstablishCommitmentProtectionPayloadSchema } from '../../shared/actions/establish-commitment-protection.ts';
import { ReleaseInventoryReservationPayloadSchema } from '../../shared/actions/release-inventory-reservation.ts';
import { StockIssuePayloadSchema } from '../../shared/actions/stock-issue.ts';
import { StockReceiptPayloadSchema } from '../../shared/actions/stock-receipt.ts';
import { correctStockPositionAction } from '../../src/actions/correct-stock-position.action.ts';
import { createInventoryReservationAction } from '../../src/actions/create-inventory-reservation.action.ts';
import { establishCommitmentProtectionAction } from '../../src/actions/establish-commitment-protection.action.ts';
import { releaseInventoryReservationAction } from '../../src/actions/release-inventory-reservation.action.ts';
import { stockIssueAction } from '../../src/actions/stock-issue.action.ts';
import { stockReceiptAction } from '../../src/actions/stock-receipt.action.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const scope = trustVerifiedGatewayPrincipalContext({
  authBindingId: '22222222-2222-4222-8222-222222222222',
  authContextRef: 'test:inventory-action-business-permissions',
  authMethod: 'api_key',
  correlationId: 'inventory-action-business-permissions',
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
});
const reservationRef = {
  moduleId: 'commerce.inventory',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.inventory.inventory-reservation',
  tenantId,
} as const;
const protectionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.inventory.commitment-protection',
  tenantId,
} as const;
const positionRef = {
  moduleId: 'commerce.inventory',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.inventory.stock-position',
  tenantId,
} as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const stockItemRef = {
  moduleId: 'commerce.inventory',
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'commerce.inventory.stock-item',
  tenantId,
} as const;
const catalogSelection = {
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
} as const;
const reservationPayload = Schema.decodeUnknownSync(CreateInventoryReservationPayloadSchema)({
  attemptId: 'attempt-1',
  commerceContext: {
    channel: 'B2C',
    commerceMarketRef: {
      moduleId: 'commerce.market-catalog',
      resourceId: 'market-primary',
      resourceType: 'commerce.market-catalog.market',
      tenantId,
    },
    customerConfigurationId: 'customer-configuration:primary',
    evidenceRef: 'commerce-context:current',
    observedAt: '2026-09-25T00:00:00.000Z',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    status: 'CURRENT_OWNER_VERIFIED',
    storefrontRef: { appId: 'storefront-primary', tenantId },
    tenantId,
  },
  customerConfigurationId: 'customer-configuration:primary',
  demands: [
    {
      catalogSelection,
      exactSelectionMeaning: { id: 'catalog-selection:variant', kind: 'PRODUCT_VARIANT' },
      purchaseDemandOccurrenceId: 'demand-occurrence-1',
      quantity: '1',
      unitRef,
    },
  ],
  effectId: 'reservation-effect-1',
  reservationRef,
});
const releasePayload = Schema.decodeUnknownSync(ReleaseInventoryReservationPayloadSchema)({
  attemptId: 'attempt-1',
  releaseEffectId: 'release-effect-1',
  reservationRef,
  scope: { _tag: 'WHOLE_RESERVATION' },
});
const protectionPayload = Schema.decodeUnknownSync(EstablishCommitmentProtectionPayloadSchema)({
  confirmationRef: {
    moduleId: 'commerce.inventory',
    resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    resourceType: 'commerce.inventory.reservation-confirmation',
    tenantId,
  },
  effectId: 'protection-effect-1',
  protectionRef,
});
const physicalStockPayload = {
  customerConfigurationId: 'customer-configuration:primary',
  effectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  positionRef,
  quantity: { amount: '1', unitRef },
  reason: { code: 'FULFILLMENT', reference: 'order:1' },
  stockItemRef,
};
const receiptPayload = Schema.decodeUnknownSync(StockReceiptPayloadSchema)(physicalStockPayload);
const issuePayload = Schema.decodeUnknownSync(StockIssuePayloadSchema)(physicalStockPayload);
const correctionPayload = Schema.decodeUnknownSync(CorrectStockPositionPayloadSchema)({
  correctionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  customerConfigurationId: 'customer-configuration:primary',
  evidence: {
    _tag: 'EXTERNAL_SOURCE_ASSERTION',
    sourceAssertionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  },
  expectedPositionRevision: 1,
  positionRef,
  reason: { code: 'AUTHORITATIVE_COUNT', reference: 'count:1' },
});

const inventoryResourceTarget = (resource: typeof reservationRef | typeof protectionRef | typeof positionRef) => ({
  kind: 'inventory_resource' as const,
  resource: {
    moduleId: resource.moduleId,
    resourceId: resource.resourceId,
    resourceType: resource.resourceType,
  },
  tenantId: resource.tenantId,
});

describe('Inventory Action business permissions', () => {
  it('binds stable public writes to the exact durable Inventory Resource', () => {
    expect(
      getActionBusinessPermissionTargetResolver(createInventoryReservationAction)?.(reservationPayload, scope),
    ).toEqual({
      permission: 'inventory.reservation.establish',
      target: inventoryResourceTarget(reservationRef),
    });
    expect(
      getActionBusinessPermissionTargetResolver(releaseInventoryReservationAction)?.(releasePayload, scope),
    ).toEqual({
      permission: 'inventory.reservation.release',
      target: inventoryResourceTarget(reservationRef),
    });
    expect(
      getActionBusinessPermissionTargetResolver(establishCommitmentProtectionAction)?.(protectionPayload, scope),
    ).toEqual({
      permission: 'inventory.commitment_protection.establish',
      target: inventoryResourceTarget(protectionRef),
    });
    expect(getActionBusinessPermissionTargetResolver(stockReceiptAction)?.(receiptPayload, scope)).toEqual({
      permission: 'inventory.stock.receipt',
      target: inventoryResourceTarget(positionRef),
    });
    expect(getActionBusinessPermissionTargetResolver(stockIssueAction)?.(issuePayload, scope)).toEqual({
      permission: 'inventory.stock.issue',
      target: inventoryResourceTarget(positionRef),
    });
    expect(getActionBusinessPermissionTargetResolver(correctStockPositionAction)?.(correctionPayload, scope)).toEqual({
      permission: 'inventory.stock.correct',
      target: inventoryResourceTarget(positionRef),
    });
  });

  it('keeps Resource permission checks conjunctive with business permission checks', () => {
    for (const action of [
      createInventoryReservationAction,
      releaseInventoryReservationAction,
      establishCommitmentProtectionAction,
      stockReceiptAction,
      stockIssueAction,
      correctStockPositionAction,
    ]) {
      expect(action.descriptor.businessPermission).toBeDefined();
      expect(action.descriptor.resourcePermission).toBeDefined();
    }
  });
});
