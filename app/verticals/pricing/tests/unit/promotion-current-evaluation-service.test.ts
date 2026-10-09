import type {
  PromotionContributionOwnerEvidence,
  PromotionContributionSourcePort,
} from '@app/pricing-contracts/domain/promotion-contribution';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { PricingPromotionCompositionInput } from '../../src/services/promotion-contribution-composition.service.ts';
import {
  makePricingPromotionCompositionService,
  PricingPromotionUnverifiable,
} from '../../src/services/promotion-contribution-composition.service.ts';
import { makePricingPromotionCurrentEvaluationService } from '../../src/services/promotion-current-evaluation.service.ts';
import type { PricingPromotionCurrentnessProbe } from '../../src/services/promotion-current-evaluation.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-09-28T08:00:00.000Z';
const exactPredicateRef = 'promotion:exact:purchase-776';
const unitRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product-unit' as const,
  tenantId,
};
const selection = (suffix: string) => ({
  productRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: `22222222-2222-4222-8222-2222222222${suffix}`,
    resourceType: 'commerce.catalog.product' as const,
    tenantId,
  },
  variantRef: {
    moduleId: 'commerce.catalog' as const,
    resourceId: `33333333-3333-4333-8333-3333333333${suffix}`,
    resourceType: 'commerce.catalog.variant' as const,
    tenantId,
  },
});
const decisionLine = (occurrenceId: string, suffix: string) => {
  const catalogSelection = selection(suffix);
  return {
    catalog: {
      completeness: {
        observedAt: operationTime,
        ownerRevision: 'catalog-quantity:776',
        scope: { kind: 'EXACT_PREDICATE' as const, predicateRef: `catalog:${occurrenceId}` },
      },
      divisible: false,
      equivalentSelectionKey: `catalog-selection:${occurrenceId}`,
      evidence: {
        assessedAt: operationTime,
        basis: [
          { role: 'PRODUCT' as const, source: { resourceRef: catalogSelection.productRef, revision: 1 } },
          { role: 'VARIANT' as const, source: { resourceRef: catalogSelection.variantRef, revision: 2 } },
          {
            provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
            role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
            source: { resourceRef: catalogSelection.productRef, revision: 1 },
          },
        ],
        membership: {
          attestationId: `66666666-6666-4666-8666-6666666666${suffix}`,
          observedAt: operationTime,
          productRef: catalogSelection.productRef,
          source: 'CATALOG_OWNER_CURRENT_READ' as const,
          variant: { resourceRef: catalogSelection.variantRef, revision: 2 },
        },
        purpose: 'PRICING' as const,
        selection: catalogSelection,
        status: 'VALID' as const,
      },
      hierarchyRevision: 'catalog-hierarchy:776',
      ownerRevision: 'catalog-quantity:776',
      quantity: {
        changed: false,
        notice: null,
        requested: '1',
        resulting: '1',
        rounding: 'HALF_UP' as const,
        status: 'VALID' as const,
        step: '1',
        targetId: catalogSelection.variantRef.resourceId,
        tenantId,
        unitId: unitRef.resourceId,
        unitRuleRevision: 7,
      },
      quantityBasis: {
        targetDivisibilityRevision: 3,
        targetRef: catalogSelection.variantRef,
        unitRef,
        unitRuleRevision: 7,
      },
      selection: catalogSelection,
      status: 'READY' as const,
      unitRef,
    },
    occurrenceId,
    pricingBasis: { quantity: '1', unitRef },
  };
};
const decision = Schema.decodeSync(PricingDecisionSchema)({
  commercialScope: {
    channelId: 'B2C',
    marketId: 'market-cz',
    sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
  },
  currencyCode: 'CZK',
  lines: [decisionLine('line-a', '22'), decisionLine('line-b', '33')],
  monetaryBoundary: 'PRE_TAX',
  operationTime,
  purchasingContext: {
    accessDecision: {
      decisionRef: 'purchase-access-decision:776',
      decisionRevision: 'purchase-access-decision-r776',
    },
    actor: {
      guestEvidenceRef: 'guest-context-776',
      guestSessionRef: 'guest-session-776',
      kind: 'GUEST',
    },
    commercialSettingsDecision: {
      decisionRef: 'purchase-commercial-settings:776',
      decisionRevision: 'purchase-commercial-settings-r776',
    },
    contextRef: 'purchase-776',
    contextRevision: 'purchase-r776',
    currencyResolution: {
      currencyCode: 'CZK',
      resolutionRef: 'purchase-currency-resolution:776',
      resolutionRevision: 'purchase-currency-resolution-r776',
    },
    subject: {
      guestEvidenceRef: 'guest-context-776',
      guestSessionRef: 'guest-session-776',
      kind: 'GUEST',
    },
  },
  tenantId,
});
const money = (amount: string) => ({ amount, currencyCode: 'CZK' as const });
const compositionLine = (occurrenceId: string, amount: string) => ({
  multiLineAllocations: [],
  occurrenceId,
  preAllocationIntermediateValue: money(amount),
  rawPostAllocationValue: money(amount),
  recipientKind: 'MERCHANDISE' as const,
});
const intermediate = (occurrenceId: string, amount: string) => ({
  baseLineValue: money(amount),
  discountableLineBasis: money(amount),
  feeContributions: [],
  lineDiscountContributions: [],
  occurrenceId,
  recipientKind: 'MERCHANDISE' as const,
  value: money(amount),
});
const baseInput: PricingPromotionCompositionInput = {
  applicationRequestRef: 'voucher-request-attempt-1',
  candidateRef: 'pricing-candidate-attempt-1',
  currencyCompatibility: {
    currencyCode: 'CZK',
    evidenceRef: 'currency-support-evidence-776',
    observedAt: operationTime,
    ownerRevision: 'currency-support-r776',
    status: 'SUPPORTED_CURRENT',
    tenantId,
  },
  decision,
  exactPredicateRef,
  pricingComposition: {
    allocationResults: [],
    composedLines: [compositionLine('line-a', '800'), compositionLine('line-b', '200')],
    decision,
    lineIntermediates: [intermediate('line-a', '800'), intermediate('line-b', '200')],
    outcome: 'ALLOCATION_COMPOSITION_READY',
  },
  pricingCompositionRef: 'pricing-composition-776',
  pricingCompositionRevision: 'pricing-composition-attempt-1',
  subjectEvidence: {
    evidenceRef: 'subject-evidence-776',
    observedAt: operationTime,
    ownerModuleId: 'commerce.customer-context',
    ownerRevision: 'subject-r776',
    provenanceRef: 'subject-provenance-776',
    revalidatedAt: operationTime,
    subject: { guestEvidenceRef: 'guest-context-776', kind: 'GUEST', tenantId },
  },
};

