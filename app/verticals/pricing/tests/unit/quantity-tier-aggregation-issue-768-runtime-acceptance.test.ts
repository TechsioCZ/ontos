import {
  QuantityTierAggregationRequestSchema,
  QuantityTierAggregationSuccessSchema,
} from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { aggregateQuantityTierLines } from '../../src/services/quantity-tier-aggregation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const otherProductRef = {
  ...productRef,
  resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const otherVariantRef = {
  ...variantRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
};
const otherVariantModuleRef = {
  ...variantRef,
  moduleId: 'commerce.catalog.shadow' as const,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const packageRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.catalog.package-definition' as const,
  tenantId,
};
const otherPackageRef = {
  ...packageRef,
  resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const candidateRef = 'purchase-candidate:42';
const evaluatedAt = '2026-09-27T12:00:00.000Z';
const effectiveFrom = '2026-09-01T00:00:00.000Z';

const selection = (
  chosenVariant: typeof variantRef | typeof otherVariantRef | typeof otherVariantModuleRef = variantRef,
  packageRevision?: number,
  chosenProduct: typeof productRef | typeof otherProductRef = productRef,
  chosenPackage: typeof packageRef | typeof otherPackageRef = packageRef,
) =>
  packageRevision === undefined
    ? { productRef: chosenProduct, variantRef: chosenVariant }
    : {
        packageOption: {
          contentRevision: { resourceRef: chosenPackage, revision: packageRevision },
          optionRef: chosenPackage,
        },
        productRef: chosenProduct,
        variantRef: chosenVariant,
      };

const catalogEvidenceFor = (exactSelection: ReturnType<typeof selection>) => ({
  assessedAt: '2026-09-27T11:00:00.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: exactSelection.productRef, revision: 3 } },
    { role: 'VARIANT' as const, source: { resourceRef: exactSelection.variantRef, revision: 7 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: exactSelection.productRef, revision: 3 },
    },
    ...('packageOption' in exactSelection
      ? [{ role: 'PACKAGE_CONTENT' as const, source: exactSelection.packageOption.contentRevision }]
      : []),
  ],
  membership: {
    attestationId: '88888888-8888-4888-8888-888888888888',
    observedAt: '2026-09-27T11:00:00.000Z',
    productRef: exactSelection.productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: exactSelection.variantRef, revision: 7 },
  },
  purpose: 'PRICING' as const,
  selection: exactSelection,
  status: 'VALID' as const,
});

const line = (occurrenceId: string, exactSelection: ReturnType<typeof selection>) => {
  const targetRef =
    'packageOption' in exactSelection ? exactSelection.packageOption.optionRef : exactSelection.variantRef;
  return {
    catalog: {
      completeness: {
        observedAt: '2026-09-27T11:00:00.000Z',
        ownerRevision: 'catalog-quantity:17',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `quantity:${occurrenceId}` },
      },
      divisible: false,
      equivalentSelectionKey: `pricing-purpose:${variantRef.resourceId}`,
      evidence: catalogEvidenceFor(exactSelection),
      hierarchyRevision: 'catalog-hierarchy:9',
      ownerRevision: 'catalog-quantity:17',
      quantity: {
        changed: false,
        notice: null,
        requested: '5',
        resulting: '5',
        rounding: 'HALF_UP' as const,
        status: 'VALID' as const,
        step: '1',
        targetId: targetRef.resourceId,
        tenantId,
        unitId: unitRef.resourceId,
        unitRuleRevision: 5,
      },
      quantityBasis: {
        targetDivisibilityRevision: 3,
        targetRef,
        unitRef,
        unitRuleRevision: 5,
      },
      selection: exactSelection,
      status: 'READY' as const,
      unitRef,
    },
    occurrenceId,
    pricingBasis: { quantity: '1', unitRef },
  };
};

