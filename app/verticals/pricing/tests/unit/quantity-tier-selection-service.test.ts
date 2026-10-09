import { PackageDefinitionSelectionRevisionSchema } from '@app/catalog/domain/catalog-selection-evidence';
import {
  QuantityTierIdentityKeySchema,
  QuantityTierSelectionInputSchema,
  ScheduledQuantityTierRevisionSchema,
} from '@app/pricing-contracts/domain/quantity-tier';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  resolveHighestReachedQuantityTier,
  selectQuantityTier,
} from '../../src/services/quantity-tier-selection.service.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const baseIdentity = Schema.decodeSync(QuantityTierIdentityKeySchema)({
  priceRef,
  quantityBasis: {
    catalogQuantityBasis: {
      targetDivisibilityRevision: 7,
      targetRef: {
        moduleId: 'commerce.catalog',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.catalog.variant',
        tenantId,
      },
      unitRef,
      unitRuleRevision: 9,
    },
    priceUnitBasis: { quantity: '1', unitRef },
  },
  thresholdQuantity: '10',
});

const tier = (threshold: string, amount: string, revisionId: string) =>
  Schema.decodeSync(ScheduledQuantityTierRevisionSchema)({
    definition: {
      identityKey: { ...baseIdentity, thresholdQuantity: threshold },
      revision: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        monetaryBoundary: 'PRE_TAX',
        resultingUnitPrice: { amount, currencyCode: 'CZK' },
        revision: 1,
        revisionId,
      },
    },
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
  });