const ownerEvidence = (ownerRevision: string): PromotionContributionOwnerEvidence => ({
  completenessEvidence: {
    observedAt: operationTime,
    ownerRevision,
    scope: { kind: 'EXACT_PREDICATE', predicateRef: exactPredicateRef },
  },
  currentness: {
    evaluatedAt: operationTime,
    observedAt: operationTime,
    revalidatedAt: operationTime,
    status: 'CURRENT',
  },
  exactPredicateRef,
  ownerModuleId: 'commerce.promotion',
  ownerRevision,
  provenanceRef: `promotion-provenance:${ownerRevision}`,
});

const contributionSource = (ownerCalls: string[]): PromotionContributionSourcePort => ({
  evaluate: (request) => {
    ownerCalls.push(request.candidate.candidateRef);
    const revision = request.candidate.candidateRef.endsWith('2') ? 'promotion-r2' : 'promotion-r1';
    return Effect.succeed({
      _tag: 'PROMOTION_CONTRIBUTION_APPLIED',
      allocations: [
        {
          amount: money('-80'),
          catalogSelection: selection('22'),
          occurrenceId: 'line-a',
          recipientKind: 'MERCHANDISE',
        },
        {
          amount: money('-20'),
          catalogSelection: selection('33'),
          occurrenceId: 'line-b',
          recipientKind: 'MERCHANDISE',
        },
      ],
      applicationIdentity: {
        applicationKind: 'PROMOTION_APPLICATION',
        applicationRef: `promotion-application:${revision}`,
        applicationRevision: revision,
        originalApplicationRef: request.applicationRequestRef,
      },
      contribution: money('-100'),
      ownerEvidence: ownerEvidence(revision),
      request,
      target: { kind: 'MERCHANDISE_ONLY', occurrenceIds: ['line-a', 'line-b'] },
    });
  },
});

