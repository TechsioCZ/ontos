import { Effect, Schema } from 'effect';
import { OperationContextUnavailable } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';

import {
  getReadConditionalPermissionPlan,
  getReadServiceFactory,
} from '../../../../packages/core-runtime/src/reads/definition.ts';

import {
  CommerceQuantityResolutionRequestSchema,
  CommerceQuantityResolutionResponseSchema,
} from '../../shared/apis/commerce-quantity-resolution.ts';
import {
  commerceQuantityGuestPermissionTargets,
  commerceQuantityProfilePermissionTargets,
  commerceQuantityResolutionProductionServices,
  commerceQuantityResolutionPermission,
  commerceQuantityResolutionRead,
  makeCommerceQuantityResolutionServices,
  handleCommerceQuantityResolution,
} from '../../src/api/commerce-quantity-resolution.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const sellingLegalEntityId = '20000000-0000-4000-8000-000000000001';
const storefrontId = 'tenant-a-cz';
const selection = {
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '50000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: '50000000-0000-4000-8000-000000000002',
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
};
const request = Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
  at: '2020-01-01T00:00:00.000Z',
  lines: [{ lineId: 'line-1', requestedQuantity: '7', selection }],
  purchasingContext: {
    channelId: 'web',
    commerceMarketId: 'cz',
    sellingLegalEntityId,
    storefrontId,
    tenantId,
  },
  subject: { kind: 'GUEST' as const },
});
const scope = {
  authMethod: 'system' as const,
  correlationId: 'quantity-resolution-test',
  legalEntityId: sellingLegalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
  trustedStorefrontId: storefrontId,
};

it('publishes the exact quantity request and every typed resolution outcome through the governed API', () => {
  expect(Schema.is(CommerceQuantityResolutionRequestSchema)(request)).toBe(true);
  expect(
    Schema.is(CommerceQuantityResolutionResponseSchema)({
      _tag: 'MISSING_COMMERCE_QUANTITY_POLICY',
      equivalentSelectionKey: 'selection-1',
      lineIds: ['line-1'],
    }),
  ).toBe(true);
  expect(
    Schema.is(CommerceQuantityResolutionResponseSchema)({
      _tag: 'COMMERCE_QUANTITY_REJECTED',
      actualQuantity: '7',
      limit: '5',
      lineIds: ['line-1'],
      reason: 'NOT_MULTIPLE',
    }),
  ).toBe(true);
});

it.effect('uses server observation time and retains the typed domain outcome', () =>
  Effect.gen(function* authoritativeQuantityResolution() {
    let observedAt = '';
    const response = yield* handleCommerceQuantityResolution(request, {
      readKey: 'commerce.customer-context.api.commerce-quantity-resolution',
      scope,
      services: {
        resolve: (trustedRequest) => {
          observedAt = trustedRequest.at;
          return Effect.succeed({
            _tag: 'MISSING_COMMERCE_QUANTITY_POLICY' as const,
            equivalentSelectionKey: 'selection-1',
            lineIds: ['line-1'],
          });
        },
      },
    });
    expect(observedAt).not.toBe(request.at);
    expect(response).toEqual({
      evidence: { resultCount: 1 },
      result: {
        _tag: 'MISSING_COMMERCE_QUANTITY_POLICY',
        equivalentSelectionKey: 'selection-1',
        lineIds: ['line-1'],
      },
    });
  }),
);

it.effect('rejects claimed purchasing scope before invoking dependencies', () =>
  Effect.gen(function* rejectMismatchedScope() {
    let called = false;
    const failure = yield* handleCommerceQuantityResolution(
      Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({
        ...request,
        purchasingContext: { ...request.purchasingContext, storefrontId: 'other-storefront' },
      }),
      {
        readKey: 'commerce.customer-context.api.commerce-quantity-resolution',
        scope,
        services: {
          resolve: () => {
            called = true;
            return Effect.die('Scope mismatch must be rejected before resolution');
          },
        },
      },
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ code: 'read_permission_denied' });
    expect(called).toBe(false);
  }),
);

it.effect('the registered production factory fails closed without authoritative Cart context', () =>
  Effect.gen(function* unavailableProductionContext() {
    expect(getReadServiceFactory(commerceQuantityResolutionRead)).toBe(makeCommerceQuantityResolutionServices);
    const transaction = { invoke: () => Effect.die('Unconfigured purchase context must not access persistence') };
    expect(makeCommerceQuantityResolutionServices(transaction, scope)).toBe(
      commerceQuantityResolutionProductionServices,
    );
    const failure = yield* makeCommerceQuantityResolutionServices(transaction, scope).pipe(Effect.flip);
    expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'operation_context_unavailable',
      reason: 'Authoritative Cart purchasing context is not configured for Commerce Quantity Resolution',
    });
  }),
);

it('declares finite Guest, Retail, and Counterparty authorization targets', () => {
  const plan = getReadConditionalPermissionPlan(commerceQuantityResolutionPermission);
  expect(commerceQuantityResolutionPermission.branchTags).toEqual(['COUNTERPARTY', 'GUEST', 'RETAIL']);
  expect(plan.branches.GUEST.requiredKinds).toEqual(['module']);
  expect(plan.branches.RETAIL.requiredKinds).toEqual(['module', 'resource_read']);
  expect(plan.branches.COUNTERPARTY.requiredKinds).toEqual(['module', 'resource_read']);
  expect(commerceQuantityGuestPermissionTargets()).toEqual([{ kind: 'module', moduleId: 'commerce.customer-context' }]);

  const retailSubject = {
    kind: 'RETAIL' as const,
    profileRef: {
      moduleId: 'commerce.customer-context' as const,
      resourceId: '40000000-0000-4000-8000-000000000001',
      resourceType: 'commerce.customer-context.retail-customer-profile' as const,
      tenantId,
    },
  };
  expect(
    commerceQuantityProfilePermissionTargets(
      Schema.decodeUnknownSync(CommerceQuantityResolutionRequestSchema)({ ...request, subject: retailSubject }),
      retailSubject,
      scope,
    ),
  ).toEqual([
    { kind: 'module', moduleId: 'commerce.customer-context' },
    {
      kind: 'resource_read',
      permission: 'read',
      resource: {
        moduleId: retailSubject.profileRef.moduleId,
        resourceId: retailSubject.profileRef.resourceId,
        resourceType: retailSubject.profileRef.resourceType,
      },
    },
  ]);
});
