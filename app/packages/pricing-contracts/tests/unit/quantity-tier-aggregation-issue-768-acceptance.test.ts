import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { QuantityTierAggregationInput } from '../../src/domain/quantity-tier-aggregation.ts';
import {
  QuantityTierAggregationInputSchema,
  QuantityTierAggregationRequestSchema,
  QuantityTierAggregationSuccessSchema,
} from '../../src/domain/quantity-tier-aggregation.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const packageRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.package-definition' as const,
  tenantId,
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const evaluatedAt = '2026-09-27T12:00:00.000Z';
const effectiveFrom = '2026-09-01T00:00:00.000Z';
const candidateRef = 'purchase-candidate:42';

const selection = (packageRevision?: number) =>
  packageRevision === undefined
    ? { productRef, variantRef }
    : {
        packageOption: {
          contentRevision: { resourceRef: packageRef, revision: packageRevision },
          optionRef: packageRef,
        },
        productRef,
        variantRef,
      };

const catalogEvidenceFor = (exactSelection: ReturnType<typeof selection>) => ({
  assessedAt: '2026-09-27T11:00:00.000Z',
  basis: [
    { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 3 } },
    { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 7 } },
    {
      provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
      role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
      source: { resourceRef: productRef, revision: 3 },
    },
    ...('packageOption' in exactSelection
      ? [{ role: 'PACKAGE_CONTENT' as const, source: exactSelection.packageOption.contentRevision }]
      : []),
  ],
  membership: {
    attestationId: '77777777-7777-4777-8777-777777777777',
    observedAt: '2026-09-27T11:00:00.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 7 },
  },
  purpose: 'PRICING' as const,
  selection: exactSelection,
  status: 'VALID' as const,
});

const line = (occurrenceId: string, exactSelection = selection()) => ({
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
      targetId: ('packageOption' in exactSelection ? exactSelection.packageOption.optionRef : variantRef).resourceId,
      tenantId,
      unitId: unitRef.resourceId,
      unitRuleRevision: 5,
    },
    quantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: 'packageOption' in exactSelection ? exactSelection.packageOption.optionRef : variantRef,
      unitRef,
      unitRuleRevision: 5,
    },
    selection: exactSelection,
    status: 'READY' as const,
    unitRef,
  },
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});

