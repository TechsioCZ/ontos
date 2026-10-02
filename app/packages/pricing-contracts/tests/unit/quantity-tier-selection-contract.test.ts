import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  QuantityTierSelectionFailureSchema,
  QuantityTierSelectionInputSchema,
  QuantityTierSelectionSuccessSchema,
} from '../../src/domain/quantity-tier.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const quantityBasis = {
  catalogQuantityBasis: {
    targetDivisibilityRevision: 7,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 9,
  },
  priceUnitBasis: { quantity: '1', unitRef },
};
const exactPrice = {
  path: { priceGroupSelector: { kind: 'NO_GROUP' as const }, requiredAbsenceEvidence: [] },
  price: {
    definition: {
      identityKey: {
        catalogSelection: { productRef, variantRef },
        commercialScope: {
          channelId: 'B2C',
          marketId: 'cz-launch',
          sellingLegalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: { quantity: '1', unitRef },
      },
      priceRef,
      revision: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        monetaryAmount: { amount: '100', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 3,
        revisionId: '77777777-7777-4777-8777-777777777777',
      },
    },
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    lineage: {
      correctedRevisionId: null,
      kind: 'INITIAL' as const,
      previousRevisionId: null,
    },
  },
  scheduleRevision: 5,
};

const tier = (thresholdQuantity: string, amount: string, revisionId: string) => ({
  definition: {
    identityKey: { priceRef, quantityBasis, thresholdQuantity },
    revision: {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      monetaryBoundary: 'PRE_TAX' as const,
      resultingUnitPrice: { amount, currencyCode: 'CZK' },
      revision: 1,
      revisionId,
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
});

const tenTier = tier('10', '90', '88888888-8888-4888-8888-888888888888');
const twentyTier = tier('20', '0', '99999999-9999-4999-8999-999999999999');
const completenessEvidence = {
  observedAt: '2026-09-27T10:00:00.000Z',
  ownerRevision: 'quantity-tier-set:price:33333333:r11',
  scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: 'current-tiers:price:33333333' },
};
const verificationRef = 'commerce.pricing.quantity-tier-set-proof:selection-contract';
const authority = {
  generation: 11,
  observedAt: '2026-09-27T10:00:00.000Z',
  ownerRevision: completenessEvidence.ownerRevision,
  ownerRootRef: 'quantity-tier-set:price:33333333',
  predicateRef: completenessEvidence.scope.predicateRef,
  verificationRef,
};
const factProofs = [tenTier, twentyTier].map(({ definition }, index) => ({
  factRef: `quantity-tier:${index + 1}`,
  factRevisionRef: definition.revision.revisionId,
  verificationRef,
}));
const input = {
  attempt: {
    evaluatedAt: '2026-09-27T10:00:00.000Z',
    exactPrice,
    normalizedQuantity: { quantity: '20', quantityBasis },
    tierSetPriceRef: priceRef,
  },
  tierSet: { authority, completenessEvidence, currentTiers: [tenTier, twentyTier], factProofs, priceRef },
};

describe('Pricing Quantity Tier selection contract', () => {
  it('requires one effective exact Price, compatible normalized Quantity, and owner-proven complete Tier set', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema);

    expect(decode(input)).toBeDefined();
    expect(() =>
      decode({
        ...input,
        tierSet: {
          ...input.tierSet,
          priceRef: { ...priceRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        tierSet: {
          ...input.tierSet,
          factProofs: input.tierSet.factProofs.map((proof, index) =>
            index === 0 ? { ...proof, verificationRef: 'forged-tier-set-proof' } : proof,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        attempt: {
          ...input.attempt,
          normalizedQuantity: {
            ...input.attempt.normalizedQuantity,
            quantityBasis: {
              ...quantityBasis,
              priceUnitBasis: { ...quantityBasis.priceUnitBasis, quantity: '2' },
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...input,
        attempt: {
          ...input.attempt,
          normalizedQuantity: {
            ...input.attempt.normalizedQuantity,
            quantityBasis: {
              ...quantityBasis,
              catalogQuantityBasis: {
                ...quantityBasis.catalogQuantityBasis,
                targetRef: { ...variantRef, resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
              },
            },
          },
        },
      }),
    ).toThrow();
  });

  it('uses a package option as the canonical Catalog target ahead of its Variant', () => {
    const packageOptionRef = {
      moduleId: 'commerce.catalog' as const,
      resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      resourceType: 'commerce.catalog.package-definition' as const,
      tenantId,
    };
    const packageQuantityBasis = {
      ...quantityBasis,
      catalogQuantityBasis: { ...quantityBasis.catalogQuantityBasis, targetRef: packageOptionRef },
    };
    const packageExactPrice = {
      ...exactPrice,
      price: {
        ...exactPrice.price,
        definition: {
          ...exactPrice.price.definition,
          identityKey: {
            ...exactPrice.price.definition.identityKey,
            catalogSelection: {
              ...exactPrice.price.definition.identityKey.catalogSelection,
              packageOption: {
                contentRevision: { resourceRef: packageOptionRef, revision: 5 },
                optionRef: packageOptionRef,
              },
            },
          },
        },
      },
    };
    const packageTiers = input.tierSet.currentTiers.map((currentTier) => ({
      ...currentTier,
      definition: {
        ...currentTier.definition,
        identityKey: { ...currentTier.definition.identityKey, quantityBasis: packageQuantityBasis },
      },
    }));
    const packageInput = {
      ...input,
      attempt: {
        ...input.attempt,
        exactPrice: packageExactPrice,
        normalizedQuantity: { ...input.attempt.normalizedQuantity, quantityBasis: packageQuantityBasis },
      },
      tierSet: { ...input.tierSet, currentTiers: packageTiers },
    };
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionInputSchema);

    expect(decode(packageInput)).toBeDefined();
    expect(() =>
      decode({
        ...packageInput,
        attempt: {
          ...packageInput.attempt,
          normalizedQuantity: { ...packageInput.attempt.normalizedQuantity, quantityBasis },
        },
      }),
    ).toThrow();
  });

  it('preserves the same base Price below the first threshold without inventing a zero Tier', () => {
    const belowThresholdInput = {
      ...input,
      attempt: {
        ...input.attempt,
        normalizedQuantity: { ...input.attempt.normalizedQuantity, quantity: '9' },
      },
    };
    const success = {
      appliesToQuantity: belowThresholdInput.attempt.normalizedQuantity,
      evidence: { decision: { kind: 'NO_THRESHOLD_REACHED' as const }, input: belowThresholdInput },
      monetaryBoundary: 'PRE_TAX' as const,
      outcome: 'BASE_PRICE_RETAINED' as const,
      resultingUnitPrice: { amount: '100', currencyCode: 'CZK' },
    };
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionSuccessSchema);

    expect(decode(success).outcome).toBe('BASE_PRICE_RETAINED');
    expect(() => decode({ ...success, resultingUnitPrice: { amount: '0', currencyCode: 'CZK' } })).toThrow();
  });

  it('preserves an explicit zero winner from the complete set and applies it to the whole Quantity', () => {
    const success = {
      appliesToQuantity: input.attempt.normalizedQuantity,
      evidence: {
        decision: { kind: 'HIGHEST_REACHED_THRESHOLD' as const, winningTier: twentyTier },
        input,
      },
      monetaryBoundary: 'PRE_TAX' as const,
      outcome: 'QUANTITY_TIER_APPLIED' as const,
      resultingUnitPrice: { amount: '0', currencyCode: 'CZK' },
    };
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionSuccessSchema);

    expect(decode(success).resultingUnitPrice.amount).toBe('0');
    expect(() =>
      decode({
        ...success,
        evidence: {
          ...success.evidence,
          decision: { kind: 'HIGHEST_REACHED_THRESHOLD', winningTier: tenTier },
        },
        resultingUnitPrice: { amount: '90', currencyCode: 'CZK' },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...success,
        evidence: {
          ...success.evidence,
          decision: {
            kind: 'HIGHEST_REACHED_THRESHOLD',
            winningTier: {
              ...twentyTier,
              definition: {
                ...twentyTier.definition,
                revision: {
                  ...twentyTier.definition.revision,
                  resultingUnitPrice: { amount: '1', currencyCode: 'CZK' },
                },
              },
            },
          },
        },
        resultingUnitPrice: { amount: '1', currencyCode: 'CZK' },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...success,
        evidence: {
          ...success.evidence,
          decision: {
            kind: 'HIGHEST_REACHED_THRESHOLD',
            winningTier: tier('30', '70', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          },
        },
        resultingUnitPrice: { amount: '70', currencyCode: 'CZK' },
      }),
    ).toThrow();
  });

  it('keeps incomplete, unavailable, unverifiable, stale, ambiguous, and conflicting sets typed', () => {
    const decode = Schema.decodeUnknownSync(QuantityTierSelectionFailureSchema);
    const reasons = [
      'INCOMPLETE_TIER_SET',
      'UNAVAILABLE_TIER_SET',
      'UNVERIFIABLE_TIER_SET',
      'STALE_TIER_SET',
      'AMBIGUOUS_THRESHOLD',
      'CONFLICTING_CURRENT_TIERS',
    ] as const;

    for (const reason of reasons) {
      const provenInput = reason === 'INCOMPLETE_TIER_SET' || reason === 'UNAVAILABLE_TIER_SET' ? {} : { input };
      expect(
        decode({
          attempt: input.attempt,
          candidateTierRevisionIds:
            reason === 'AMBIGUOUS_THRESHOLD' || reason === 'CONFLICTING_CURRENT_TIERS'
              ? [tenTier.definition.revision.revisionId, twentyTier.definition.revision.revisionId]
              : [],
          ...provenInput,
          outcome: 'QUANTITY_TIER_SELECTION_FAILED',
          reason,
        }).reason,
      ).toBe(reason);
    }
  });
});
