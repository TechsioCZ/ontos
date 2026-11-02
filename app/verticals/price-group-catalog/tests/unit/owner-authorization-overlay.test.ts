import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { priceGroupCatalogOwnerAuthorizationDecision } from '../../api/index.ts';
import { priceGroupOwnerPermissionTarget } from '../../src/permissions/authorization.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const groupId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'owner-overlay-test',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};
const catalog = { kind: 'pricing_catalog' as const, pricingCatalogId: tenantId, tenantId };
const group = { kind: 'price_group' as const, priceGroupId: groupId, pricingCatalogId: tenantId, tenantId };
const create: OwnerAuthorizationInput = {
  operation: 'action',
  operationAt: DateTime.makeUnsafe('2026-10-22T00:00:00.000Z'),
  operationKey: 'pricing.price-group-catalog.create-price-group',
  owningModuleKey: 'pricing.price-group-catalog',
  scope,
  targets: [
    {
      kind: 'owner_permission',
      target: priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.create', target: catalog }, 'action'),
    },
  ],
};
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
      const target = priceGroupOwnerPermissionTarget(
        { permission: contract.permission, target: group },
        contract.operation,
      );
      expect(
        priceGroupCatalogOwnerAuthorizationDecision(
          { tenantId },
          { ...create, ...contract, targets: [{ kind: 'owner_permission', target }] },
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
    ...[
      { permission: 'pricing.price_group.read', target: catalog },
      { permission: 'pricing.price_group.create', target: { ...catalog, pricingCatalogId: foreignTenantId } },
      { permission: 'pricing.price_group.create', target: { ...catalog, tenantId: foreignTenantId } },
    ].map((request): OwnerAuthorizationInput => ({
      ...create,
      targets: [{ kind: 'owner_permission', target: priceGroupOwnerPermissionTarget(request, 'action') }],
    })),
    {
      ...create,
      targets: [
        {
          kind: 'owner_permission',
          target: priceGroupOwnerPermissionTarget(
            { permission: 'pricing.price_group.create', target: catalog },
            'action',
          ),
          trustedStorefrontId: groupId,
        },
      ],
    },
  ];
  for (const [index, input] of invalid.entries()) {
    it(`rejects tuple outside the finite owner policy ${index}`, () => {
      expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId }, input)).toBe('unavailable');
    });
  }
  it('fails closed for a transaction with a selected Legal Entity', () => {
    expect(priceGroupCatalogOwnerAuthorizationDecision({ legalEntityId: groupId, tenantId }, create)).toBe(
      'unavailable',
    );
  });
  it('rejects a permission whose published scope excludes groups', () => {
    expect(() =>
      priceGroupOwnerPermissionTarget({ permission: 'pricing.price_group.create', target: group }, 'action'),
    ).toThrow();
  });
});
