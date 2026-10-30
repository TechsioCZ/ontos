import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { priceGroupCatalogOwnerAuthorizationDecision } from '../../api/index.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'owner-overlay-test',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};
const create: OwnerAuthorizationInput = {
  operation: 'action',
  operationAt: DateTime.makeUnsafe('2026-10-22T00:00:00.000Z'),
  operationKey: 'pricing.price-group-catalog.create-price-group',
  owningModuleKey: 'pricing.price-group-catalog',
  scope,
  targets: [
    {
      kind: 'business_permission',
      permission: 'pricing.price_group.create',
      target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
    },
  ],
};
const groupTarget = { kind: 'price_group' as const, priceGroupId: groupId, pricingCatalogId: tenantId, tenantId };
const contracts = [
  {
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
    permission: 'pricing.price_group.revision.create',
  },
  {
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.retire-price-group',
    permission: 'pricing.price_group.retire',
  },
  {
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.price-group-definition',
    permission: 'pricing.price_group.read',
  },
  {
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
    permission: 'pricing.price_group.read',
  },
] as const;

describe('Price Group Catalog exact owner policy', () => {
  it('admits the actual implicit Tenant catalog create tuple', () => {
    expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId }, create)).toBe('allowed');
  });
  for (const contract of contracts) {
    it(`admits only its declared group tuple ${contract.operationKey}`, () => {
      expect(
        priceGroupCatalogOwnerAuthorizationDecision(
          { tenantId },
          {
            ...create,
            ...contract,
            targets: [{ kind: 'business_permission', permission: contract.permission, target: groupTarget }],
          },
        ),
      ).toBe('allowed');
    });
  }
  const invalid: readonly OwnerAuthorizationInput[] = [
    { ...create, owningModuleKey: 'party.registry' },
    { ...create, operation: 'read' },
    { ...create, operationKey: 'pricing.price-group-catalog.undeclared' },
    { ...create, scope: { ...scope, tenantId: foreignTenantId } },
    { ...create, scope: { ...scope, legalEntityId: groupId } },
    { ...create, scope: { ...scope, trustedStorefrontId: groupId } },
    { ...create, targets: [] },
    { ...create, targets: [...create.targets, ...create.targets] },
    { ...create, targets: [{ kind: 'module', moduleId: 'pricing.price-group-catalog' }] },
    {
      ...create,
      targets: [
        {
          kind: 'business_permission',
          permission: 'pricing.price_group.read',
          target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
        },
      ],
    },
    {
      ...create,
      targets: [{ kind: 'business_permission', permission: 'pricing.price_group.create', target: groupTarget }],
    },
    {
      ...create,
      targets: [
        {
          kind: 'business_permission',
          permission: 'pricing.price_group.create',
          target: { kind: 'pricing_catalog', pricingCatalogId: foreignTenantId, tenantId },
        },
      ],
    },
    {
      ...create,
      targets: [
        {
          kind: 'business_permission',
          permission: 'pricing.price_group.create',
          target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId: foreignTenantId },
        },
      ],
    },
    {
      ...create,
      targets: [
        {
          kind: 'business_permission',
          permission: 'pricing.price_group.create',
          target: { kind: 'pricing_catalog', pricingCatalogId: tenantId, tenantId },
          trustedStorefrontId: groupId,
        },
      ],
    },
  ];
  for (const [index, input] of invalid.entries()) {
    it(`fails closed for a mismatching scope, descriptor or target ${index}`, () => {
      expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId }, input)).toBe('unavailable');
    });
  }
  it('rejects an unexpected transaction Legal Entity even when the request is tenant scoped', () => {
    expect(priceGroupCatalogOwnerAuthorizationDecision({ legalEntityId: groupId, tenantId }, create)).toBe(
      'unavailable',
    );
  });
  it('rejects a transaction Tenant mismatch before trusting the request target', () => {
    expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId: foreignTenantId }, create)).toBe('unavailable');
  });
});
