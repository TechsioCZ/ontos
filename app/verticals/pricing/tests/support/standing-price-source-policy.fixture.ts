import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import type { PriceIdentityKey } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import type { PriceSourceAssertionInput } from '@app/pricing-contracts/domain/price-source-provenance';
import { Schema } from 'effect';

import { ExternalPriceSourcePolicyTermsSchema } from '../../shared/domain/external-price-source-policy.ts';
import type { ExternalPriceSourcePolicyTerms } from '../../shared/domain/external-price-source-policy.ts';

/** One Tenant and Selling Legal Entity with the Akros-shaped source: base Prices and source-created Price Groups. */
export interface StandingPolicyWorld {
  readonly legalEntityId: string;
  readonly tenantId: string;
  readonly unitId: string;
}

const catalogModuleId = 'commerce.catalog' as const;

export const productMapping = { mappingContractRef: 'erp-products-price', mappingContractVersion: 'v1' } as const;
export const priceListMapping = { mappingContractRef: 'erp-price-lists-price', mappingContractVersion: 'v1' } as const;
export const erpAuthority = { sourceAuthorityRef: 'erp-prices', sourceAuthorityVersion: 'v1' } as const;

export const priceGroupRef = (tenantId: string, resourceId: string) => ({
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId,
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
});

export const unitRefFor = (world: StandingPolicyWorld, unitId = world.unitId) => ({
  moduleId: catalogModuleId,
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId: world.tenantId,
});

export const policyTerms = (
  world: StandingPolicyWorld,
  overrides: Partial<ExternalPriceSourcePolicyTerms> = {},
): ExternalPriceSourcePolicyTerms =>
  Schema.decodeSync(ExternalPriceSourcePolicyTermsSchema)({
    authority: erpAuthority,
    commercialScope: { channelId: 'B2C', marketId: 'akros-cz', sellingLegalEntityId: world.legalEntityId },
    currencyCode: 'CZK',
    effectivePeriod: { effectiveFrom: '2026-11-01T00:00:00.000Z' },
    mapping: productMapping,
    priceGroupCoverage: { kind: 'NO_GROUP' },
    unitBasis: { quantity: '1', unitRef: unitRefFor(world) },
    ...overrides,
  });

export const priceKey = (
  world: StandingPolicyWorld,
  variant: { readonly productId: string; readonly variantId: string },
  overrides: Partial<PriceIdentityKey> = {},
): PriceIdentityKey =>
  Schema.decodeSync(PriceIdentityKeySchema)({
    catalogSelection: {
      productRef: {
        moduleId: catalogModuleId,
        resourceId: variant.productId,
        resourceType: 'commerce.catalog.product',
        tenantId: world.tenantId,
      },
      variantRef: {
        moduleId: catalogModuleId,
        resourceId: variant.variantId,
        resourceType: 'commerce.catalog.variant',
        tenantId: world.tenantId,
      },
    },
    commercialScope: { channelId: 'B2C', marketId: 'akros-cz', sellingLegalEntityId: world.legalEntityId },
    currencyCode: 'CZK',
    priceGroupSelector: { kind: 'NO_GROUP' },
    unitBasis: { quantity: '1', unitRef: unitRefFor(world) },
    ...overrides,
  });

/** The source row as Symmy delivers it; it names its authority and mapping but never grants either. */
export const sourceAssertionFor = (
  key: PriceIdentityKey,
  input: {
    readonly effectiveAt: string;
    readonly mapping?: typeof productMapping | typeof priceListMapping;
    readonly sourceAssertionId: string;
  },
): PriceSourceAssertionInput =>
  Schema.decodeSync(PriceSourceAssertionInputSchema)({
    lineage: { kind: 'INITIAL' },
    mapping: input.mapping ?? productMapping,
    originalAssertion: {
      monetaryAmount: { amount: '199.90', currencyCode: key.currencyCode },
      monetaryBoundary: 'PRE_TAX',
      unitBasis: key.unitBasis,
    },
    sourceAssertionId: input.sourceAssertionId,
    sourceAuthority: erpAuthority,
    sourceRecord: {
      sourceChangeCorrelation: `erp-change-${input.sourceAssertionId}`,
      sourceRecordRef: `erp-price-row-${key.catalogSelection.variantRef.resourceId}`,
      sourceRecordVersion: '1',
      sourceSystem: { ownerModuleId: 'external.erp', sourceSystemRef: 'symmy' },
    },
    timing: {
      importedAt: input.effectiveAt,
      ownerBusinessEffectiveAt: input.effectiveAt,
      sourceEffectiveAt: input.effectiveAt,
    },
  });
