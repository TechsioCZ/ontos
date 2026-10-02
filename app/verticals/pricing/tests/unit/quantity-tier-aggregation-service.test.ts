import type { QuantityTierAggregationRequest } from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import {
  QuantityTierAggregationRequestSchema,
  QuantityTierAggregationSuccessSchema,
} from '@app/pricing-contracts/domain/quantity-tier-aggregation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { aggregateQuantityTierLines } from '../../src/services/quantity-tier-aggregation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellingLegalEntityId = '22222222-2222-4222-8222-222222222222';
const priceId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const variantId = '55555555-5555-4555-8555-555555555555';
const unitId = '66666666-6666-4666-8666-666666666666';
const priceRevisionId = '77777777-7777-4777-8777-777777777777';

const catalogRef = (resourceId: string, resourceType: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});

const productRef = catalogRef(productId, 'commerce.catalog.product');
const variantRef = catalogRef(variantId, 'commerce.catalog.variant');
const unitRef = catalogRef(unitId, 'commerce.catalog.product-unit');
const selection = { productRef, variantRef };
const commercialScope = {
  channelId: 'B2C',
  marketId: 'cz-launch',
  sellingLegalEntityId,
};
const priceRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: priceId,
  resourceType: 'commerce.pricing.price' as const,
  tenantId,
};
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '88888888-8888-4888-8888-888888888888',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};

const catalogEvidence = {
  assessedAt: '2026-09-27T09:59:59.000Z',
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
    attestationId: '99999999-9999-4999-8999-999999999999',
    observedAt: '2026-09-27T09:59:59.000Z',
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ' as const,
    variant: { resourceRef: variantRef, revision: 2 },
  },
  purpose: 'PRICING' as const,
  selection,
  status: 'VALID' as const,
};

