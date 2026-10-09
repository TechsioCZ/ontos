import type {
  PricingLineCompositionRequest,
  PricingZeroFloorAuthorizationSet,
} from '@app/pricing-contracts/domain/line-composition';
import {
  PricingLineComposedLineSchema,
  PricingLineCompositionFailedSchema,
  PricingLineCompositionRequestSchema,
  PricingLineCompositionReadySchema,
  PricingLineCompositionResultSchema,
  PricingRawCompositionFailedSchema,
  PricingRawCompositionLineSchema,
  PricingRawCompositionReadySchema,
  PricingRawCompositionResultSchema,
  PricingZeroFloorAppliedSchema,
} from '@app/pricing-contracts/domain/line-composition';
import { PricingDiscountCompositionCandidateSchema } from '@app/pricing-contracts/domain/discount-composition';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { assessWholePurchaseDiscountThreshold } from '../../src/services/discount-applicability.service.ts';
import { allocatePricingDiscountsAndFees } from '../../src/services/discount-fee-allocation.service.ts';
import { composePricingDiscounts } from '../../src/services/discount-composition.service.ts';
import { evaluatePricingLineValues } from '../../src/services/line-value-calculation.service.ts';
import { composePricingRawLines } from '../../src/services/line-value-composition.service.ts';
import { evaluateZeroFloorAuthorization } from '../../src/services/zero-floor-authorization-evaluator.service.ts';
import { unitPriceFixtureEffectiveAt } from './support/unit-price-calculation.fixture.ts';

import {
  authorizationSetFor,
  firstRawLine,
  makeIssue779PreRoundScenario,
  makeIssue779Scenario as makeScenario,
  money,
  occurrenceId,
} from './support/issue-779-line-value.fixture.ts';

const threshold = (basis: string) =>
  assessWholePurchaseDiscountThreshold({
    configuredAmount: money('100'),
    decisionCurrencyCode: 'CZK',
    intermediates: [{ amount: money(basis), occurrenceId, recipientKind: 'MERCHANDISE' }],
  });

