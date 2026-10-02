import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  CurrentSupportedCurrenciesRequestSchema,
  CurrentSupportedCurrenciesSuccessSchema,
} from '../../src/apis/current-supported-currencies.ts';
import { PriceCommercialScopeSchema, PriceIdentityKeySchema } from '../../src/domain/price-definition.ts';
import { PricingDecisionSchema } from '../../src/domain/pricing-decision.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '99999999-9999-4999-8999-999999999999';
const effectiveAt = '2026-09-27T10:00:00.000Z';

const catalogRef = <const ResourceType extends string>(
  resourceId: string,
  resourceType: ResourceType,
  refTenantId = tenantId,
) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId: refTenantId,
});

const productRef = catalogRef('22222222-2222-4222-8222-222222222222', 'commerce.catalog.product');
const variantRef = catalogRef('33333333-3333-4333-8333-333333333333', 'commerce.catalog.variant');
const unitRef = catalogRef('44444444-4444-4444-8444-444444444444', 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };
const commercialScope = {
  channelId: 'B2C',
  marketId: 'cz-launch',
  sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
};
const identityKey = {
  catalogSelection: selection,
  commercialScope,
  currencyCode: 'CZK',
  priceGroupSelector: { kind: 'NO_GROUP' as const },
  unitBasis: { quantity: '1', unitRef },
};

const catalogEvidence = {
  assessedAt: effectiveAt,
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 1 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 2 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 1 },
    },
  ],
  membership: {
    attestationId: 'catalog-membership:1',
    observedAt: effectiveAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};
const catalogHandoff = {
  completeness: {
    observedAt: effectiveAt,
    ownerRevision: 'catalog-quantity:1',
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'catalog-quantity:exact-selection' },
  },
  divisible: false,
  equivalentSelectionKey: 'catalog-selection:exact',
  evidence: catalogEvidence,
  hierarchyRevision: 'catalog-hierarchy:1',
  ownerRevision: 'catalog-quantity:1',
  quantity: {
    changed: false,
    notice: null,
    requested: '1',
    resulting: '1',
    rounding: 'HALF_UP' as const,
    status: 'VALID' as const,
    step: '1',
    targetId: variantRef.resourceId,
    tenantId,
    unitId: unitRef.resourceId,
    unitRuleRevision: 1,
  },
  quantityBasis: {
    targetDivisibilityRevision: 1,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 1,
  },
  selection,
  status: 'READY' as const,
  unitRef,
};
const line = (occurrenceId: string) => ({
  catalog: catalogHandoff,
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});
const decision = {
  commercialScope,
  currencyCode: 'CZK',
  lines: [line('demand-occurrence:1'), line('demand-occurrence:2')],
  monetaryBoundary: 'PRE_TAX',
  operationTime: effectiveAt,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'commerce-access-decision:1',
      decisionRevision: 'commerce-access-decision-r1',
    },
    actor: {
      kind: 'PRINCIPAL',
      principalId: 'principal:1',
    },
    commercialSettingsDecision: {
      decisionRef: 'commerce-settings-decision:1',
      decisionRevision: 'commerce-settings-decision-r1',
    },
    contextRef: 'commerce-purchasing-context:1',
    contextRevision: 'customer-context:1',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:1',
      resolutionRevision: 'purchase-currency-resolution-r1',
    },
    subject: {
      authorizationSubject: { kind: 'RETAIL' },
      kind: 'PROFILE',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'retail-profile:1',
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId,
      },
    },
  },
  tenantId,
} as const;

const decodeCommercialScope = Schema.decodeUnknownSync(PriceCommercialScopeSchema, {
  onExcessProperty: 'error',
});
const decodeIdentityKey = Schema.decodeUnknownSync(PriceIdentityKeySchema, {
  onExcessProperty: 'error',
});
const decodeDecision = Schema.decodeUnknownSync(PricingDecisionSchema, {
  onExcessProperty: 'error',
});
const decodeCurrencySupportRequest = Schema.decodeUnknownSync(CurrentSupportedCurrenciesRequestSchema, {
  onExcessProperty: 'error',
});
const decodeCurrencySupport = Schema.decodeUnknownSync(CurrentSupportedCurrenciesSuccessSchema, {
  onExcessProperty: 'error',
});
const identityKeysEqual = Schema.toEquivalence(PriceIdentityKeySchema);

