import { ReadHandlerNotFound } from '@app/core-runtime';
import { CatalogSelectionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import { Effect, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { mapCatalogToStockBindingResolutionDomainError } from '../../api/catalog-to-stock-binding-resolution-read-server.ts';
import {
  CatalogToStockBindingResolutionDomainPolicyProblemSchema,
  CatalogToStockBindingResolutionDomainUnavailableProblemSchema,
  CatalogToStockBindingResolutionRequestSchema,
  CatalogToStockBindingResolutionResponseSchema,
} from '../../shared/apis/catalog-to-stock-binding-resolution.ts';
import { CatalogToStockBindingResolutionFailure } from '../../shared/domain/catalog-to-stock-binding-resolution.ts';
import { CatalogToStockBindingUnavailable } from '../../shared/domain/catalog-to-stock-binding-unavailable.ts';
import {
  CatalogStockDemandSchema,
  CatalogToStockBindingRejected,
  ResolvedCatalogStockDemandSchema,
} from '../../shared/domain/catalog-to-stock-binding.ts';
import { InventoryBackendConfigurationSchema } from '../../shared/domain/inventory-backend-configuration.ts';
import { StockItemSchema } from '../../shared/domain/stock-item.ts';
import {
  catalogToStockBindingResolutionPermissionTarget,
  catalogToStockBindingResolutionRead,
} from '../../src/api/catalog-to-stock-binding-resolution.read.ts';
import {
  getReadHandler,
  getReadPermissionTargetResolver,
} from '../../../../packages/core-runtime/src/reads/definition.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const stockItemId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const customerConfigurationId = 'customer-configuration-1';
const exactSelectionMeaning = { id: 'catalog-owner:selection-meaning-1', kind: 'PRODUCT_VARIANT' } as const;
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
} as const;
const selection = Schema.decodeUnknownSync(CatalogSelectionSchema)({
  productRef: {
    moduleId: 'commerce.catalog',
    resourceId: productId,
    resourceType: 'commerce.catalog.product',
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.catalog.variant',
    tenantId,
  },
});
const demand = Schema.decodeUnknownSync(CatalogStockDemandSchema)({
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: 'purchase-demand-occurrence-1',
  quantity: '2.50',
  unitRef,
});
const input = Schema.decodeUnknownSync(CatalogToStockBindingResolutionRequestSchema)({
  customerConfigurationId,
  demand,
});
const stockItem = Schema.decodeUnknownSync(StockItemSchema)({
  createdAt: '2026-09-25T10:00:00.000Z',
  exactSelectionMeaning,
  lifecycle: 'CURRENT',
  retiredAt: null,
  revision: 1,
  stockItemRef: {
    moduleId: 'commerce.inventory',
    resourceId: stockItemId,
    resourceType: 'commerce.inventory.stock-item',
    tenantId,
  },
  unitRef,
});
const resolution = Schema.decodeUnknownSync(ResolvedCatalogStockDemandSchema)({
  bindingRef: {
    moduleId: 'commerce.inventory',
    resourceId: bindingId,
    resourceType: 'commerce.inventory.catalog-to-stock-binding',
    tenantId,
  },
  catalogSelection: selection,
  exactSelectionMeaning,
  purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
  quantity: demand.quantity,
  stockItem,
  unitRef,
});
const configuration = Schema.decodeUnknownSync(InventoryBackendConfigurationSchema)({
  configurationId: '77777777-7777-4777-8777-777777777777',
  customerConfigurationId,
  revision: 1,
  selectedAt: '2026-09-25T09:00:00.000Z',
  selection: {
    backend: 'ontos_wms',
    backendId: 'inventory-backend-1',
    exactReservationCapability: 'SUPPORTED',
    stockCorrectionCapability: 'SUPPORTED',
  },
  tenantId,
});
const scope = {
  authBindingId: '88888888-8888-4888-8888-888888888888',
  authContextRef: 'better-auth-session:catalog-binding-resolution-test',
  authMethod: 'session' as const,
  correlationId: 'catalog-binding-resolution-test',
  principalId: '99999999-9999-4999-8999-999999999999',
  tenantId,
};

it('binds the read permission to the requested exact Selection under trusted Tenant scope', () => {
  expect(catalogToStockBindingResolutionRead.descriptor).toMatchObject({
    legalEntityScope: 'forbidden',
    permissionTarget: 'business_permission',
  });
  const resolver = getReadPermissionTargetResolver(catalogToStockBindingResolutionRead);
  expect(Predicate.isFunction(resolver)).toBe(true);
  expect(catalogToStockBindingResolutionPermissionTarget(input, scope)).toEqual({
    businessPermission: {
      permission: 'inventory.resource.read',
      target: {
        kind: 'inventory_resource',
        resource: {
          moduleId: 'commerce.inventory',
          resourceId: productId,
          resourceType: 'commerce.inventory.catalog-to-stock-binding',
        },
        tenantId,
      },
    },
    kind: 'business_permission',
  });
  expect(
    catalogToStockBindingResolutionPermissionTarget(
      Schema.decodeUnknownSync(CatalogToStockBindingResolutionRequestSchema)({
        ...input,
        demand: {
          ...demand,
          catalogSelection: {
            ...selection,
            productRef: { ...selection.productRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
            variantRef: { ...selection.variantRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          },
          unitRef: { ...unitRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        },
      }),
      scope,
    ),
  ).toMatchObject({ businessPermission: { target: { tenantId: '' } } });
});

it.effect('resolves through the trusted configuration and returns metadata evidence with the exact demand', () =>
  Effect.gen(function* resolveGovernedBinding() {
    const handler = getReadHandler(catalogToStockBindingResolutionRead);
    const handled = yield* handler(input, {
      readKey: catalogToStockBindingResolutionRead.descriptor.readKey,
      scope,
      services: {
        findCurrentConfiguration: () => Effect.succeed(Option.some(configuration)),
        resolve: () => Effect.succeed(resolution),
      },
    });

    expect(handled.evidence).toEqual({ resultCount: 1 });
    expect(Schema.is(CatalogToStockBindingResolutionResponseSchema)(handled.result)).toBe(true);
    expect(handled.result).toMatchObject({
      customerConfigurationId,
      outcome: 'RESOLVED',
      resolution: {
        bindingRef: resolution.bindingRef,
        purchaseDemandOccurrenceId: demand.purchaseDemandOccurrenceId,
        quantity: demand.quantity,
        unitRef,
      },
    });
  }),
);

it.effect('turns a missing binding into the governed 404 path without inventing a Stock Item', () =>
  Effect.gen(function* rejectMissingBinding() {
    const handler = getReadHandler(catalogToStockBindingResolutionRead);
    const failure = yield* handler(input, {
      readKey: catalogToStockBindingResolutionRead.descriptor.readKey,
      scope,
      services: {
        findCurrentConfiguration: () => Effect.succeed(Option.some(configuration)),
        resolve: () =>
          Effect.fail(
            new CatalogToStockBindingRejected({
              code: 'catalog_to_stock_binding_rejected',
              reason: 'MISSING_BINDING',
            }),
          ),
      },
    }).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
  }),
);

it('maps ambiguity and unsupported exact meaning to typed 422 outcomes', () => {
  const ambiguous = mapCatalogToStockBindingResolutionDomainError(
    new CatalogToStockBindingResolutionFailure({
      code: 'catalog_to_stock_binding_resolution_failure',
      outcome: 'CONFLICTING',
      reason: 'MULTIPLE_CURRENT_BINDINGS',
    }),
  );
  const unsupported = mapCatalogToStockBindingResolutionDomainError(
    new CatalogToStockBindingResolutionFailure({
      bindingRef: resolution.bindingRef,
      code: 'catalog_to_stock_binding_resolution_failure',
      outcome: 'INCOMPATIBLE',
      reason: 'STOCK_UNIT_MISMATCH',
      stockItemRef: stockItem.stockItemRef,
    }),
  );

  expect(Schema.is(CatalogToStockBindingResolutionDomainPolicyProblemSchema)(ambiguous)).toBe(true);
  expect(ambiguous).toMatchObject({ outcome: 'AMBIGUOUS', reasonCode: 'MULTIPLE_CURRENT_BINDINGS', status: 422 });
  expect(Schema.is(CatalogToStockBindingResolutionDomainPolicyProblemSchema)(unsupported)).toBe(true);
  expect(unsupported).toMatchObject({ outcome: 'UNSUPPORTED', reasonCode: 'STOCK_UNIT_MISMATCH', status: 422 });
});

it('maps persistence uncertainty to a sanitized typed retryable 503 outcome', () => {
  const privateReason = 'private database diagnostic';
  const problem = mapCatalogToStockBindingResolutionDomainError(
    new CatalogToStockBindingUnavailable({
      code: 'catalog_to_stock_binding_unavailable',
      reason: privateReason,
    }),
  );

  expect(Schema.is(CatalogToStockBindingResolutionDomainUnavailableProblemSchema)(problem)).toBe(true);
  expect(problem).toMatchObject({
    outcome: 'UNAVAILABLE',
    reasonCode: 'catalog_to_stock_binding_unavailable',
    retryable: true,
    status: 503,
  });
  expect(JSON.stringify(problem)).not.toContain(privateReason);
});
