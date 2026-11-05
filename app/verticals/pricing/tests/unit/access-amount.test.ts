import { getActionAccessAmountResolver } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { defineCommercialFeeAction } from '../../src/actions/define-commercial-fee.action.ts';
import { definePriceAction, DefinePricePayloadSchema } from '../../src/actions/define-price.action.ts';
import { manageContractualDiscountAction } from '../../src/actions/manage-contractual-discount.action.ts';
import { manageQuantityTierAction } from '../../src/actions/manage-quantity-tier.action.ts';
import { reviseCommercialFeeAction } from '../../src/actions/revise-commercial-fee.action.ts';
import { revisePriceAction } from '../../src/actions/revise-price.action.ts';
import { PricingAccessAmountUnresolvable, pricingAccessAmount } from '../../src/services/access-amount.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const scope: OperationalScope = {
  authBindingId: '40000000-0000-4000-8000-000000000004',
  authContextRef: 'session:pricing-access-amount',
  authMethod: 'session',
  correlationId: 'pricing-access-amount',
  principalId,
  tenantId,
};

const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '50000000-0000-4000-8000-000000000005',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const identityKey = {
  catalogSelection: {
    productRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '60000000-0000-4000-8000-000000000006',
      resourceType: 'commerce.catalog.product' as const,
      tenantId,
    },
    variantRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '70000000-0000-4000-8000-000000000007',
      resourceType: 'commerce.catalog.variant' as const,
      tenantId,
    },
  },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: {
    quantity: '1',
    unitRef: {
      moduleId: 'commerce.catalog' as const,
      resourceId: '80000000-0000-4000-8000-000000000008',
      resourceType: 'commerce.catalog.product-unit' as const,
      tenantId,
    },
  },
} as const;
const definePricePayload = Schema.decodeSync(DefinePricePayloadSchema)({
  effectiveFrom: '2026-09-27T10:00:00.000Z',
  identityKey,
  monetaryAmount: { amount: '1234.56', currencyCode: 'CZK' },
  priceRef,
  reason: 'Define launch Price',
  sourceAssertion: {
    lineage: { kind: 'INITIAL' },
    mapping: { mappingContractRef: 'erp-price-v2', mappingContractVersion: '2' },
    originalAssertion: {
      monetaryAmount: { amount: '1234.56', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: identityKey.unitBasis,
    },
    sourceAssertionId: '90000000-0000-4000-8000-000000000009',
    sourceAuthority: { sourceAuthorityRef: 'pricing-owner', sourceAuthorityVersion: '7' },
    sourceRecord: {
      sourceChangeCorrelation: 'change-84',
      sourceRecordRef: 'price-row-42',
      sourceRecordVersion: '9',
      sourceSystem: { ownerModuleId: 'commerce.pricing', sourceSystemRef: 'erp-eu' },
    },
    timing: {
      importedAt: '2026-09-27T10:00:00.500Z',
      ownerBusinessEffectiveAt: '2026-09-27T10:00:00.000Z',
      sourceEffectiveAt: '2026-09-27T09:59:00.000Z',
    },
  },
});

describe('Pricing governed amount (O18)', () => {
  it('reads the configured amount as exact minor units of its own currency', () => {
    expect(pricingAccessAmount({ amount: '12.34', currencyCode: 'CZK' })).toEqual({
      currency: 'CZK',
      minor: 1234,
    });
    expect(pricingAccessAmount({ amount: '5', currencyCode: 'EUR' })).toEqual({ currency: 'EUR', minor: 500 });
    expect(pricingAccessAmount({ amount: '0.5', currencyCode: 'EUR' })).toEqual({ currency: 'EUR', minor: 50 });
    expect(pricingAccessAmount({ amount: '1.100', currencyCode: 'EUR' })).toEqual({ currency: 'EUR', minor: 110 });
    expect(pricingAccessAmount({ amount: '0', currencyCode: 'EUR' })).toEqual({ currency: 'EUR', minor: 0 });
  });

  it('rounds a sub-minor fraction up, never down, so a ceiling can never be understated', () => {
    // 1.005 is 100.5 minor units; truncation would admit it under a 100 ceiling.
    expect(pricingAccessAmount({ amount: '1.005', currencyCode: 'EUR' }).minor).toBe(101);
    // The smallest fraction Pricing states (nine digits) still rounds up to one minor unit.
    expect(pricingAccessAmount({ amount: '0.000000001', currencyCode: 'EUR' }).minor).toBe(1);
    // A fraction that is exactly two minor digits does not round.
    expect(pricingAccessAmount({ amount: '1.10', currencyCode: 'EUR' }).minor).toBe(110);
  });

  it('refuses an amount outside the safe integer range instead of silently truncating it', () => {
    expect(() => pricingAccessAmount({ amount: '999999999999999999', currencyCode: 'CZK' })).toThrow(
      PricingAccessAmountUnresolvable,
    );
  });

  it('derives the governed amount from the decoded payload through the declared resolver', () => {
    const resolver = getActionAccessAmountResolver(definePriceAction);
    expect(resolver?.(definePricePayload, scope)).toEqual({ currency: 'CZK', minor: 123_456 });
  });

  it('binds a server-derived amount only to the Actions whose payload always states one', () => {
    expect(definePriceAction.descriptor.accessDeclaration?.amountInput).toBe('derived.monetaryAmount');
    expect(getActionAccessAmountResolver(definePriceAction)).toBeTypeOf('function');
    expect(defineCommercialFeeAction.descriptor.accessDeclaration?.amountInput).toBe('derived.configuredAmount');
    expect(getActionAccessAmountResolver(defineCommercialFeeAction)).toBeTypeOf('function');
    // A union payload whose retirement branch states no money names no governed amount: under an
    // amount ceiling the gate refuses `deny.amount_required` rather than defaulting a missing amount
    // to zero (O18). No caller-supplied path may govern a ceiling.
    expect(revisePriceAction.descriptor.accessDeclaration?.amountInput).toBeUndefined();
    expect(reviseCommercialFeeAction.descriptor.accessDeclaration?.amountInput).toBeUndefined();
    expect(manageQuantityTierAction.descriptor.accessDeclaration?.amountInput).toBeUndefined();
    expect(manageContractualDiscountAction.descriptor.accessDeclaration?.amountInput).toBeUndefined();
    expect(getActionAccessAmountResolver(revisePriceAction)).toBeUndefined();
    expect(getActionAccessAmountResolver(reviseCommercialFeeAction)).toBeUndefined();
    expect(getActionAccessAmountResolver(manageQuantityTierAction)).toBeUndefined();
    expect(getActionAccessAmountResolver(manageContractualDiscountAction)).toBeUndefined();
  });
});