describe('Pricing commercial context scope acceptance', () => {
  it('requires exact Selling Legal Entity, Channel, and Commerce Market values', () => {
    expect(decodeCommercialScope(commercialScope)).toEqual(commercialScope);

    const partialScopes = [
      { channelId: commercialScope.channelId, marketId: commercialScope.marketId },
      { channelId: commercialScope.channelId, sellingLegalEntityId: commercialScope.sellingLegalEntityId },
      { marketId: commercialScope.marketId, sellingLegalEntityId: commercialScope.sellingLegalEntityId },
    ];
    for (const partialScope of partialScopes) {
      expect(() => decodeCommercialScope(partialScope)).toThrow();
    }

    for (const wildcardAxis of ['sellingLegalEntityId', 'channelId', 'marketId'] as const) {
      expect(() => decodeCommercialScope({ ...commercialScope, [wildcardAxis]: '*' })).toThrow();
    }
    expect(() => decodeCommercialScope({ ...commercialScope, channelId: 'web-b2c' })).toThrow();
    expect(() => decodeCommercialScope({ ...commercialScope, sellingLegalEntityId: 'techsio-cz' })).toThrow();
  });

  it('keeps Storefront outside canonical Price identity and exact scope', () => {
    const storefrontAKey = decodeIdentityKey(identityKey);
    const storefrontBKey = decodeIdentityKey({ ...identityKey });

    expect(identityKeysEqual(storefrontAKey, storefrontBKey)).toBe(true);
    expect(() => decodeIdentityKey({ ...identityKey, storefrontId: 'storefront-a' })).toThrow();
    expect(() =>
      decodeIdentityKey({
        ...identityKey,
        commercialScope: { ...commercialScope, storefrontId: 'storefront-a' },
      }),
    ).toThrow();
  });

  it('treats seller, Channel, Market, and native currency changes as different exact keys', () => {
    const exactKey = decodeIdentityKey(identityKey);
    const isolatedKeys = [
      {
        ...identityKey,
        commercialScope: {
          ...commercialScope,
          sellingLegalEntityId: '66666666-6666-4666-8666-666666666666',
        },
      },
      { ...identityKey, commercialScope: { ...commercialScope, channelId: 'B2B' } },
      { ...identityKey, commercialScope: { ...commercialScope, marketId: 'sk-market' } },
      { ...identityKey, currencyCode: 'EUR' },
    ];

    for (const isolatedKey of isolatedKeys) {
      expect(identityKeysEqual(exactKey, decodeIdentityKey(isolatedKey))).toBe(false);
    }
  });

  it('keeps line and whole-candidate evaluation inside one exact commercial scope', () => {
    const wholeCandidate = decodeDecision(decision);
    expect(wholeCandidate.lines).toHaveLength(2);
    expect(wholeCandidate.commercialScope).toEqual(commercialScope);

    expect(() =>
      decodeDecision({
        ...decision,
        lines: [
          {
            ...decision.lines[0],
            commercialScope: { ...commercialScope, marketId: 'foreign-market' },
          },
          decision.lines[1],
        ],
      }),
    ).toThrow();
    expect(() => decodeDecision({ ...decision, commercialScope: { ...commercialScope, marketId: '*' } })).toThrow();
  });

  it('keeps tenant Currency Support separate from the exact commercial Price key', () => {
    expect(decodeCurrencySupportRequest({ effectiveAt, tenantId })).toEqual({ effectiveAt, tenantId });

    for (const forbiddenSelector of [
      { channelId: commercialScope.channelId },
      { currencyCode: 'CZK' },
      { marketId: commercialScope.marketId },
      { sellingLegalEntityId: commercialScope.sellingLegalEntityId },
      { storefrontId: 'storefront-a' },
    ]) {
      expect(() => decodeCurrencySupportRequest({ effectiveAt, tenantId, ...forbiddenSelector })).toThrow();
    }

    const launchSupport = decodeCurrencySupport({
      completenessEvidence: {
        observedAt: effectiveAt,
        ownerRevision: '88888888-8888-4888-8888-888888888888',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: 'pricing-currency-support:tenant' },
      },
      currentnessEvidence: {
        evaluatedAt: effectiveAt,
        evaluationMode: 'CURRENT_WITH_REVALIDATION',
        observedAt: effectiveAt,
        revalidatedAt: effectiveAt,
        scheduleRevision: 1,
        supportRevisionRef: {
          moduleId: 'commerce.pricing',
          resourceId: '88888888-8888-4888-8888-888888888888',
          resourceType: 'commerce.pricing.currency-support-revision',
          supportRootId: '99999999-9999-4999-8999-999999999999',
          tenantId,
        },
        supportRootRef: {
          moduleId: 'commerce.pricing',
          resourceId: '99999999-9999-4999-8999-999999999999',
          resourceType: 'commerce.pricing.currency-support',
          tenantId,
        },
      },
      effectiveAt,
      effectivePeriod: { effectiveFrom: effectiveAt, effectiveTo: null },
      factProofs: [
        {
          factRef: '99999999-9999-4999-8999-999999999999',
          factRevisionRef: '88888888-8888-4888-8888-888888888888',
          verificationRef: 'pricing-currency-support-verification:1',
        },
      ],
      generation: 1,
      observedAt: effectiveAt,
      outcome: 'SUPPORTED_CURRENCIES_CURRENT',
      pricingRevision: 'pricing-currency-support:1',
      scheduleRevision: 1,
      supportedCurrencies: ['CZK'],
      supportRevisionRef: {
        moduleId: 'commerce.pricing',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'commerce.pricing.currency-support-revision',
        supportRootId: '99999999-9999-4999-8999-999999999999',
        tenantId,
      },
      supportRootRef: {
        moduleId: 'commerce.pricing',
        resourceId: '99999999-9999-4999-8999-999999999999',
        resourceType: 'commerce.pricing.currency-support',
        tenantId,
      },
      tenantId,
      verificationRef: 'pricing-currency-support-verification:1',
    });
    expect(launchSupport.supportedCurrencies).toEqual(['CZK']);

    expect(() =>
      decodeIdentityKey({
        ...identityKey,
        unitBasis: { ...identityKey.unitBasis, unitRef: { ...unitRef, tenantId: foreignTenantId } },
      }),
    ).toThrow();
  });
});