const secondInput: PricingPromotionCompositionInput = {
  ...baseInput,
  applicationRequestRef: 'voucher-request-attempt-2',
  candidateRef: 'pricing-candidate-attempt-2',
  pricingCompositionRevision: 'pricing-composition-attempt-2',
};

describe('Pricing Promotion Current evaluation (#776)', () => {
  it.effect('accepts exact owner currentness and completeness for the whole bound attempt', () =>
    Effect.gen(function* acceptsExactCurrentEvidence() {
      const ownerCalls: string[] = [];
      const checkedCandidateRefs: string[] = [];
      const currentness: PricingPromotionCurrentnessProbe = {
        revalidate: ({ expectedOwnerEvidence, request }) => {
          checkedCandidateRefs.push(request.candidate.candidateRef);
          expect(request.candidate.decision).toMatchObject({
            commercialScope: {
              channelId: 'B2C',
              marketId: 'market-cz',
              sellingLegalEntityId: '55555555-5555-4555-8555-555555555555',
            },
            currencyCode: 'CZK',
            tenantId,
          });
          expect(request.prePromotionBasis.lines.map(({ occurrenceId }) => occurrenceId)).toEqual(['line-a', 'line-b']);
          expect(request.subjectEvidence.subject).toEqual({
            guestEvidenceRef: 'guest-context-776',
            kind: 'GUEST',
            tenantId,
          });
          return Effect.succeed({
            _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT',
            ownerEvidence: expectedOwnerEvidence,
          });
        },
      };
      let loads = 0;
      const result = yield* makePricingPromotionCurrentEvaluationService(
        makePricingPromotionCompositionService(contributionSource(ownerCalls)).compose,
        currentness,
      ).evaluate({
        loadFresh: () => {
          loads += 1;
          return Effect.succeed(baseInput);
        },
      });

      expect(result.attempts).toBe(1);
      expect(result.currentnessEvidence).toEqual(ownerEvidence('promotion-r1'));
      expect(result.composition.ownerDecision.ownerEvidence).toEqual(ownerEvidence('promotion-r1'));
      expect(loads).toBe(1);
      expect(ownerCalls).toEqual(['pricing-candidate-attempt-1']);
      expect(checkedCandidateRefs).toEqual(['pricing-candidate-attempt-1']);
    }),
  );

  it.effect(
    'discards a changed whole attempt and retries once from freshly loaded inputs without merging evidence',
    () =>
      Effect.gen(function* retriesFreshWholeAttempt() {
        const ownerCalls: string[] = [];
        const discardedEvidence = ownerEvidence('promotion-r2');
        let checks = 0;
        const currentness: PricingPromotionCurrentnessProbe = {
          revalidate: ({ expectedOwnerEvidence }) => {
            checks += 1;
            return checks === 1
              ? Effect.succeed({
                  _tag: 'PROMOTION_OWNER_EVIDENCE_CHANGED' as const,
                  ownerEvidence: discardedEvidence,
                })
              : Effect.succeed({
                  _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT' as const,
                  ownerEvidence: expectedOwnerEvidence,
                });
          },
        };
        let loads = 0;
        const result = yield* makePricingPromotionCurrentEvaluationService(
          makePricingPromotionCompositionService(contributionSource(ownerCalls)).compose,
          currentness,
        ).evaluate({
          loadFresh: () => {
            loads += 1;
            return Effect.succeed(loads === 1 ? baseInput : secondInput);
          },
        });

        expect(result.attempts).toBe(2);
        expect(result.composition.request.candidate.candidateRef).toBe('pricing-candidate-attempt-2');
        expect(result.composition.request.applicationRequestRef).toBe('voucher-request-attempt-2');
        expect(result.composition.request.prePromotionBasis.pricingCompositionRevision).toBe(
          'pricing-composition-attempt-2',
        );
        expect(result.currentnessEvidence).toEqual(ownerEvidence('promotion-r2'));
        expect(result.composition.ownerDecision.ownerEvidence).toEqual(ownerEvidence('promotion-r2'));
        expect(ownerCalls).toEqual(['pricing-candidate-attempt-1', 'pricing-candidate-attempt-2']);
        expect(loads).toBe(2);
      }),
  );

  it.effect('treats a CURRENT response with different complete owner evidence as a change', () =>
    Effect.gen(function* rejectsMislabeledChangedEvidence() {
      const ownerCalls: string[] = [];
      const currentness: PricingPromotionCurrentnessProbe = {
        revalidate: () =>
          Effect.succeed({
            _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT',
            ownerEvidence: ownerEvidence('promotion-other'),
          }),
      };
      let loads = 0;
      const failure = yield* makePricingPromotionCurrentEvaluationService(
        makePricingPromotionCompositionService(contributionSource(ownerCalls)).compose,
        currentness,
      )
        .evaluate({
          loadFresh: () => {
            loads += 1;
            return Effect.succeed(loads === 1 ? baseInput : secondInput);
          },
        })
        .pipe(Effect.flip);

      expect(Schema.is(PricingPromotionUnverifiable)(failure)).toBe(true);
      expect(failure.reason).toContain('changed during the bounded Current evaluation');
      expect(ownerCalls).toEqual(['pricing-candidate-attempt-1', 'pricing-candidate-attempt-2']);
      expect(loads).toBe(2);
    }),
  );

  it.effect('applies the same bounded currentness gate to proven non-applicability', () =>
    Effect.gen(function* protectsProvenAbsence() {
      let ownerCalls = 0;
      const source: PromotionContributionSourcePort = {
        evaluate: (request) => {
          ownerCalls += 1;
          return Effect.succeed({
            _tag: 'PROMOTION_CONTRIBUTION_NOT_APPLICABLE',
            ownerEvidence: ownerEvidence(`promotion-absent-r${ownerCalls}`),
            reason: 'NO_APPLICABLE_APPLICATION',
            request,
          });
        },
      };
      let checks = 0;
      const currentness: PricingPromotionCurrentnessProbe = {
        revalidate: ({ expectedOwnerEvidence }) => {
          checks += 1;
          return Effect.succeed(
            checks === 1
              ? {
                  _tag: 'PROMOTION_OWNER_EVIDENCE_CHANGED' as const,
                  ownerEvidence: ownerEvidence('promotion-absent-r2'),
                }
              : {
                  _tag: 'PROMOTION_OWNER_EVIDENCE_CURRENT' as const,
                  ownerEvidence: expectedOwnerEvidence,
                },
          );
        },
      };
      let loads = 0;
      const result = yield* makePricingPromotionCurrentEvaluationService(
        makePricingPromotionCompositionService(source).compose,
        currentness,
      ).evaluate({
        loadFresh: () => {
          loads += 1;
          return Effect.succeed(loads === 1 ? baseInput : secondInput);
        },
      });

      expect(result.attempts).toBe(2);
      expect(result.composition.outcome).toBe('PROMOTION_COMPOSITION_NOT_APPLICABLE');
      expect(result.composition.request.candidate.candidateRef).toBe('pricing-candidate-attempt-2');
      expect(ownerCalls).toBe(2);
    }),
  );
});