const exactPriceFor = (
  exactSelection: ReturnType<typeof selection>,
  currencyCode: 'CZK' | 'EUR',
  exactPriceRef = priceRef,
) => ({
  path: { priceGroupSelector: { kind: 'NO_GROUP' as const }, requiredAbsenceEvidence: [] },
  price: {
    definition: {
      identityKey: {
        catalogSelection: exactSelection,
        commercialScope: {
          channelId: 'B2C',
          marketId: 'cz-launch',
          sellingLegalEntityId: '99999999-9999-4999-8999-999999999999',
        },
        currencyCode,
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: { quantity: '1', unitRef },
      },
      priceRef: exactPriceRef,
      revision: {
        effectiveFrom,
        monetaryAmount: { amount: '100', currencyCode },
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 1,
        revisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    },
    effectivePeriod: { effectiveFrom, effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
  },
  scheduleRevision: 1,
});

const rawRequest = (
  lineSelections: readonly [ReturnType<typeof selection>, ReturnType<typeof selection>] = [selection(), selection()],
  currencyCode: 'CZK' | 'EUR' = 'CZK',
  sharedPriceSelection: ReturnType<typeof selection> = lineSelections[0],
) => {
  const lines = [line('line-A', lineSelections[0]), line('line-B', lineSelections[1])] as const;
  const [firstLine] = lines;
  const exactPrice = exactPriceFor(sharedPriceSelection, currencyCode);
  const quantityBasis = {
    catalogQuantityBasis: firstLine.catalog.quantityBasis,
    priceUnitBasis: { quantity: '1', unitRef },
  };
  const participants = lines.map((recipientLine) => ({
    candidateRef,
    exactPrice,
    line: recipientLine,
    normalizedQuantity: { quantity: '5', quantityBasis },
  }));
  const evidence = {
    anchorSelection: sharedPriceSelection,
    assessmentId: 'catalog-pricing-equivalence:42',
    effectiveAt: evaluatedAt,
    members: participants.map(({ line: participantLine }) => ({
      occurrenceId: participantLine.occurrenceId,
      selection: participantLine.catalog.selection,
    })),
    observedAt: '2026-09-27T12:00:30.000Z',
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-equivalence:42',
    purpose: 'PRICING' as const,
    status: 'CONFIRMED' as const,
    validThrough: '2026-09-27T12:01:00.000Z',
  };
  return {
    attempt: {
      candidate: {
        commercialScope: exactPrice.price.definition.identityKey.commercialScope,
        currencyCode,
        lines,
        monetaryBoundary: 'PRE_TAX' as const,
        operationTime: evaluatedAt,
        purchasingContext: {
          accessDecision: { decisionRef: 'candidate-access:42', decisionRevision: 'candidate-access-revision:42' },
          actor: { kind: 'PRINCIPAL' as const, principalId: 'pricing-principal:42' },
          commercialSettingsDecision: {
            decisionRef: 'candidate-commercial-settings:42',
            decisionRevision: 'candidate-commercial-settings-revision:42',
          },
          contextRef: candidateRef,
          contextRevision: 'candidate-revision:7',
          currencyResolution: {
            currencyCode,
            resolutionRef: 'candidate-currency-resolution:42',
            resolutionRevision: 'candidate-currency-resolution-revision:42',
          },
          subject: {
            authorizationSubject: { kind: 'RETAIL' as const },
            kind: 'PROFILE' as const,
            profileRef: {
              moduleId: 'commerce.customer-context' as const,
              resourceId: 'customer-profile:42',
              resourceType: 'commerce.customer-context.retail-customer-profile' as const,
              tenantId,
            },
          },
        },
        tenantId,
      },
      candidateRef,
      evaluatedAt,
      participants,
    },
    catalogEquivalence: {
      evidence,
      outcome: 'CATALOG_EQUIVALENCE_CONFIRMED' as const,
    },
  };
};

const decodeRequest = Schema.decodeUnknownSync(QuantityTierAggregationRequestSchema, {
  onExcessProperty: 'error',
});
const decodeSuccess = Schema.decodeUnknownSync(QuantityTierAggregationSuccessSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Quantity Tier aggregation #768 runtime acceptance', () => {
  it.effect('aggregates A5+B5 to 10 and preserves the two stable recipients', () =>
    Effect.gen(function* aggregatesExactGroup() {
      const result = yield* aggregateQuantityTierLines(decodeRequest(rawRequest()));

      expect(result).toMatchObject({
        aggregatedQuantity: { quantity: '10' },
        outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
      });
      if (result.outcome !== 'QUANTITY_TIER_QUANTITY_AGGREGATED') {
        return;
      }
      expect(decodeSuccess(result)).toEqual(result);
      expect(result.recipientLines.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-A', 'line-B']);
      expect(result).not.toHaveProperty('feeRecipients');
      expect(result).not.toHaveProperty('discountRecipients');
      expect(result).not.toHaveProperty('roundingRecipients');
      expect(result).not.toHaveProperty('wholePurchaseBenefitCopies');
    }),
  );

  it.effect('accepts a later honest owner observation evaluated exactly as of the purchase instant', () =>
    Effect.gen(function* acceptsLaterObservation() {
      const request = decodeRequest(rawRequest());
      if (request.catalogEquivalence.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
        return;
      }

      expect(request.catalogEquivalence.evidence.effectiveAt).toBe(request.attempt.evaluatedAt);
      expect(request.catalogEquivalence.evidence.observedAt > request.attempt.evaluatedAt).toBe(true);
      expect(yield* aggregateQuantityTierLines(request)).toMatchObject({
        aggregatedQuantity: { quantity: '10' },
        outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
      });
    }),
  );

  it.effect('does not pool different Variants merely because they share a Product', () =>
    Effect.gen(function* rejectsProductOnlyGrouping() {
      const request = rawRequest([selection(), selection(otherVariantRef)]);
      const result = yield* aggregateQuantityTierLines(decodeRequest(request));

      expect(result).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        participantOccurrenceIds: ['line-A', 'line-B'],
        reason: 'PRICE_IDENTITY_MISMATCH',
      });
    }),
  );

  it.effect('does not pool different exact Prices or purchase candidates', () =>
    Effect.gen(function* rejectsDifferentPriceOrCandidate() {
      const request = decodeRequest(rawRequest());
      const [first, second] = request.attempt.participants;
      if (second === undefined) {
        return;
      }
      const differentPrice = {
        ...request,
        attempt: {
          ...request.attempt,
          participants: [
            first,
            {
              ...second,
              exactPrice: exactPriceFor(selection(), 'CZK', {
                ...priceRef,
                resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              }),
            },
          ],
        },
      };
      const differentCandidate = {
        ...request,
        attempt: {
          ...request.attempt,
          participants: [first, { ...second, candidateRef: 'purchase-candidate:other' }],
        },
      };

      expect(yield* aggregateQuantityTierLines(decodeRequest(differentPrice))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'PRICE_IDENTITY_MISMATCH',
      });
      expect(yield* aggregateQuantityTierLines(decodeRequest(differentCandidate))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'PURCHASE_CANDIDATE_MISMATCH',
      });
    }),
  );

  it.effect('requires exact Current owner equivalence for material Package revisions', () =>
    Effect.gen(function* validatesPackageEquivalence() {
      const packageFive = selection(variantRef, 5);
      const packageSix = selection(variantRef, 6);
      const request = decodeRequest(rawRequest([packageFive, packageSix], 'CZK', packageFive));
      const confirmed = yield* aggregateQuantityTierLines(request);
      expect(confirmed).toMatchObject({
        aggregatedQuantity: { quantity: '10' },
        outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
      });

      if (request.catalogEquivalence.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
        return;
      }
      if (confirmed.outcome !== 'QUANTITY_TIER_QUANTITY_AGGREGATED') {
        return;
      }
      expect(decodeSuccess(confirmed)).toEqual(confirmed);
      const staleMember = {
        ...request,
        catalogEquivalence: {
          ...request.catalogEquivalence,
          evidence: {
            ...request.catalogEquivalence.evidence,
            members: [
              request.catalogEquivalence.evidence.members[0],
              { occurrenceId: 'line-B', selection: packageFive },
            ],
          },
        },
      };
      const staleTime = {
        ...request,
        catalogEquivalence: {
          ...request.catalogEquivalence,
          evidence: {
            ...request.catalogEquivalence.evidence,
            effectiveAt: '2026-09-27T11:58:00.000Z',
            validThrough: '2026-09-27T11:59:00.000Z',
          },
        },
      };

      expect(yield* aggregateQuantityTierLines(decodeRequest(staleMember))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'CATALOG_EQUIVALENCE_MISMATCH',
      });
      expect(yield* aggregateQuantityTierLines(decodeRequest(staleTime))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'STALE_CATALOG_EQUIVALENCE',
      });
    }),
  );

  it.effect('preserves typed unavailable and unverifiable owner outcomes', () =>
    Effect.gen(function* preservesOwnerFailures() {
      const { attempt } = decodeRequest(rawRequest());
      const unavailable = yield* aggregateQuantityTierLines({
        attempt,
        catalogEquivalence: { outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' },
      });
      const unverifiable = yield* aggregateQuantityTierLines({
        attempt,
        catalogEquivalence: {
          evidenceRef: 'catalog-equivalence:unverifiable',
          outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        },
      });

      expect(unavailable).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'CATALOG_EQUIVALENCE_UNAVAILABLE',
      });
      expect(unverifiable).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
      });
    }),
  );

  it.effect('invalidates changed line structure instead of reusing aggregation evidence', () =>
    Effect.gen(function* rejectsChangedRecipient() {
      const request = decodeRequest(rawRequest());
      const [first, second] = request.attempt.participants;
      if (second === undefined) {
        return;
      }
      const changedLine = {
        ...second.line,
        catalog: {
          ...second.line.catalog,
          ownerRevision: 'catalog-quantity:18',
        },
      };
      const result = yield* aggregateQuantityTierLines(
        decodeRequest({
          ...request,
          attempt: {
            ...request.attempt,
            participants: [first, { ...second, line: changedLine }],
          },
        }),
      );

      expect(result).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        participantOccurrenceIds: ['line-A', 'line-B'],
        reason: 'RECIPIENT_STRUCTURE_MISMATCH',
      });
    }),
  );

  it.effect('refuses mismatched Product, Variant module, package option, and normalized Catalog target bindings', () =>
    Effect.gen(function* rejectsEveryCanonicalTargetMismatch() {
      const mismatchedProduct = decodeRequest(
        rawRequest([selection(), selection(variantRef, undefined, otherProductRef)]),
      );
      expect(() => decodeRequest(rawRequest([selection(), selection(otherVariantModuleRef)]))).toThrow();
      const packageOne = selection(variantRef, 5);
      const otherPackage = selection(variantRef, 5, productRef, otherPackageRef);
      const mismatchedPackage = decodeRequest(rawRequest([packageOne, otherPackage], 'CZK', packageOne));

      const targetRequest = decodeRequest(rawRequest());
      const normalizedTarget = {
        ...targetRequest,
        attempt: {
          ...targetRequest.attempt,
          participants: targetRequest.attempt.participants.map((participant) => ({
            ...participant,
            normalizedQuantity: {
              ...participant.normalizedQuantity,
              quantityBasis: {
                ...participant.normalizedQuantity.quantityBasis,
                catalogQuantityBasis: {
                  ...participant.normalizedQuantity.quantityBasis.catalogQuantityBasis,
                  targetRef: otherVariantRef,
                },
              },
            },
          })),
        },
      };

      for (const request of [mismatchedProduct, mismatchedPackage]) {
        expect(yield* aggregateQuantityTierLines(request)).toMatchObject({
          outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
          reason: 'PRICE_IDENTITY_MISMATCH',
        });
      }
      expect(yield* aggregateQuantityTierLines(decodeRequest(normalizedTarget))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'INCOMPATIBLE_QUANTITY_BASIS',
      });
    }),
  );

  it.effect('keeps generalized native EUR exact and refuses cross-currency pooling without FX', () =>
    Effect.gen(function* preservesNativeCurrency() {
      const eurRequest = decodeRequest(rawRequest(undefined, 'EUR'));
      const eur = yield* aggregateQuantityTierLines(eurRequest);
      expect(eur).toMatchObject({ outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED' });
      if (eur.outcome !== 'QUANTITY_TIER_QUANTITY_AGGREGATED') {
        return;
      }
      expect(decodeSuccess(eur)).toEqual(eur);
      expect(eur.evidence.currentness.candidate.currencyCode).toBe('EUR');
      expect(eur.evidence.currentness.exactPrice.price.definition.identityKey.currencyCode).toBe('EUR');
      expect(eur.evidence).not.toHaveProperty('exchangeRate');

      const czkRequest = decodeRequest(rawRequest());
      const [first, second] = czkRequest.attempt.participants;
      if (second === undefined) {
        return;
      }
      const crossCurrency = {
        ...czkRequest,
        attempt: {
          ...czkRequest.attempt,
          participants: [first, { ...second, exactPrice: exactPriceFor(selection(), 'EUR') }],
        },
      };
      expect(yield* aggregateQuantityTierLines(decodeRequest(crossCurrency))).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'CURRENCY_MISMATCH',
      });
    }),
  );
});