describe('issue #779 Pricing line value calculation acceptance', () => {
  it.effect(
    'preserves Price/Tier, Fee, independent line Discounts, Promotion, raw, and pre-round evidence in order',
    () =>
      Effect.gen(function* preservesCompleteOrder() {
        const { fixture, preRound: result } = yield* makeIssue779PreRoundScenario({
          feeAmount: '10',
          promotionAmount: '-10',
        });
        const raw = yield* composePricingRawLines(fixture.compositionRequest);
        if (raw.outcome === 'RAW_COMPOSITION_FAILED') {
          return yield* Effect.die(raw);
        }
        expect(raw.outcome).toBe('RAW_COMPOSITION_READY');
        expect(PricingLineCompositionResultSchema).not.toBe(PricingRawCompositionResultSchema);
        const encodedRawResult = yield* Schema.encodeEffect(PricingRawCompositionResultSchema)(raw);
        expect(yield* Schema.decodeEffect(PricingLineCompositionResultSchema)(encodedRawResult)).toEqual(
          yield* Schema.decodeEffect(PricingRawCompositionResultSchema)(encodedRawResult),
        );
        expect(PricingLineCompositionReadySchema).not.toBe(PricingRawCompositionReadySchema);
        const encodedReady = yield* Schema.encodeEffect(PricingRawCompositionReadySchema)(raw);
        expect(yield* Schema.decodeEffect(PricingLineCompositionReadySchema)(encodedReady)).toEqual(
          yield* Schema.decodeEffect(PricingRawCompositionReadySchema)(encodedReady),
        );
        const [firstLine] = raw.lines;
        if (firstLine === undefined) {
          return yield* Effect.die('Expected one raw composition line');
        }
        expect(PricingLineComposedLineSchema).not.toBe(PricingRawCompositionLineSchema);
        const encodedLine = yield* Schema.encodeEffect(PricingRawCompositionLineSchema)(firstLine);
        expect(yield* Schema.decodeEffect(PricingLineComposedLineSchema)(encodedLine)).toEqual(
          yield* Schema.decodeEffect(PricingRawCompositionLineSchema)(encodedLine),
        );
        expect(raw.lines[0]).toMatchObject({
          feeCalculation: {
            contributionTotal: money('10'),
            discountableLineBasis: money('110'),
          },
          lineDiscountContributions: [
            { amount: money('-10'), applicationCount: 'ONCE_PER_STABLE_LINE', candidate: { layer: 'CATALOG' } },
            {
              amount: money('-10'),
              applicationCount: 'ONCE_PER_STABLE_LINE',
              candidate: { layer: 'PRICE_GROUP_CONTRACTUAL' },
            },
            {
              amount: money('-10'),
              applicationCount: 'ONCE_PER_STABLE_LINE',
              candidate: { layer: 'COUNTERPARTY_CONTRACTUAL' },
            },
          ],
          prePromotionValue: money('80'),
          promotionAllocation: { amount: money('-10'), occurrenceId },
          rawPostCompositionValue: money('70'),
          unitPriceCalculation: { baseLineValue: money('100'), unitPrice: money('100') },
        });
        expect(result).toMatchObject({
          lines: [
            {
              floorEvaluation: { floorAdjustment: money('0'), kind: 'NOT_REQUIRED' },
              nonNegativePreRoundValue: money('70'),
              occurrenceId,
            },
          ],
          outcome: 'PRE_ROUND_LINE_VALUES_READY',
        });
        expect('roundingAdjustment' in result).toBe(false);
        expect('total' in result).toBe(false);

        const { preRound: exactSubCentPreRound } = yield* makeIssue779PreRoundScenario({
          discounts: ['0', '0', '0'],
          occurrenceId: 'line-780-a',
          priceAmount: '33.335',
        });
        expect(exactSubCentPreRound.lines).toMatchObject([
          { nonNegativePreRoundValue: money('33.335'), occurrenceId: 'line-780-a' },
        ]);
        return yield* Effect.void;
      }),
  );

  it.effect('rejects cross-owner Decision and candidate evidence drift before raw composition', () =>
    Effect.gen(function* rejectsEvidenceDrift() {
      const fixture = yield* makeScenario();
      const request = fixture.compositionRequest;
      if (request.promotionComposition.kind !== 'PROMOTION_SELECTED') {
        return yield* Effect.die('Expected selected Promotion evidence');
      }
      const [decisionLine] = request.decision.lines;
      if (decisionLine === undefined) {
        return yield* Effect.die('Expected one Decision line');
      }
      const contextDecision = (suffix: string) => ({
        ...request.decision,
        purchasingContext: {
          ...request.decision.purchasingContext,
          contextRef: `purchase-context:${suffix}`,
          contextRevision: `purchase-context-r${suffix}`,
        },
      });
      const driftedVariantDecision = {
        ...request.decision,
        lines: [
          {
            ...decisionLine,
            catalog: {
              ...decisionLine.catalog,
              selection: {
                ...decisionLine.catalog.selection,
                variantRef: {
                  ...decisionLine.catalog.selection.variantRef,
                  resourceId: '79797979-7979-4797-8797-797979797979',
                },
              },
            },
          },
        ],
      };
      const [firstContribution, ...remainingContributions] = request.discountComposition.lineContributions;
      if (firstContribution === undefined) {
        return yield* Effect.die('Expected line Discount evidence');
      }
      const firstIdentityBasis = firstContribution.candidate.definition.identityKey.basis;
      const firstApplicabilityBasis = firstContribution.candidate.audienceBinding.applicabilityBasis.basis;
      if (firstIdentityBasis.kind !== 'VARIANT_LINE' || firstApplicabilityBasis.kind !== 'VARIANT_LINE') {
        return yield* Effect.die('Expected Variant-line Discount evidence');
      }
      const driftedCatalogSelection = {
        ...firstIdentityBasis.catalogSelection,
        variantRef: {
          ...firstIdentityBasis.catalogSelection.variantRef,
          resourceId: '79797979-7979-4797-8797-797979797979',
        },
      };
      const driftedDiscountIdentity = {
        ...firstContribution.candidate.definition.identityKey,
        basis: {
          ...firstIdentityBasis,
          catalogSelection: driftedCatalogSelection,
        },
      };
      const driftedDiscountCandidate = {
        ...firstContribution.candidate,
        audienceBinding: {
          ...firstContribution.candidate.audienceBinding,
          applicabilityBasis: {
            ...firstContribution.candidate.audienceBinding.applicabilityBasis,
            basis: {
              ...firstApplicabilityBasis,
              catalogSelection: driftedCatalogSelection,
            },
          },
          identityKey: driftedDiscountIdentity,
        },
        definition: {
          ...firstContribution.candidate.definition,
          identityKey: driftedDiscountIdentity,
        },
      };
      const evidenceDriftRequests: readonly PricingLineCompositionRequest[] = [
        { ...request, decision: { ...request.decision, tenantId: '79797979-7979-4797-8797-797979797979' } },
        { ...request, decision: contextDecision('top-level-drift') },
        { ...request, decision: driftedVariantDecision },
        { ...request, candidateRef: 'pricing-candidate:drift' },
        {
          ...request,
          discountComposition: {
            ...request.discountComposition,
            request: { ...request.discountComposition.request, decision: contextDecision('discount-drift') },
          },
        },
        {
          ...request,
          promotionComposition: {
            ...request.promotionComposition,
            composition: {
              ...request.promotionComposition.composition,
              decision: contextDecision('promotion-drift'),
            },
          },
        },
        {
          ...request,
          discountComposition: {
            ...request.discountComposition,
            lineContributions: [
              { ...firstContribution, candidate: driftedDiscountCandidate },
              ...remainingContributions,
            ],
          },
        },
        {
          ...request,
          discountComposition: {
            ...request.discountComposition,
            lineContributions: [
              {
                ...firstContribution,
                basis: { ...firstContribution.basis, occurrenceId: 'line-779:replayed' },
                candidate: { ...firstContribution.candidate, occurrenceId: 'line-779:replayed' },
              },
              ...remainingContributions,
            ],
          },
        },
        {
          ...request,
          discountComposition: {
            ...request.discountComposition,
            lineContributions: [
              {
                ...firstContribution,
                basis: { ...firstContribution.basis, occurrenceId: 'line-779:replayed' },
              },
              ...remainingContributions,
            ],
          },
        },
        {
          ...request,
          discountComposition: {
            ...request.discountComposition,
            lineContributions: [
              {
                ...firstContribution,
                basis: {
                  ...firstContribution.basis,
                  applicablePricingFeeTotal: money('1'),
                },
              },
              ...remainingContributions,
            ],
          },
        },
      ];

      for (const [index, driftedRequest] of evidenceDriftRequests.entries()) {
        const failure = yield* composePricingRawLines(driftedRequest);
        expect(failure).toMatchObject({
          failure: { type: 'EVIDENCE_UNVERIFIABLE' },
          outcome: 'RAW_COMPOSITION_FAILED',
        });
        if (index === 0 && failure.outcome === 'RAW_COMPOSITION_FAILED') {
          expect(PricingLineCompositionFailedSchema).not.toBe(PricingRawCompositionFailedSchema);
          const encodedFailure = yield* Schema.encodeEffect(PricingRawCompositionFailedSchema)(failure);
          expect(yield* Schema.decodeEffect(PricingLineCompositionFailedSchema)(encodedFailure)).toEqual(
            yield* Schema.decodeEffect(PricingRawCompositionFailedSchema)(encodedFailure),
          );
        }
      }
      return yield* Effect.void;
    }),
  );

  it.effect('uses strict B > D and applies each fixed line/whole benefit once', () =>
    Effect.gen(function* enforcesFixedCounts() {
      expect(yield* threshold('99')).toMatchObject({ outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE' });
      expect(yield* threshold('100')).toMatchObject({ outcome: 'WHOLE_PURCHASE_DISCOUNT_NOT_APPLICABLE' });
      expect(yield* threshold('100.01')).toMatchObject({
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        contribution: money('-100'),
        outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
      });

      const fixture = yield* makeScenario({ discounts: ['40', '40', '40'] });
      expect(fixture.compositionRequest.discountComposition.lineContributions).toHaveLength(3);
      expect(
        fixture.compositionRequest.discountComposition.lineContributions.every(
          ({ applicationCount }) => applicationCount === 'ONCE_PER_STABLE_LINE',
        ),
      ).toBe(true);
    }),
  );

  it.effect('preserves one whole-purchase allocation and exact sub-cent sum/capacity without floor repair', () =>
    Effect.gen(function* preservesWholeAllocation() {
      const fixture = yield* makeScenario();
      const { decision } = fixture.compositionRequest;
      const [firstDecisionLine] = decision.lines;
      if (firstDecisionLine === undefined) {
        return yield* Effect.die('Expected original Pricing Line');
      }
      const eligibleBasis = {
        currencyCode: 'CZK' as const,
        eligibleAmount: '100.0072',
        recipients: [
          { intermediateValue: money('9.7097'), occurrenceId, recipientKind: 'MERCHANDISE' as const },
          {
            intermediateValue: money('90.2975'),
            occurrenceId: 'line-779-b',
            recipientKind: 'MERCHANDISE' as const,
          },
        ],
      };
      const twoLineDecision = {
        ...decision,
        lines: [firstDecisionLine, { ...firstDecisionLine, occurrenceId: 'line-779-b' }],
      };
      const allocated = yield* allocatePricingDiscountsAndFees({
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
        decision: twoLineDecision,
        eligibleBasis,
        originalContribution: money('-100'),
        precision: {
          allocationScale: 18,
          amountPrecision: 76,
          contractVersion: 'pricing-allocation-v1',
          remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
        },
        source: {
          allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
          logicalFactRef: 'whole-discount:779',
          ownerModuleId: 'commerce.pricing',
          revisionRef: 'whole-discount-r779',
          sourceKind: 'PRICING_DISCOUNT',
        },
      });
      expect(allocated).toMatchObject({
        allocations: [
          { amount: money('-9.709000951931460935'), occurrenceId },
          { amount: money('-90.290999048068539065'), occurrenceId: 'line-779-b' },
        ],
        outcome: 'ALLOCATION_APPLIED',
      });
      if (allocated.outcome !== 'ALLOCATION_APPLIED') {
        return yield* Effect.die('Expected exact whole-purchase allocation');
      }
      expect(
        allocated.allocations.every(
          ({ amount }, index) =>
            Number(amount.amount.slice(1)) <= Number(eligibleBasis.recipients[index]?.intermediateValue.amount ?? '0'),
        ),
      ).toBe(true);
      expect(allocated.allocations.map(({ amount }) => amount.amount).join('|')).not.toContain('floor');
      return yield* Effect.void;
    }),
  );

  it.effect('applies one whole-purchase allocation in raw composition and preserves its source Revision', () =>
    Effect.gen(function* preservesWholeRevision() {
      const fixture = yield* makeScenario();
      const { decision, discountComposition } = fixture.compositionRequest;
      const counterparty = discountComposition.request.candidates.find(
        (candidate) => candidate.kind === 'VARIANT_LINE' && candidate.layer === 'COUNTERPARTY_CONTRACTUAL',
      );
      if (
        counterparty?.kind !== 'VARIANT_LINE' ||
        counterparty.audienceBinding.evidence.kind !== 'COUNTERPARTY_OWNER_EVIDENCE'
      ) {
        return yield* Effect.die('Expected Counterparty line evidence');
      }
      const wholeBasis = {
        currencyCode: 'CZK' as const,
        eligibleAmount: '70',
        recipients: [{ intermediateValue: money('70'), occurrenceId, recipientKind: 'MERCHANDISE' as const }],
      };
      const wholeIdentity = {
        ...counterparty.definition.identityKey,
        basis: { kind: 'WHOLE_PURCHASE' as const },
        effectKind: 'FIXED_MONETARY_AMOUNT' as const,
        scope: 'WHOLE_PURCHASE' as const,
      };
      const wholeDefinition = {
        discountId: '51515151-5151-4515-8515-515151515151',
        identityKey: wholeIdentity,
        revision: {
          configuredEffect: { kind: 'FIXED_MONETARY_AMOUNT' as const, level: money('20') },
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          revision: 1,
          revisionId: '52525252-5252-4525-8525-525252525252',
        },
      };
      const wholeCandidate = yield* Schema.decodeUnknownEffect(PricingDiscountCompositionCandidateSchema, {
        onExcessProperty: 'error',
      })({
        applicability: {
          basis: wholeBasis,
          contribution: money('-20'),
          definition: wholeDefinition,
          outcome: 'WHOLE_PURCHASE_DISCOUNT_APPLICABLE',
        },
        applicationCount: 'ONCE_PER_PRICING_DECISION',
        audienceBinding: {
          applicabilityBasis: {
            basis: wholeIdentity.basis,
            commercialScope: decision.commercialScope,
            currencyCode: decision.currencyCode,
            observedAt: decision.operationTime,
          },
          basePricePath: counterparty.audienceBinding.basePricePath,
          evidence: { ...counterparty.audienceBinding.evidence, audience: wholeIdentity.audience },
          identityKey: wholeIdentity,
        },
        decision,
        definition: wholeDefinition,
        kind: 'WHOLE_PURCHASE',
        layer: 'COUNTERPARTY_WHOLE_PURCHASE',
        outcome: 'DISCOUNT_APPLICABLE',
      });
      const wholeDiscountComposition = yield* composePricingDiscounts({
        ...discountComposition.request,
        candidates: [...discountComposition.request.candidates, wholeCandidate],
        wholePurchaseBasis: wholeBasis,
      });
      if (wholeDiscountComposition.outcome !== 'DISCOUNT_COMPOSITION_READY') {
        return yield* Effect.die('Expected ready whole-purchase composition');
      }
      const wholeAllocation = yield* allocatePricingDiscountsAndFees({
        allocationKind: 'WHOLE_PURCHASE_CONTRACTUAL',
        decision,
        eligibleBasis: wholeBasis,
        originalContribution: money('-20'),
        precision: {
          allocationScale: 18,
          amountPrecision: 76,
          contractVersion: 'pricing-allocation-v1',
          remainderRule: 'LARGEST_FRACTION_THEN_STABLE_OCCURRENCE_ID_ASC',
        },
        source: {
          allocationAuthority: 'PRICING_WHOLE_PURCHASE_CONTRACTUAL',
          logicalFactRef: wholeDefinition.discountId,
          ownerModuleId: 'commerce.pricing',
          revisionRef: wholeDefinition.revision.revisionId,
          sourceKind: 'PRICING_DISCOUNT',
        },
      });
      if (wholeAllocation.outcome !== 'ALLOCATION_APPLIED') {
        return yield* Effect.die('Expected applied whole-purchase allocation');
      }
      const selectedPromotion = fixture.compositionRequest.promotionComposition;
      if (selectedPromotion.kind !== 'PROMOTION_SELECTED') {
        return yield* Effect.die('Expected selected Promotion evidence');
      }
      const promotionComposition = {
        ...selectedPromotion,
        composition: {
          ...selectedPromotion.composition,
          lines: selectedPromotion.composition.lines.map((line) => ({
            ...line,
            prePromotionValue: money('50'),
            rawPreTaxValue: money('50'),
          })),
        },
      };
      const raw = yield* composePricingRawLines({
        ...fixture.compositionRequest,
        discountComposition: wholeDiscountComposition,
        promotionComposition,
        wholePurchaseAllocation: wholeAllocation,
      });
      expect(raw).toMatchObject({
        lines: [
          {
            prePromotionValue: money('50'),
            rawPostCompositionValue: money('50'),
            wholePurchaseAllocation: { amount: money('-20'), occurrenceId },
            wholePurchaseAllocationRevisionRef: wholeDefinition.revision.revisionId,
          },
        ],
        outcome: 'RAW_COMPOSITION_READY',
        wholePurchaseAllocationEvidence: { outcome: 'ALLOCATION_APPLIED' },
      });
      return yield* Effect.void;
    }),
  );

  it.effect('requires an exact Current bounded authorization for Base 100 minus Discounts 120', () =>
    Effect.gen(function* appliesExactFloor() {
      const fixture = yield* makeScenario({ discounts: ['40', '40', '40'] });
      const raw = yield* composePricingRawLines(fixture.compositionRequest);
      expect(raw.outcome).toBe('RAW_COMPOSITION_READY');
      if (raw.outcome !== 'RAW_COMPOSITION_READY') {
        return yield* Effect.die('Expected raw composition');
      }
      const line = firstRawLine(raw.lines);
      expect(line.rawPostCompositionValue).toEqual(money('-20'));
      expect(line.negativeOrigin).toBe('LINE_NATIVE_COMPOSITION');
      const authorizationSet = authorizationSetFor(line);
      const applied = yield* evaluateZeroFloorAuthorization({ authorizationSet, composedLine: line, composition: raw });
      expect(applied).toMatchObject({
        floorAdjustment: money('20'),
        kind: 'AUTHORIZED_ZERO_FLOOR',
        nonNegativePreRoundValue: money('0'),
        rawPostCompositionValue: money('-20'),
      });
      if (applied.kind !== 'AUTHORIZED_ZERO_FLOOR') {
        return yield* Effect.die('Expected authorized ZERO_FLOOR evaluation');
      }
      expect(applied.authorizationSet).toEqual(authorizationSet);
      expect(applied.authorizationSet).toMatchObject({
        completenessEvidence: authorizationSet.completenessEvidence,
        currentness: authorizationSet.currentness,
        exactPredicateRef: authorizationSet.exactPredicateRef,
        ownerRevision: authorizationSet.ownerRevision,
        query: authorizationSet.query,
      });

      const final = yield* evaluatePricingLineValues({
        authorizationSets: [{ authorizationSet, occurrenceId: line.occurrenceId }],
        composition: raw,
      });
      if (!('outcome' in final) || final.outcome !== 'PRE_ROUND_LINE_VALUES_READY') {
        return yield* Effect.die('Expected final pre-round line values');
      }
      const [finalLine] = final.lines;
      if (finalLine === undefined || finalLine.floorEvaluation.kind !== 'AUTHORIZED_ZERO_FLOOR') {
        return yield* Effect.die('Expected final authorized ZERO_FLOOR evidence');
      }
      expect(finalLine.floorEvaluation.authorizationSet).toEqual(authorizationSet);

      expect(() =>
        Schema.decodeSync(PricingZeroFloorAppliedSchema, { onExcessProperty: 'error' })({
          ...applied,
          authorizationSet: { ...authorizationSet, authorizations: [] },
        }),
      ).toThrow();
      const [retainedAuthorization] = authorizationSet.authorizations;
      if (retainedAuthorization === undefined) {
        return yield* Effect.die('Expected retained ZERO_FLOOR authorization');
      }
      expect(() =>
        Schema.decodeSync(PricingZeroFloorAppliedSchema, { onExcessProperty: 'error' })({
          ...applied,
          authorizationSet: {
            ...authorizationSet,
            authorizations: [
              {
                ...retainedAuthorization,
                economicCoverage: { maximumFloorAdjustment: '21', minimumRawAmount: '-21' },
                governanceEvidence: {
                  ...retainedAuthorization.governanceEvidence,
                  reason: 'Tampered governance meaning with reused identity',
                },
              },
            ],
          },
        }),
      ).toThrow();
      expect(line.lineDiscountContributions.map(({ amount }) => amount.amount)).toEqual(['-40', '-40', '-40']);
      return yield* Effect.void;
    }),
  );

  it.effect('fails typed for absent, mismatched, stale, out-of-bounds, and conflicting authorization', () =>
    Effect.gen(function* failsClosed() {
      const fixture = yield* makeScenario({ discounts: ['40', '40', '40'] });
      const raw = yield* composePricingRawLines(fixture.compositionRequest);
      if (raw.outcome !== 'RAW_COMPOSITION_READY') {
        return yield* Effect.die('Expected raw composition');
      }
      const line = firstRawLine(raw.lines);
      const valid = authorizationSetFor(line);
      const [baseAuthorization] = valid.authorizations;
      if (baseAuthorization === undefined) {
        return yield* Effect.die('Expected authorization fixture');
      }
      const evaluate = (authorizationSet: PricingZeroFloorAuthorizationSet) =>
        evaluateZeroFloorAuthorization({ authorizationSet, composedLine: line, composition: raw });
      expect(yield* evaluate({ ...valid, authorizations: [] })).toMatchObject({
        kind: 'ZERO_FLOOR_FAILED',
        reasonCode: 'AUTHORIZATION_ABSENT',
      });
      expect(
        yield* evaluate({
          ...valid,
          authorizations: [],
          query: {
            ...valid.query,
            commercialScope: { ...valid.query.commercialScope, marketId: 'unrelated-complete-market' },
          },
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_UNVERIFIABLE' });
      expect(
        yield* evaluate({
          ...valid,
          authorizations: [
            {
              ...baseAuthorization,
              businessScope: {
                ...baseAuthorization.businessScope,
                commercialScope: { ...baseAuthorization.businessScope.commercialScope, marketId: 'other-market' },
              },
            },
          ],
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'SCOPE_MISMATCH' });
      expect(
        yield* evaluate({
          ...valid,
          completenessEvidence: {
            ...valid.completenessEvidence,
            nextApplicabilityBoundary: unitPriceFixtureEffectiveAt,
          },
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_UNVERIFIABLE' });
      expect(
        yield* evaluate({
          ...valid,
          authorizations: [
            {
              ...baseAuthorization,
              economicCoverage: { maximumFloorAdjustment: '19.99', minimumRawAmount: '-19.99' },
            },
          ],
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'ECONOMIC_COVERAGE_EXCEEDED' });
      expect(
        yield* evaluate({
          ...valid,
          authorizations: [
            {
              ...baseAuthorization,
              effectivePeriod: {
                endsAt: '2026-09-27T23:59:59.999Z',
                startsAt: '2026-09-01T00:00:00.000Z',
              },
            },
          ],
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'EFFECTIVE_PERIOD_MISMATCH' });
      expect(
        yield* evaluate({
          ...valid,
          authorizations: [
            baseAuthorization,
            {
              ...baseAuthorization,
              authorizationRef: 'zero-floor-auth:779:successor',
              authorizationRevision: 'zero-floor-auth-r779:successor',
            },
          ],
        }),
      ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_CONFLICT' });
      return yield* Effect.void;
    }),
  );

  it.effect(
    'reuses authorization within bounds, requires a successor for scope expansion, and ignores floor for nonnegative raw',
    () =>
      Effect.gen(function* preservesGovernanceBoundary() {
        const negativeFixture = yield* makeScenario({ discounts: ['39', '40', '40'] });
        const negativeRaw = yield* composePricingRawLines(negativeFixture.compositionRequest);
        if (negativeRaw.outcome !== 'RAW_COMPOSITION_READY') {
          return yield* Effect.die('Expected negative raw composition');
        }
        const line = firstRawLine(negativeRaw.lines);
        const bounded = authorizationSetFor(line);
        const [current] = bounded.authorizations;
        if (current === undefined) {
          return yield* Effect.die('Expected bounded authorization');
        }
        const reusable = yield* evaluateZeroFloorAuthorization({
          authorizationSet: bounded,
          composedLine: line,
          composition: negativeRaw,
        });
        expect(reusable).toMatchObject({ floorAdjustment: money('19'), kind: 'AUTHORIZED_ZERO_FLOOR' });

        const expanded = {
          ...negativeFixture.compositionRequest.decision,
          commercialScope: {
            ...negativeFixture.compositionRequest.decision.commercialScope,
            marketId: 'expanded-market',
          },
        };
        expect(
          yield* evaluateZeroFloorAuthorization({
            authorizationSet: bounded,
            composedLine: line,
            composition: { ...negativeRaw, decision: expanded },
          }),
        ).toMatchObject({ kind: 'ZERO_FLOOR_FAILED', reasonCode: 'AUTHORIZATION_UNVERIFIABLE' });

        const positiveFixture = yield* makeScenario({ discounts: ['10', '10', '10'] });
        const positiveRaw = yield* composePricingRawLines(positiveFixture.compositionRequest);
        if (positiveRaw.outcome !== 'RAW_COMPOSITION_READY') {
          return yield* Effect.die('Expected nonnegative raw composition');
        }
        expect(
          yield* evaluateZeroFloorAuthorization({
            authorizationSet: { ...authorizationSetFor(firstRawLine(positiveRaw.lines)), authorizations: [] },
            composedLine: firstRawLine(positiveRaw.lines),
            composition: positiveRaw,
          }),
        ).toMatchObject({ floorAdjustment: money('0'), kind: 'NOT_REQUIRED', nonNegativePreRoundValue: money('70') });
        return yield* Effect.void;
      }),
  );

  it.effect('is Storefront-invariant and keeps native currencies without FX or EUR activation', () =>
    Effect.gen(function* preservesCurrencyModel() {
      const czk = yield* makeScenario();
      const raw = yield* composePricingRawLines(czk.compositionRequest);
      expect(raw.outcome).toBe('RAW_COMPOSITION_READY');
      expect('storefrontId' in czk.compositionRequest.decision.commercialScope).toBe(false);
      expect('exchangeRate' in czk.compositionRequest).toBe(false);

      const eur = yield* makeScenario({ currencyCode: 'EUR' });
      const eurRaw = yield* composePricingRawLines(eur.compositionRequest);
      expect(eurRaw).toMatchObject({
        decision: { currencyCode: 'EUR' },
        lines: [{ rawPostCompositionValue: money('70', 'EUR') }],
        outcome: 'RAW_COMPOSITION_READY',
      });
      expect(eur.compositionRequest.unitPrices[0]?.input.exactPrice.currencySupport.supportedCurrencies).toEqual([
        'EUR',
      ]);
      expect(czk.compositionRequest.unitPrices[0]?.input.exactPrice.currencySupport.supportedCurrencies).toEqual([
        'CZK',
      ]);
    }),
  );

  it.effect('fails closed when Promotion is parked instead of fabricating a ready composition', () =>
    Effect.gen(function* rejectsParkedPromotion() {
      const fixture = yield* makeScenario();
      const decoded = Schema.decodeOption(PricingLineCompositionRequestSchema, {
        onExcessProperty: 'error',
      })({
        ...fixture.compositionRequest,
        promotionComposition: {
          outcome: 'PROMOTION_COMPOSITION_FAILED',
          reason: 'The Promotion owner dependency is parked',
          reasonCode: 'PROMOTION_PARKED',
          retryable: false,
        },
      });
      expect(Option.isNone(decoded)).toBe(true);
    }),
  );

  it.effect('composes the ordinary Pricing path without Promotion owner evidence', () =>
    Effect.gen(function* composesWithoutPromotionSelection() {
      const fixture = yield* makeScenario({ discounts: ['5', '10', '15'], feeAmount: '10' });
      const result = yield* composePricingRawLines({
        ...fixture.compositionRequest,
        promotionComposition: { kind: 'PROMOTION_NOT_SELECTED' },
      });

      expect(result).toMatchObject({
        lines: [
          {
            prePromotionValue: money('80'),
            rawPostCompositionValue: money('80'),
          },
        ],
        outcome: 'RAW_COMPOSITION_READY',
        promotionComposition: { kind: 'PROMOTION_NOT_SELECTED' },
      });
      if (result.outcome !== 'RAW_COMPOSITION_READY') {
        return;
      }
      expect(result.lines[0]?.promotionAllocation).toBeUndefined();
      expect(result.lines[0]?.promotionOwnerDecisionRevision).toBeUndefined();
    }),
  );
});