const line = (occurrenceId: string, quantity: string) => ({
  catalog: {
    completeness: {
      observedAt: '2026-09-27T09:59:59.000Z',
      ownerRevision: 'catalog-quantity:17',
      scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog-quantity:${occurrenceId}` },
    },
    divisible: true,
    equivalentSelectionKey: 'catalog-selection:exact',
    evidence: catalogEvidence,
    hierarchyRevision: 'catalog-hierarchy:9',
    ownerRevision: 'catalog-quantity:17',
    quantity: {
      changed: false,
      notice: null,
      requested: quantity,
      resulting: quantity,
      rounding: 'HALF_UP' as const,
      status: 'VALID' as const,
      step: '0.000000001',
      targetId: variantId,
      tenantId,
      unitId,
      unitRuleRevision: 7,
    },
    quantityBasis: {
      targetDivisibilityRevision: 3,
      targetRef: variantRef,
      unitRef,
      unitRuleRevision: 7,
    },
    selection,
    status: 'READY' as const,
    unitRef,
  },
  occurrenceId,
  pricingBasis: { quantity: '1', unitRef },
});

const exactPrice = {
  path: { priceGroupSelector: { kind: 'NO_GROUP' as const }, requiredAbsenceEvidence: [] },
  price: {
    definition: {
      identityKey: {
        catalogSelection: selection,
        commercialScope,
        currencyCode: 'CZK',
        priceGroupSelector: { kind: 'NO_GROUP' as const },
        unitBasis: { quantity: '1', unitRef },
      },
      priceRef,
      revision: {
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        monetaryAmount: { amount: '100', currencyCode: 'CZK' },
        monetaryBoundary: 'PRE_TAX' as const,
        revision: 1,
        revisionId: priceRevisionId,
      },
    },
    effectivePeriod: { effectiveFrom: '2026-09-01T00:00:00.000Z', effectiveTo: null },
    lineage: { correctedRevisionId: null, kind: 'INITIAL' as const, previousRevisionId: null },
  },
  scheduleRevision: 1,
};

const quantityBasis = {
  catalogQuantityBasis: {
    targetDivisibilityRevision: 3,
    targetRef: variantRef,
    unitRef,
    unitRuleRevision: 7,
  },
  priceUnitBasis: { quantity: '1', unitRef },
};

const decodeRequest = Schema.decodeUnknownSync(QuantityTierAggregationRequestSchema, {
  onExcessProperty: 'error',
});
const decodeSuccess = Schema.decodeUnknownSync(QuantityTierAggregationSuccessSchema, {
  onExcessProperty: 'error',
});

const request = (): QuantityTierAggregationRequest => {
  const firstLine = line('purchase-occurrence-a', '9007199254740992.999999999');
  const secondLine = line('purchase-occurrence-b', '0.000000001');
  const candidateRef = 'candidate:purchase-41';
  return decodeRequest({
    attempt: {
      candidate: {
        commercialScope,
        currencyCode: 'CZK',
        lines: [firstLine, secondLine],
        monetaryBoundary: 'PRE_TAX',
        operationTime: '2026-09-27T10:00:00.000Z',
        purchasingContext: {
          accessDecision: { decisionRef: 'candidate-access:41', decisionRevision: 'candidate-access-revision:41' },
          actor: { kind: 'PRINCIPAL', principalId: 'pricing-principal:41' },
          commercialSettingsDecision: {
            decisionRef: 'candidate-commercial-settings:41',
            decisionRevision: 'candidate-commercial-settings-revision:41',
          },
          contextRef: 'commerce-purchasing-context:41',
          contextRevision: 'customer-context:41',
          currencyResolution: {
            currencyCode: 'CZK',
            resolutionRef: 'candidate-currency-resolution:41',
            resolutionRevision: 'candidate-currency-resolution-revision:41',
          },
          subject: {
            authorizationSubject: { kind: 'RETAIL' },
            kind: 'PROFILE',
            profileRef: {
              moduleId: 'commerce.customer-context',
              resourceId: 'customer-profile:41',
              resourceType: 'commerce.customer-context.retail-customer-profile',
              tenantId,
            },
          },
        },
        tenantId,
      },
      candidateRef,
      evaluatedAt: '2026-09-27T10:00:00.000Z',
      participants: [
        {
          candidateRef,
          exactPrice,
          line: firstLine,
          normalizedQuantity: { quantity: '9007199254740992.999999999', quantityBasis },
        },
        {
          candidateRef,
          exactPrice,
          line: secondLine,
          normalizedQuantity: { quantity: '0.000000001', quantityBasis },
        },
      ],
    },
    catalogEquivalence: {
      evidence: {
        anchorSelection: selection,
        assessmentId: 'catalog-pricing-equivalence:41',
        effectiveAt: '2026-09-27T10:00:00.000Z',
        members: [
          { occurrenceId: firstLine.occurrenceId, selection: firstLine.catalog.selection },
          { occurrenceId: secondLine.occurrenceId, selection: secondLine.catalog.selection },
        ],
        observedAt: '2026-09-27T10:00:05.000Z',
        ownerModuleId: 'commerce.catalog',
        ownerRevision: 'catalog-equivalence:17',
        purpose: 'PRICING',
        status: 'CONFIRMED',
        validThrough: '2026-09-27T11:00:00.000Z',
      },
      outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
    },
  });
};

type Participant = QuantityTierAggregationRequest['attempt']['participants'][number];

const changeSecondParticipant = <ChangedParticipant>(
  source: QuantityTierAggregationRequest,
  change: (participant: Participant) => ChangedParticipant,
): QuantityTierAggregationRequest => {
  const [first, second] = source.attempt.participants;
  if (first === undefined || second === undefined) {
    throw new Error('Test fixture requires two participants');
  }
  return decodeRequest({
    ...source,
    attempt: { ...source.attempt, participants: [first, change(second)] },
  });
};

const confirmedEvidence = (source: QuantityTierAggregationRequest) => {
  if (source.catalogEquivalence.outcome !== 'CATALOG_EQUIVALENCE_CONFIRMED') {
    throw new Error('Test fixture requires confirmed Catalog equivalence');
  }
  return source.catalogEquivalence.evidence;
};

describe('Pricing Quantity Tier aggregation service', () => {
  it.effect(
    'sums exactly beyond Number precision while preserving original recipients, order, and occurrence evidence',
    () =>
      Effect.gen(function* exactAggregation() {
        const input = request();
        const result = yield* aggregateQuantityTierLines(input);

        expect(result).toMatchObject({
          aggregatedQuantity: { quantity: '9007199254740993', quantityBasis },
          evidence: {
            currentness: {
              candidate: input.attempt.candidate,
              candidateRef: input.attempt.candidateRef,
              participantOccurrenceIds: ['purchase-occurrence-a', 'purchase-occurrence-b'],
            },
            input: {
              attempt: input.attempt,
              catalogEquivalence: confirmedEvidence(input),
            },
          },
          outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
          recipientLines: input.attempt.candidate.lines,
        });
        expect(decodeSuccess(result)).toEqual(result);
      }),
  );

  it.effect(
    'retains line-native fee, discount, and rounding recipients without allocating or multiplying whole-purchase facts',
    () =>
      Effect.gen(function* retainRecipientScope() {
        const input = request();
        const result = yield* aggregateQuantityTierLines(input);

        expect(result.outcome).toBe('QUANTITY_TIER_QUANTITY_AGGREGATED');
        if (result.outcome !== 'QUANTITY_TIER_QUANTITY_AGGREGATED') {
          return;
        }
        expect(result.recipientLines).toEqual(input.attempt.candidate.lines);
        expect(result.recipientLines).toHaveLength(2);
        expect(result.evidence.currentness.candidate).toEqual(input.attempt.candidate);
        expect(result).not.toHaveProperty('allocations');
        expect(result).not.toHaveProperty('feeContributions');
        expect(result).not.toHaveProperty('discountContributions');
        expect(result).not.toHaveProperty('roundingRecipients');
        expect(result).not.toHaveProperty('storefront');
        expect(result.evidence.input.attempt).not.toHaveProperty('storefront');
        expect(decodeSuccess(result)).toEqual(result);
      }),
  );

  it.effect('accepts an honest later observation for the exact requested effective instant', () =>
    Effect.gen(function* acceptsLaterObservation() {
      const input = request();
      const evidence = confirmedEvidence(input);

      expect(evidence.effectiveAt).toBe(input.attempt.evaluatedAt);
      expect(evidence.observedAt > input.attempt.evaluatedAt).toBe(true);
      expect(yield* aggregateQuantityTierLines(input)).toMatchObject({
        outcome: 'QUANTITY_TIER_QUANTITY_AGGREGATED',
      });
    }),
  );

  it.effect('keeps unavailable and unverifiable Catalog owner evidence as separate typed refusals', () =>
    Effect.gen(function* ownerEvidenceFailures() {
      const input = request();
      const unavailable = yield* aggregateQuantityTierLines({
        attempt: input.attempt,
        catalogEquivalence: { outcome: 'CATALOG_EQUIVALENCE_UNAVAILABLE' },
      });
      const unverifiable = yield* aggregateQuantityTierLines({
        attempt: input.attempt,
        catalogEquivalence: {
          evidenceRef: 'catalog-equivalence:unverifiable:41',
          outcome: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
        },
      });

      expect(unavailable).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        participantOccurrenceIds: ['purchase-occurrence-a', 'purchase-occurrence-b'],
        reason: 'CATALOG_EQUIVALENCE_UNAVAILABLE',
      });
      expect(unverifiable).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        participantOccurrenceIds: ['purchase-occurrence-a', 'purchase-occurrence-b'],
        reason: 'CATALOG_EQUIVALENCE_UNVERIFIABLE',
      });
    }),
  );

  it.effect('separates candidate, recipient, Price identity, Price revision, and Price path failures', () =>
    Effect.gen(function* identityFailures() {
      const base = request();
      const candidateMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        candidateRef: 'candidate:another-purchase',
      }));
      const recipientMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        line: { ...participant.line, pricingBasis: { ...participant.line.pricingBasis, quantity: '2' } },
      }));
      const priceIdentityMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          price: {
            ...participant.exactPrice.price,
            definition: {
              ...participant.exactPrice.price.definition,
              priceRef: {
                ...participant.exactPrice.price.definition.priceRef,
                resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              },
            },
          },
        },
      }));
      const priceRevisionMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          price: {
            ...participant.exactPrice.price,
            definition: {
              ...participant.exactPrice.price.definition,
              revision: {
                ...participant.exactPrice.price.definition.revision,
                revision: 2,
                revisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              },
            },
          },
        },
      }));
      const pricePathMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          path: {
            ...participant.exactPrice.path,
            requiredAbsenceEvidence: [
              {
                nextApplicabilityBoundary: '2026-09-27T11:00:00.000Z',
                observedAt: '2026-09-27T09:59:59.000Z',
                ownerRevision: 'price-absence:17',
                scope: { kind: 'EXACT_PREDICATE', predicateRef: 'price:no-group:41' },
              },
            ],
          },
        },
      }));

      for (const [changed, reason] of [
        [candidateMismatch, 'PURCHASE_CANDIDATE_MISMATCH'],
        [recipientMismatch, 'RECIPIENT_STRUCTURE_MISMATCH'],
        [priceIdentityMismatch, 'PRICE_IDENTITY_MISMATCH'],
        [priceRevisionMismatch, 'PRICE_REVISION_MISMATCH'],
        [pricePathMismatch, 'PRICE_PATH_MISMATCH'],
      ] as const) {
        expect(yield* aggregateQuantityTierLines(changed)).toMatchObject({
          outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
          reason,
        });
      }
    }),
  );

  it.effect('separates commercial context, currency, Group, and Quantity Basis failures', () =>
    Effect.gen(function* commercialFailures() {
      const base = request();
      const contextMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          price: {
            ...participant.exactPrice.price,
            definition: {
              ...participant.exactPrice.price.definition,
              identityKey: {
                ...participant.exactPrice.price.definition.identityKey,
                commercialScope: {
                  ...participant.exactPrice.price.definition.identityKey.commercialScope,
                  marketId: 'another-market',
                },
              },
            },
          },
        },
      }));
      const currencyMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          price: {
            ...participant.exactPrice.price,
            definition: {
              ...participant.exactPrice.price.definition,
              identityKey: { ...participant.exactPrice.price.definition.identityKey, currencyCode: 'EUR' },
              revision: {
                ...participant.exactPrice.price.definition.revision,
                monetaryAmount: {
                  ...participant.exactPrice.price.definition.revision.monetaryAmount,
                  currencyCode: 'EUR',
                },
              },
            },
          },
        },
      }));
      const groupMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        exactPrice: {
          ...participant.exactPrice,
          path: { ...participant.exactPrice.path, priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef } },
          price: {
            ...participant.exactPrice.price,
            definition: {
              ...participant.exactPrice.price.definition,
              identityKey: {
                ...participant.exactPrice.price.definition.identityKey,
                priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
              },
            },
          },
        },
      }));
      const basisMismatch = changeSecondParticipant(base, (participant) => ({
        ...participant,
        normalizedQuantity: {
          ...participant.normalizedQuantity,
          quantityBasis: {
            ...participant.normalizedQuantity.quantityBasis,
            catalogQuantityBasis: {
              ...participant.normalizedQuantity.quantityBasis.catalogQuantityBasis,
              unitRuleRevision: 8,
            },
          },
        },
      }));

      for (const [changed, reason] of [
        [contextMismatch, 'COMMERCIAL_CONTEXT_MISMATCH'],
        [currencyMismatch, 'CURRENCY_MISMATCH'],
        [groupMismatch, 'GROUP_MISMATCH'],
        [basisMismatch, 'INCOMPATIBLE_QUANTITY_BASIS'],
      ] as const) {
        expect(yield* aggregateQuantityTierLines(changed)).toMatchObject({
          outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
          reason,
        });
      }
    }),
  );

  it.effect('separates duplicate occurrences, mismatched equivalence membership, and stale equivalence evidence', () =>
    Effect.gen(function* equivalenceFailures() {
      const base = request();
      const [first] = base.attempt.participants;
      if (first === undefined) {
        return;
      }
      const duplicateOccurrence = decodeRequest({
        ...base,
        attempt: { ...base.attempt, participants: [first, first] },
      });
      const evidence = confirmedEvidence(base);
      const equivalenceMismatch = decodeRequest({
        ...base,
        catalogEquivalence: {
          evidence: { ...evidence, members: [evidence.members[0]] },
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        },
      });
      const staleEquivalence = decodeRequest({
        ...base,
        catalogEquivalence: {
          evidence: {
            ...evidence,
            effectiveAt: '2026-09-27T09:58:00.000Z',
            validThrough: '2026-09-27T09:59:00.000Z',
          },
          outcome: 'CATALOG_EQUIVALENCE_CONFIRMED',
        },
      });

      expect(yield* aggregateQuantityTierLines(duplicateOccurrence)).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'DUPLICATE_OCCURRENCE',
      });
      expect(yield* aggregateQuantityTierLines(equivalenceMismatch)).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'CATALOG_EQUIVALENCE_MISMATCH',
      });
      expect(yield* aggregateQuantityTierLines(staleEquivalence)).toMatchObject({
        outcome: 'QUANTITY_TIER_AGGREGATION_REFUSED',
        reason: 'STALE_CATALOG_EQUIVALENCE',
      });
    }),
  );
});
