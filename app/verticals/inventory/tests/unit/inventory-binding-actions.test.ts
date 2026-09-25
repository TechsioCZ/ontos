import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  getActionBusinessPermissionTargetResolver,
  getActionResourcePermissionTargetResolver,
} from '../../../../packages/core-runtime/src/actions/definition.ts';

import { CorrectCatalogToStockBindingPayloadSchema } from '../../shared/actions/correct-catalog-to-stock-binding.ts';
import { EndCatalogToStockBindingPayloadSchema } from '../../shared/actions/end-catalog-to-stock-binding.ts';
import { EstablishCatalogToStockBindingPayloadSchema } from '../../shared/actions/establish-catalog-to-stock-binding.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import { CatalogToStockBindingRejected } from '../../shared/domain/catalog-to-stock-binding.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import { correctCatalogToStockBindingAction } from '../../src/actions/correct-catalog-to-stock-binding.action.ts';
import { endCatalogToStockBindingAction } from '../../src/actions/end-catalog-to-stock-binding.action.ts';
import { establishCatalogToStockBindingAction } from '../../src/actions/establish-catalog-to-stock-binding.action.ts';

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
});
