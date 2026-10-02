import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PricingCommercialFeeCurrentResolutionSchema,
  PricingCommercialFeeCurrentSetSchema,
  PricingCommercialFeeDefinitionSchema,
  PricingCommercialFeeIdentityKeySchema,
  pricingCommercialFeeCurrentSetPredicateRef,
  pricingCommercialFeeIdentityKeysEqual,
} from '../../src/domain/commercial-fee.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const commercialScope = {
  channelId: 'B2B' as const,
  marketId: 'cz-launch',
  sellingLegalEntityId: '33333333-3333-4333-8333-333333333333',
};
const identityKey = {
  calculationBasis: { kind: 'FIXED_PER_LINE' as const },
  commercialScope,
  currencyCode: 'CZK',
  family: 'RECYCLING_FEE' as const,
  monetaryBoundary: 'PRE_TAX' as const,
  target: { variantRef },
};
const observedAt = '2026-09-27T10:00:00.000Z';
const ownerRevision = 'commercial-fees:revision:42';
const predicateRef = pricingCommercialFeeCurrentSetPredicateRef({
  commercialScope,
  currencyCode: 'CZK',
  target: { variantRef },
});
const exactEvidence = {
  completenessEvidence: {
    observedAt,
    ownerRevision,
    scope: { kind: 'EXACT_PREDICATE' as const, predicateRef },
  },
  currentnessEvidence: {
    observedAt,
    ownerRevision,
    predicateRef,
    revalidatedAt: '2026-09-27T10:00:00.001Z',
    verificationMode: 'OWNER_CURRENT_SET_REVALIDATED' as const,
  },
};

describe('Pricing Commercial Fee review regressions', () => {
  it('uses Variant, not Product admin evidence, as canonical Fee identity and conflict meaning', () => {
    const decodeIdentity = Schema.decodeUnknownSync(PricingCommercialFeeIdentityKeySchema, {
      onExcessProperty: 'error',
    });
    const firstAdminTarget = {
      productRef: {
        moduleId: 'commerce.catalog',
        resourceId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'commerce.catalog.product',
        tenantId,
      },
      variantRef,
    };
    const secondAdminTarget = {
      productRef: {
        ...firstAdminTarget.productRef,
        resourceId: '55555555-5555-4555-8555-555555555555',
      },
      variantRef,
    };
    const fromFirstProduct = decodeIdentity({ ...identityKey, target: { variantRef: firstAdminTarget.variantRef } });
    const fromSecondProduct = decodeIdentity({ ...identityKey, target: { variantRef: secondAdminTarget.variantRef } });
    const definitionFor = (productRef: typeof firstAdminTarget.productRef, targetId: string) =>
      Schema.decodeUnknownSync(PricingCommercialFeeDefinitionSchema)({
        catalogTargetEvidence: {
          capturedAt: observedAt,
          catalogOwnerRevision: 'catalog-products:42',
          productRef,
          snapshotId: 'commercial-fee-admin:snapshot:42',
          targetId,
          variantRef,
        },
        feeRef: {
          moduleId: 'commerce.pricing',
          resourceId: '88888888-8888-4888-8888-888888888888',
          resourceType: 'commerce.pricing.commercial-fee',
          tenantId,
        },
        identityKey,
        revision: {
          configuredAmount: { amount: '20', currencyCode: 'CZK' },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          revision: 1,
          revisionId: '99999999-9999-4999-8999-999999999999',
        },
      });
    const firstDefinition = definitionFor(firstAdminTarget.productRef, 'commercial-fee-admin:target:first');
    const secondDefinition = definitionFor(secondAdminTarget.productRef, 'commercial-fee-admin:target:second');

    expect(firstAdminTarget.productRef).not.toEqual(secondAdminTarget.productRef);
    expect(firstDefinition.catalogTargetEvidence.productRef).not.toEqual(
      secondDefinition.catalogTargetEvidence.productRef,
    );
    expect(pricingCommercialFeeIdentityKeysEqual(firstDefinition.identityKey, secondDefinition.identityKey)).toBe(true);
    expect(pricingCommercialFeeIdentityKeysEqual(fromFirstProduct, fromSecondProduct)).toBe(true);
    expect(() => decodeIdentity({ ...identityKey, target: firstAdminTarget })).toThrow();
    expect(
      Schema.decodeSync(PricingCommercialFeeCurrentResolutionSchema)({
        candidateRevisionIds: ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'],
        identityKey: fromFirstProduct,
        observedAt,
        outcome: 'COMMERCIAL_FEE_CURRENT_CONFLICT',
      }).outcome,
    ).toBe('COMMERCIAL_FEE_CURRENT_CONFLICT');
  });

  it('accepts empty Current Fee absence only with exact owner-bound predicate and fresh currentness', () => {
    const decode = Schema.decodeUnknownSync(PricingCommercialFeeCurrentSetSchema);
    const provenAbsent = {
      commercialScope,
      currencyCode: 'CZK',
      ...exactEvidence,
      fees: [],
      observedAt,
      target: { variantRef },
    };

    expect(decode(provenAbsent).fees).toEqual([]);
    expect(() =>
      decode({
        ...provenAbsent,
        completenessEvidence: {
          ...provenAbsent.completenessEvidence,
          scope: { kind: 'EXACT_PREDICATE', predicateRef: 'commercial-fees:some-other-variant' },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...provenAbsent,
        currentnessEvidence: {
          ...provenAbsent.currentnessEvidence,
          ownerRevision: 'commercial-fees:unrelated-revision',
        },
      }),
    ).toThrow();
  });
});