const exactPriceFor = (exactSelection = selection(), currencyCode: 'CZK' | 'EUR' = 'CZK') => ({
  path: { priceGroupSelector: { kind: 'NO_GROUP' as const }, requiredAbsenceEvidence: [] },
  price: {
    definition: {
      identityKey: {
        catalogSelection: exactSelection,
        commercialScope: {
          channelId: 'B2C',
          marketId: 'cz-launch',
          sellingLegalEntityId: '88888888-8888-4888-8888-888888888888',
        },
        currencyCode,
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: { quantity: '1', unitRef },
      },
      priceRef,
      revision: {
        effectiveFrom,
        monetaryAmount: { amount: '100', currencyCode },
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 1,
        revisionId: '99999999-9999-4999-8999-999999999999',
      },
    },
    effectivePeriod: { effectiveFrom, effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
  },
  scheduleRevision: 1,
});

const aggregationInput = (
  exactSelections: readonly [ReturnType<typeof selection>, ReturnType<typeof selection>] = [selection(), selection()],
  currencyCode: 'CZK' | 'EUR' = 'CZK',
) => {
  const lines = [line('line-A', exactSelections[0]), line('line-B', exactSelections[1])] as const;
  const [firstLine] = lines;
  const exactPrice = exactPriceFor(exactSelections[0], currencyCode);
  const quantityBasis = {
    catalogQuantityBasis: firstLine.catalog.quantityBasis,
    priceUnitBasis: { quantity: '1', unitRef },
  };
  const candidate = {
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
  };
  const participants = lines.map((recipientLine) => ({
    candidateRef,
    exactPrice,
    line: recipientLine,
    normalizedQuantity: { quantity: '5', quantityBasis },
  }));
  const catalogEquivalence = {
    anchorSelection: exactSelections[0],
    assessmentId: 'catalog-pricing-equivalence:42',
    effectiveAt: evaluatedAt,
    members: participants.map(({ line: participantLine }) => ({
      occurrenceId: participantLine.occurrenceId,
      selection: participantLine.catalog.selection,
    })),
    observedAt: '2026-09-27T12:05:00.000Z',
    ownerModuleId: 'commerce.catalog' as const,
    ownerRevision: 'catalog-equivalence:42',
    purpose: 'PRICING' as const,
    status: 'CONFIRMED' as const,
    validThrough: '2026-09-27T12:01:00.000Z',
  };
  return { attempt: { candidate, candidateRef, evaluatedAt, participants }, catalogEquivalence };
};

const successFor = (input: QuantityTierAggregationInput) => {
  const [firstParticipant] = input.attempt.participants;
  if (firstParticipant === undefined) {
    throw new Error('expected a non-empty aggregation fixture');
  }
  return {
    aggregatedQuantity: {
      quantity: '10',
      quantityBasis: firstParticipant.normalizedQuantity.quantityBasis,
    },
    evidence: {
      currentness: {
        candidate: input.attempt.candidate,
        candidateRef,
        catalogEquivalence: input.catalogEquivalence,
        evaluatedAt,
        exactPrice: firstParticipant.exactPrice,
        participantOccurrenceIds: ['line-A', 'line-B'],
      },
      input,
    },
    outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED' as const,
    recipientLines: input.attempt.candidate.lines,
  };
};

const decodeInput = Schema.decodeUnknownSync(QuantityTierAggregationInputSchema, {
  onExcessProperty: 'error',
});
const decodeRequest = Schema.decodeUnknownSync(QuantityTierAggregationRequestSchema, {
  onExcessProperty: 'error',
});
const decodeSuccess = Schema.decodeUnknownSync(QuantityTierAggregationSuccessSchema, {
  onExcessProperty: 'error',
});

describe('Pricing Quantity Tier aggregation #768 acceptance contracts', () => {
  it('aggregates A5 and B5 only with exact Current Catalog evidence while preserving A and B', () => {
    const input = decodeInput(aggregationInput());
    const success = decodeSuccess(successFor(input));

    expect(input.catalogEquivalence.effectiveAt).toBe(input.attempt.evaluatedAt);
    expect(input.catalogEquivalence.observedAt > input.attempt.evaluatedAt).toBe(true);
    expect(input.catalogEquivalence.observedAt > input.catalogEquivalence.validThrough).toBe(true);
    expect(success.aggregatedQuantity.quantity).toBe('10');
    expect(success.recipientLines.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-A', 'line-B']);
    expect(success.evidence.currentness.participantOccurrenceIds).toEqual(['line-A', 'line-B']);
    expect(success.evidence.currentness.catalogEquivalence).toEqual(input.catalogEquivalence);
  });

  it('binds the aggregation evaluation instant to the exact candidate operation time', () => {
    const input = aggregationInput();
    const foreignEvaluationTime = '2026-09-27T12:00:00.001Z';

    expect(() =>
      decodeRequest({
        attempt: { ...input.attempt, evaluatedAt: foreignEvaluationTime },
        catalogEquivalence: {
          evidence: { ...input.catalogEquivalence, effectiveAt: foreignEvaluationTime },
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        },
      }),
    ).toThrow('Quantity Tier aggregation must evaluate the exact candidate operation time');
  });

  it('requires exact, Current owner evidence for material Package revision equivalence', () => {
    const packageFive = selection(5);
    const packageSix = selection(6);
    const exactOwnerEvidence = aggregationInput([packageFive, packageSix]);
    const [firstMember] = exactOwnerEvidence.catalogEquivalence.members;

    expect(decodeInput(exactOwnerEvidence).attempt.participants).toHaveLength(2);
    expect(() =>
      decodeInput({
        ...exactOwnerEvidence,
        catalogEquivalence: {
          ...exactOwnerEvidence.catalogEquivalence,
          members: [firstMember, { occurrenceId: 'line-B', selection: packageFive }],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        ...exactOwnerEvidence,
        catalogEquivalence: {
          ...exactOwnerEvidence.catalogEquivalence,
          effectiveAt: '2026-09-27T11:59:00.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        ...exactOwnerEvidence,
        catalogEquivalence: {
          ...exactOwnerEvidence.catalogEquivalence,
          validThrough: evaluatedAt,
        },
      }),
    ).toThrow();
  });

  it('keeps line-native Fee, Discount, and rounding recipients and forbids whole-purchase copies', () => {
    const input = decodeInput(aggregationInput());
    const success = successFor(input);
    const [firstRecipient] = success.recipientLines;

    expect(() => decodeSuccess({ ...success, recipientLines: [firstRecipient] })).toThrow();
    expect(() =>
      decodeSuccess({
        ...success,
        lineNativeFeeRecipients: ['line-A', 'line-B'],
      }),
    ).toThrow();
    expect(() =>
      decodeSuccess({
        ...success,
        wholePurchaseBenefitCopies: ['line-A', 'line-B'],
      }),
    ).toThrow();
    expect(() =>
      decodeSuccess({ ...success, aggregatedQuantity: { ...success.aggregatedQuantity, quantity: '20' } }),
    ).toThrow();
  });

  it('excludes Storefront and FX while preserving generalized native EUR evidence', () => {
    const eurInput = aggregationInput(undefined, 'EUR');
    const decoded = decodeInput(eurInput);

    expect(decoded.attempt.candidate.currencyCode).toBe('EUR');
    expect(decoded.attempt.participants[0]?.exactPrice.price.definition.identityKey.currencyCode).toBe('EUR');
    expect(() =>
      decodeRequest({
        attempt: eurInput.attempt,
        catalogEquivalence: {
          evidence: eurInput.catalogEquivalence,
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        },
        storefrontId: 'storefront-prague',
      }),
    ).toThrow();
    expect(() =>
      decodeRequest({
        attempt: eurInput.attempt,
        catalogEquivalence: {
          evidence: eurInput.catalogEquivalence,
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        },
        exchangeRate: '25',
      }),
    ).toThrow();
  });

  it('invalidates accepted evidence after line-structure or material-candidate changes', () => {
    const input = decodeInput(aggregationInput());
    const success = successFor(input);
    const [, secondLine] = success.evidence.currentness.candidate.lines;

    expect(() =>
      decodeSuccess({
        ...success,
        evidence: {
          ...success.evidence,
          currentness: {
            ...success.evidence.currentness,
            candidate: {
              ...success.evidence.currentness.candidate,
              lines: [secondLine],
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeSuccess({
        ...success,
        evidence: {
          ...success.evidence,
          currentness: {
            ...success.evidence.currentness,
            participantOccurrenceIds: ['line-B', 'line-A'],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeSuccess({
        ...success,
        evidence: {
          ...success.evidence,
          currentness: {
            ...success.evidence.currentness,
            catalogEquivalence: {
              ...success.evidence.currentness.catalogEquivalence,
              ownerRevision: 'catalog-equivalence:43',
            },
          },
        },
      }),
    ).toThrow();
  });
});
