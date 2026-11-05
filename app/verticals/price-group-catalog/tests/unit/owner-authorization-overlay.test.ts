import type { OwnerAuthorizationInput } from '@app/core-runtime';
import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { ModuleKeySchema, RecordKeySchema } from '../../../../packages/core-runtime/src/access/ids.ts';
import { priceGroupCatalogOwnerAuthorizationDecision } from '../../api/index.ts';
import { historicalOwnerTarget } from '../../../../packages/core-runtime/tests/support/historical-owner-targets.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const recordId = '33333333-3333-4333-8333-333333333333';
const scope = {
  authMethod: 'system' as const,
  correlationId: 'owner-overlay-test',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};

/**
 * The v2 owner rule (O67-Q2): the one implicit catalog per Tenant makes every capability
 * Tenant-scoped and scope-wide, so the overlay admits exactly its own capability/entrypoint pairs
 * inside the Tenant context and nothing else. The one access gate decided the capability already.
 */
const create: OwnerAuthorizationInput = {
  capabilityKey: 'pricing.price-group-catalog.price-group.create',
  operation: 'action',
  operationAt: DateTime.makeUnsafe('2026-10-22T00:00:00.000Z'),
  operationKey: 'pricing.price-group-catalog.create-price-group',
  owningModuleKey: 'pricing.price-group-catalog',
  scope,
  targets: [],
};
const contracts = [
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.create',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group-definition-revision.create',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.retire',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.retire-price-group',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.read.definition',
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.price-group-definition',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.read.compatibility',
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
  },
] as const;

describe('Price Group Catalog exact owner policy', () => {
  for (const contract of contracts) {
    it(`admits only its declared capability ${contract.operationKey}`, () => {
      expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId }, { ...create, ...contract })).toBe('allowed');
    });
  }
  const invalid: readonly OwnerAuthorizationInput[] = [
    { ...create, owningModuleKey: 'party.registry' },
    { ...create, operation: 'read' },
    { ...create, operationKey: 'pricing.price-group-catalog.undeclared' },
    { ...create, capabilityKey: 'pricing.price-group-catalog.price-group.retire' },
    { ...create, capabilityKey: 'pricing.price-group-catalog.price-group.read.definition' },
    { ...create, scope: { ...scope, tenantId: foreignTenantId } },
    { ...create, scope: { ...scope, legalEntityId: recordId } },
    { ...create, scope: { ...scope, trustedStorefrontId: recordId } },
    // A record target belongs to a record-scoped declaration; these capabilities are scope-wide.
    {
      ...create,
      target: {
        moduleKey: ModuleKeySchema.make('pricing.price-group-catalog'),
        recordKey: RecordKeySchema.make(recordId),
      },
    },
    // A descriptor still on a legacy kind would carry owner-held targets; this owner admits none.
    {
      ...create,
      targets: [
        {
          kind: 'owner_permission',
          target: historicalOwnerTarget('pricing.price_group.create', {
            kind: 'pricing_catalog',
            pricingCatalogId: tenantId,
            tenantId,
          }),
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
    expect(priceGroupCatalogOwnerAuthorizationDecision({ legalEntityId: recordId, tenantId }, create)).toBe(
      'unavailable',
    );
  });
  it('rejects a transaction Tenant mismatch before trusting the request', () => {
    expect(priceGroupCatalogOwnerAuthorizationDecision({ tenantId: foreignTenantId }, create)).toBe('unavailable');
  });
});