describe('Quantity Tier threshold resolver', () => {
  const ten = tier('10', '90', '77777777-7777-4777-8777-777777777777');
  const twenty = tier('20', '80', '88888888-8888-4888-8888-888888888888');

  it('retains the base path below the first threshold and includes each exact threshold', () => {
    expect(resolveHighestReachedQuantityTier('9.999999999', [twenty, ten])).toEqual({
      outcome: 'NO_THRESHOLD_REACHED',
    });
    expect(resolveHighestReachedQuantityTier('10', [twenty, ten])).toMatchObject({
      outcome: 'HIGHEST_REACHED_THRESHOLD',
      winningTier: ten,
    });
    expect(resolveHighestReachedQuantityTier('20.000000000', [ten, twenty])).toMatchObject({
      outcome: 'HIGHEST_REACHED_THRESHOLD',
      winningTier: twenty,
    });
  });

  it('selects the greatest reached threshold exactly beyond binary and safe-integer precision', () => {
    const lower = tier('9007199254740992.999999998', '70', '99999999-9999-4999-8999-999999999999');
    const higher = tier('9007199254740992.999999999', '60', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    expect(resolveHighestReachedQuantityTier('9007199254740992.999999999', [lower, higher])).toMatchObject({
      outcome: 'HIGHEST_REACHED_THRESHOLD',
      winningTier: higher,
    });
  });

  it('rejects every duplicate numeric threshold before considering base-price fallback', () => {
    const sameEffect = tier('10.0', '90.0', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const conflictingEffect = tier('10.00', '89', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');

    expect(resolveHighestReachedQuantityTier('1', [ten, sameEffect])).toMatchObject({
      outcome: 'AMBIGUOUS_THRESHOLD',
    });
    expect(resolveHighestReachedQuantityTier('1', [ten, conflictingEffect])).toMatchObject({
      outcome: 'CONFLICTING_CURRENT_TIERS',
    });
  });
});

const exactPrice = {
  definition: {
    identityKey: {
      catalogSelection: {
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: '44444444-4444-4444-8444-444444444444',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        variantRef: baseIdentity.quantityBasis.catalogQuantityBasis.targetRef,
      },
      commercialScope: {
        channelId: 'B2C',
        marketId: 'cz-launch',
        sellingLegalEntityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      currencyCode: 'CZK',
      priceGroupSelector: { kind: 'NO_GROUP' },
      unitBasis: baseIdentity.quantityBasis.priceUnitBasis,
    },
    priceRef,
    revision: {
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      monetaryAmount: { amount: '100', currencyCode: 'CZK' },
      monetaryBoundary: 'PRE_TAX',
      revision: 1,
      revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    },
  },
  effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
};

const selectionInput = (quantity: string) =>
  Schema.decodeUnknownSync(QuantityTierSelectionInputSchema)({
    attempt: {
      evaluatedAt: '2026-09-27T12:00:00.000Z',
      exactPrice: {
        path: { priceGroupSelector: { kind: 'NO_GROUP' }, requiredAbsenceEvidence: [] },
        price: exactPrice,
        scheduleRevision: 1,
      },
      normalizedQuantity: { quantity, quantityBasis: baseIdentity.quantityBasis },
      tierSetPriceRef: priceRef,
    },
    tierSet: {
      authority: {
        generation: 42,
        observedAt: '2026-09-27T12:00:00.000Z',
        ownerRevision: 'quantity-tiers:42',
        ownerRootRef: `quantity-tier-set:${priceRef.resourceId}`,
        predicateRef: `current-tiers:${priceRef.resourceId}`,
        verificationRef: 'commerce.pricing.quantity-tier-set-proof:42',
      },
      completenessEvidence: {
        nextApplicabilityBoundary: '2026-10-01T00:00:00.000Z',
        observedAt: '2026-09-27T12:00:00.000Z',
        ownerRevision: 'quantity-tiers:42',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: `current-tiers:${priceRef.resourceId}` },
      },
      currentTiers: [
        tier('10', '90', '77777777-7777-4777-8777-777777777777'),
        tier('20', '80', '88888888-8888-4888-8888-888888888888'),
      ],
      factProofs: ['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'].map(
        (factRevisionRef, index) => ({
          factRef: `quantity-tier:${index + 1}`,
          factRevisionRef,
          verificationRef: 'commerce.pricing.quantity-tier-set-proof:42',
        }),
      ),
      priceRef,
    },
  });

describe('Quantity Tier selection service', () => {
  it.effect('retains the same exact base Price below the first threshold', () =>
    Effect.gen(function* retainBasePrice() {
      const input = selectionInput('9');
      const result = yield* selectQuantityTier({ input, outcome: 'TIER_SET_CURRENT' });

      expect(result).toMatchObject({
        appliesToQuantity: input.attempt.normalizedQuantity,
        evidence: { decision: { kind: 'NO_THRESHOLD_REACHED' }, input },
        monetaryBoundary: 'PRE_TAX',
        outcome: 'BASE_PRICE_RETAINED',
        resultingUnitPrice: { amount: '100', currencyCode: 'CZK' },
      });
    }),
  );

  it.effect('applies the highest reached threshold to the entire normalized Quantity', () =>
    Effect.gen(function* appliesOneTierToAllQuantity() {
      const input = selectionInput('21');
      const result = yield* selectQuantityTier({ input, outcome: 'TIER_SET_CURRENT' });

      expect(result).toMatchObject({
        appliesToQuantity: input.attempt.normalizedQuantity,
        evidence: {
          decision: {
            kind: 'HIGHEST_REACHED_THRESHOLD',
            winningTier: { definition: { identityKey: { thresholdQuantity: '20' } } },
          },
        },
        outcome: 'QUANTITY_TIER_APPLIED',
        resultingUnitPrice: { amount: '80', currencyCode: 'CZK' },
      });
      expect(result).not.toHaveProperty('bands');
      expect(result).not.toHaveProperty('allocations');
    }),
  );

  it.effect('preserves unavailable, incomplete, and unverifiable owner evidence as typed failures', () =>
    Effect.gen(function* preservesAcquisitionFailures() {
      const { attempt } = selectionInput('10');
      const unavailable = yield* selectQuantityTier({ attempt, outcome: 'TIER_SET_UNAVAILABLE' });
      const incomplete = yield* selectQuantityTier({ attempt, outcome: 'TIER_SET_INCOMPLETE' });
      const unverifiable = yield* selectQuantityTier({ attempt, outcome: 'TIER_SET_UNVERIFIABLE' });

      expect(unavailable).toMatchObject({ outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'UNAVAILABLE_TIER_SET' });
      expect(incomplete).toMatchObject({ outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'INCOMPLETE_TIER_SET' });
      expect(unverifiable).toMatchObject({
        outcome: 'QUANTITY_TIER_SELECTION_FAILED',
        reason: 'UNVERIFIABLE_TIER_SET',
      });
      expect(unavailable).not.toHaveProperty('resultingUnitPrice');
    }),
  );

  it.effect('fails closed on stale Currentness, Price binding, basis, and currency mismatch', () =>
    Effect.gen(function* rejectsIncompatibleEvidence() {
      const input = selectionInput('10');
      const [firstTier, ...remainingTiers] = input.tierSet.currentTiers;
      if (firstTier === undefined) {
        return;
      }
      const stale = yield* selectQuantityTier({
        input: {
          ...input,
          tierSet: {
            ...input.tierSet,
            currentTiers: [
              {
                ...firstTier,
                effectivePeriod: { ...firstTier.effectivePeriod, effectiveTo: '2026-09-27T11:00:00.000Z' },
              },
              ...remainingTiers,
            ],
          },
        },
        outcome: 'TIER_SET_CURRENT',
      });
      const wrongPrice = yield* selectQuantityTier({
        input: {
          ...input,
          tierSet: {
            ...input.tierSet,
            priceRef: { ...input.tierSet.priceRef, resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
          },
        },
        outcome: 'TIER_SET_CURRENT',
      });
      const wrongBasis = yield* selectQuantityTier({
        input: {
          ...input,
          tierSet: {
            ...input.tierSet,
            currentTiers: [
              {
                ...firstTier,
                definition: {
                  ...firstTier.definition,
                  identityKey: {
                    ...firstTier.definition.identityKey,
                    quantityBasis: {
                      ...firstTier.definition.identityKey.quantityBasis,
                      priceUnitBasis: {
                        ...firstTier.definition.identityKey.quantityBasis.priceUnitBasis,
                        quantity: '2',
                      },
                    },
                  },
                },
              },
              ...remainingTiers,
            ],
          },
        },
        outcome: 'TIER_SET_CURRENT',
      });
      const wrongCurrency = yield* selectQuantityTier({
        input: {
          ...input,
          tierSet: {
            ...input.tierSet,
            currentTiers: [
              {
                ...firstTier,
                definition: {
                  ...firstTier.definition,
                  revision: {
                    ...firstTier.definition.revision,
                    resultingUnitPrice: {
                      ...firstTier.definition.revision.resultingUnitPrice,
                      currencyCode: 'EUR',
                    },
                  },
                },
              },
              ...remainingTiers,
            ],
          },
        },
        outcome: 'TIER_SET_CURRENT',
      });

      expect(stale).toMatchObject({ outcome: 'QUANTITY_TIER_SELECTION_FAILED', reason: 'STALE_TIER_SET' });
      expect(wrongPrice).toMatchObject({
        outcome: 'QUANTITY_TIER_SELECTION_FAILED',
        reason: 'PRICE_BINDING_MISMATCH',
      });
      expect(wrongBasis).toMatchObject({
        outcome: 'QUANTITY_TIER_SELECTION_FAILED',
        reason: 'INCOMPATIBLE_QUANTITY_BASIS',
      });
      expect(wrongCurrency).toMatchObject({
        outcome: 'QUANTITY_TIER_SELECTION_FAILED',
        reason: 'CURRENCY_MISMATCH',
      });
    }),
  );

  it.effect('binds Quantity evidence to the Price canonical Catalog target before Tier or base selection', () =>
    Effect.gen(function* rejectsDifferentCatalogTargets() {
      const differentTarget = {
        ...baseIdentity.quantityBasis.catalogQuantityBasis.targetRef,
        resourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      };
      const withTarget = (quantity: string) => {
        const input = selectionInput(quantity);
        return {
          ...input,
          attempt: {
            ...input.attempt,
            normalizedQuantity: {
              ...input.attempt.normalizedQuantity,
              quantityBasis: {
                ...input.attempt.normalizedQuantity.quantityBasis,
                catalogQuantityBasis: {
                  ...input.attempt.normalizedQuantity.quantityBasis.catalogQuantityBasis,
                  targetRef: differentTarget,
                },
              },
            },
          },
          tierSet: {
            ...input.tierSet,
            currentTiers: input.tierSet.currentTiers.map((currentTier) => ({
              ...currentTier,
              definition: {
                ...currentTier.definition,
                identityKey: {
                  ...currentTier.definition.identityKey,
                  quantityBasis: {
                    ...currentTier.definition.identityKey.quantityBasis,
                    catalogQuantityBasis: {
                      ...currentTier.definition.identityKey.quantityBasis.catalogQuantityBasis,
                      targetRef: differentTarget,
                    },
                  },
                },
              },
            })),
          },
        };
      };

      const belowFirstThreshold = yield* selectQuantityTier({
        input: withTarget('9'),
        outcome: 'TIER_SET_CURRENT',
      });
      const reachedThreshold = yield* selectQuantityTier({
        input: withTarget('20'),
        outcome: 'TIER_SET_CURRENT',
      });

      const packageInput = selectionInput('20');
      const optionRef = {
        ...packageInput.attempt.exactPrice.price.definition.identityKey.catalogSelection.variantRef,
        resourceId: '12121212-1212-4212-8212-121212121212',
        resourceType: 'commerce.catalog.package-definition' as const,
      };
      const contentRevision = yield* Schema.decodeEffect(PackageDefinitionSelectionRevisionSchema)({
        resourceRef: optionRef,
        revision: 1,
      });
      const variantInsteadOfPackage = yield* selectQuantityTier({
        input: {
          ...packageInput,
          attempt: {
            ...packageInput.attempt,
            exactPrice: {
              ...packageInput.attempt.exactPrice,
              price: {
                ...packageInput.attempt.exactPrice.price,
                definition: {
                  ...packageInput.attempt.exactPrice.price.definition,
                  identityKey: {
                    ...packageInput.attempt.exactPrice.price.definition.identityKey,
                    catalogSelection: {
                      ...packageInput.attempt.exactPrice.price.definition.identityKey.catalogSelection,
                      packageOption: {
                        contentRevision,
                        optionRef,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        outcome: 'TIER_SET_CURRENT',
      });

      for (const result of [belowFirstThreshold, reachedThreshold, variantInsteadOfPackage]) {
        expect(result).toMatchObject({
          outcome: 'QUANTITY_TIER_SELECTION_FAILED',
          reason: 'INCOMPATIBLE_QUANTITY_BASIS',
        });
        expect(result).not.toHaveProperty('resultingUnitPrice');
      }
    }),
  );
});
