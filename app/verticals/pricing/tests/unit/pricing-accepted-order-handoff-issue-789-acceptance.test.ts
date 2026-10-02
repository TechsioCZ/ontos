import { PricingAcceptedOrderHandoffSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type { PricingAcceptedLegacyCurrencySupportReference } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingCurrentBackedConfirmationSourceSchema,
  PricingQuotationBackedConfirmationSourceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  addPricingExactDecimals,
  PRICING_CZK_PUBLICATION_PROFILE_VERSION,
} from '@app/pricing-contracts/domain/exact-decimal';
import type { PricingFinalPreRoundReady } from '@app/pricing-contracts/domain/line-composition';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  deserializePricingAcceptedOrderHandoff,
  serializePricingAcceptedOrderHandoff,
} from '../../src/services/accepted-order-handoff-serializer.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { PricingCommitmentConfirmationVerification } from '../../src/services/commitment-confirmation-verification.service.ts';
import type { PricingCommitmentConfirmationVerificationService } from '../../src/services/commitment-confirmation-verification.service.ts';
import {
  makePricingCurrentBackedAcceptedHandoffService,
  PricingCurrentBackedAcceptedHandoffBuiltSchema,
} from '../../src/services/current-backed-accepted-handoff.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  makePricingQuotationBackedAcceptedHandoffService,
  PricingQuotationBackedAcceptedHandoffBuiltSchema,
} from '../../src/services/quotation-backed-accepted-handoff.service.ts';
import {
  issue788IssuedAt,
  makeIssue788CurrentConfirmation,
  makeIssue788IssuedConfirmation,
  makeIssue788MaterialEvidence,
  makeIssue788Quotation,
} from './support/issue-788-confirmation.fixture.ts';
import { makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';

const quoteAcceptedAt = '2026-09-28T12:00:10.000Z';

const mergePreRoundLines = (
  first: PricingFinalPreRoundReady,
  second: PricingFinalPreRoundReady,
): PricingFinalPreRoundReady => {
  const [firstDecisionLine] = first.decision.lines;
  const [secondDecisionLine] = second.decision.lines;
  const [firstPreRoundLine] = first.lines;
  const [secondPreRoundLine] = second.lines;
  const [firstRawLine] = first.rawComposition.lines;
  const [secondRawLine] = second.rawComposition.lines;
  const firstPromotion = first.rawComposition.promotionComposition;
  const secondPromotion = second.rawComposition.promotionComposition;
  const [firstPromotionLine] = firstPromotion.kind === 'PROMOTION_SELECTED' ? firstPromotion.composition.lines : [];
  const [secondPromotionLine] = secondPromotion.kind === 'PROMOTION_SELECTED' ? secondPromotion.composition.lines : [];
  if (
    firstDecisionLine === undefined ||
    secondDecisionLine === undefined ||
    firstPreRoundLine === undefined ||
    secondPreRoundLine === undefined ||
    firstRawLine === undefined ||
    secondRawLine === undefined ||
    firstPromotion.kind !== 'PROMOTION_SELECTED' ||
    secondPromotion.kind !== 'PROMOTION_SELECTED' ||
    firstPromotionLine === undefined ||
    secondPromotionLine === undefined
  ) {
    throw new Error('Issue #789 fixture requires two complete original Pricing lines');
  }
  const decision = { ...first.decision, lines: [firstDecisionLine, secondDecisionLine] };
  const firstBoundRaw = {
    ...firstRawLine,
    feeCalculation: {
      ...firstRawLine.feeCalculation,
      input: { ...firstRawLine.feeCalculation.input, decision },
    },
  };
  const secondBoundRaw = {
    ...secondRawLine,
    feeCalculation: {
      ...secondRawLine.feeCalculation,
      input: { ...secondRawLine.feeCalculation.input, decision },
    },
  };
  return {
    ...first,
    decision,
    lines: [
      { ...firstPreRoundLine, composition: firstBoundRaw },
      { ...secondPreRoundLine, composition: secondBoundRaw },
    ],
    rawComposition: {
      ...first.rawComposition,
      decision,
      lines: [firstBoundRaw, secondBoundRaw],
      promotionComposition: {
        composition: {
          ...firstPromotion.composition,
          decision,
          lines: [firstPromotionLine, secondPromotionLine],
        },
        kind: 'PROMOTION_SELECTED',
      },
    },
  };
};

const makeRichAcceptedTerms = Effect.fn('test.issue789RichAcceptedTerms')(function* issue789RichAcceptedTerms() {
  const rounded = yield* makeIssue779PreRoundScenario({
    discounts: ['10', '10', '10'],
    feeAmount: '2',
    occurrenceId: 'line-789-rounded',
    priceAmount: '100.004',
    promotionAmount: '-1',
  });
  const floored = yield* makeIssue779PreRoundScenario({
    discounts: ['10', '10', '10'],
    feeAmount: '1',
    occurrenceId: 'line-789-floored',
    priceAmount: '20',
  });
  const preRound = mergePreRoundLines(rounded.preRound, floored.preRound);
  const publication = yield* publishPricingLineValues({
    candidateRef: preRound.rawComposition.candidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    return yield* Effect.die(`Issue #789 fixture could not publish lines: ${publication.failure.code}`);
  }
  const total = yield* calculatePricingCommercialTotals({
    candidateRef: preRound.rawComposition.candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (total.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Issue #789 fixture could not calculate totals: ${total.failure.code}`);
  }
  return total;
});

const verificationEvidenceFor = (
  confirmation: PricingCommitmentConfirmationIssued,
  verifiedAt: string,
): PricingCommitmentConfirmationVerificationEvidence => ({
  authenticityRef: `pricing-confirmation-verification:${confirmation.confirmationRef}`,
  confirmationRef: confirmation.confirmationRef,
  issuerRef: confirmation.authenticity.issuerRef,
  keyRef: confirmation.authenticity.keyRef,
  keyStatus: 'HISTORICAL',
  keyVersion: confirmation.authenticity.keyVersion,
  lineageRef: confirmation.authenticity.lineageRef,
  payloadDigest: confirmation.authenticity.payloadDigest,
  proofRef: confirmation.authenticity.proofRef,
  proofVersion: confirmation.authenticity.proofVersion,
  verifiedAt,
});

const verificationService = (
  confirmation: PricingCommitmentConfirmationIssued,
  acceptedAt: string,
): PricingCommitmentConfirmationVerificationService => ({
  verify: (request) => {
    expect(request).toEqual({
      attemptedAt: acceptedAt,
      confirmation,
      kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
      requestedBinding: confirmation.binding,
    });
    return Effect.succeed({
      _tag: 'VERIFIED',
      authenticityEvidence: verificationEvidenceFor(confirmation, acceptedAt),
      confirmation,
      verifiedAt: acceptedAt,
    });
  },
});

const legacyCurrencyHistory = (tenantId: string): readonly PricingAcceptedLegacyCurrencySupportReference[] => [
  {
    effectivePeriod: { effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveTo: '2025-01-01T00:00:00.000Z' },
    generation: 1,
    ownerScope: {
      ownerModuleId: 'legacy.pricing',
      ownerRootRef: 'legacy-support:partition-a',
      predicateRef: 'legacy-support:tenant-partition-a',
      tenantId,
    },
    supportedCurrencies: ['CZK', 'EUR'],
    supportRevisionRef: 'pricing-currency-support:1',
    verificationRef: 'legacy-support-proof:partition-a:1',
  },
  {
    effectivePeriod: { effectiveFrom: '2024-01-01T00:00:00.000Z', effectiveTo: '2025-01-01T00:00:00.000Z' },
    generation: 1,
    ownerScope: {
      ownerModuleId: 'legacy.pricing',
      ownerRootRef: 'legacy-support:partition-b',
      predicateRef: 'legacy-support:tenant-partition-b',
      tenantId,
    },
    supportedCurrencies: ['EUR'],
    supportRevisionRef: 'pricing-currency-support:1',
    verificationRef: 'legacy-support-proof:partition-b:1',
  },
];

describe('Pricing Accepted Order handoff acceptance (#789)', () => {
  it.effect(
    'round-trips exact Current terms and complete internal evidence without recalculation or owner leakage',
    () =>
      Effect.gen(function* roundTripsCurrentAcceptedTerms() {
        const terms = yield* makeRichAcceptedTerms();
        const confirmation = makeIssue788CurrentConfirmation(terms);
        const currentSource = yield* Schema.decodeEffect(PricingCurrentBackedConfirmationSourceSchema)(
          confirmation.source,
        );
        const service = makePricingCurrentBackedAcceptedHandoffService(
          verificationService(confirmation, issue788IssuedAt),
        );
        const outcome = yield* service.build({
          acceptedAt: issue788IssuedAt,
          confirmation,
          currentPublication: {
            acceptedAttempt: currentSource.currentness.attempt,
            attempts: 1,
            currentness: currentSource.currentness,
            outcome: 'ORDINARY_CURRENT_PRICING_PUBLISHED',
            publication: {
              candidateRef: terms.candidateRef,
              currencyCode: 'CZK',
              lines: terms.publishedLines,
              monetaryBoundary: terms.decision.monetaryBoundary,
              pricingNetCommercialTotal: terms.pricingNetCommercialTotal,
            },
          },
          handoffRef: 'pricing-accepted-handoff:789:current-rich',
          materialEvidence: currentSource.materialEvidence,
          qualifiedLegacyCurrencySupportReferences: legacyCurrencyHistory(terms.decision.tenantId),
          requestedBinding: confirmation.binding,
          scopeRef: `pricing-tenant:${terms.decision.tenantId}`,
        });
        const { handoff } = yield* Schema.decodeUnknownEffect(PricingCurrentBackedAcceptedHandoffBuiltSchema)(outcome);

        const wire = yield* serializePricingAcceptedOrderHandoff(handoff);
        const restored = yield* deserializePricingAcceptedOrderHandoff(wire);
        const rawLines = restored.terms.sourceEvidence.preRound.rawComposition.lines;
        const preRoundLines = restored.terms.sourceEvidence.preRound.lines;

        expect(restored).toEqual(handoff);
        expect(restored.terms).toEqual(terms);
        expect(restored.materialEvidence).toEqual(currentSource.materialEvidence);
        expect(restored.terms.decision).toEqual(terms.decision);
        expect(restored.terms.decision.currencyCode).toBe('CZK');
        expect(restored.terms.decision.monetaryBoundary).toBe('PRE_TAX');
        expect(rawLines[0]?.unitPriceCalculation.input.exactPrice.path).toMatchObject({
          discountAudience: { kind: 'PRICE_GROUP' },
        });
        expect(rawLines[0]?.lineDiscountContributions.map(({ candidate }) => candidate.layer)).toEqual([
          'CATALOG',
          'PRICE_GROUP_CONTRACTUAL',
          'COUNTERPARTY_CONTRACTUAL',
        ]);
        expect(rawLines[0]?.feeCalculation.contributions).toHaveLength(1);
        expect(rawLines[0]?.promotionAllocation?.amount.amount).toBe('-1');
        expect(preRoundLines[0]?.floorEvaluation).toMatchObject({ kind: 'NOT_REQUIRED' });
        expect(preRoundLines[1]?.floorEvaluation).toMatchObject({
          floorAdjustment: { amount: '9', currencyCode: 'CZK' },
          kind: 'AUTHORIZED_ZERO_FLOOR',
          rawPostCompositionValue: { amount: '-9', currencyCode: 'CZK' },
        });
        expect(restored.terms.publishedLines).toMatchObject([
          { occurrenceId: 'line-789-rounded', roundingAdjustment: { amount: '-0.004', currencyCode: 'CZK' } },
          { occurrenceId: 'line-789-floored', publishedLineValue: { amount: '0', currencyCode: 'CZK' } },
        ]);
        const exactLineSum = yield* addPricingExactDecimals(
          restored.terms.publishedLines[0]?.publishedLineValue.amount ?? '0',
          restored.terms.publishedLines[1]?.publishedLineValue.amount ?? '0',
        );
        expect(restored.terms.pricingNetCommercialTotal.amount).toBe(exactLineSum);
        expect(restored.qualifiedLegacyCurrencySupportReferences).toHaveLength(2);
        expect(
          restored.qualifiedLegacyCurrencySupportReferences.map(({ ownerScope }) => ownerScope.ownerRootRef),
        ).toEqual(['legacy-support:partition-a', 'legacy-support:partition-b']);

        for (const forbidden of [
          'delivery',
          'finalPayable',
          'orderPersistence',
          'shipping',
          'tax',
          'customerProjection',
        ]) {
          expect(restored).not.toHaveProperty(forbidden);
          expect(restored.terms).not.toHaveProperty(forbidden);
        }
      }),
  );

  it.effect('preserves the exact Quote-to-Confirmation instance after Current sources and profiles change', () =>
    Effect.gen(function* preservesActuallyUsedQuotationProof() {
      const quotedTerms = yield* makeRichAcceptedTerms();
      const laterCurrentTerms = yield* makeIssue779PreRoundScenario({
        discounts: ['0', '0', '0'],
        occurrenceId: 'line-789-current-later',
        priceAmount: '950',
      });
      expect(laterCurrentTerms.preRound.lines[0]?.nonNegativePreRoundValue.amount).toBe('950');

      const quotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
        ...makeIssue788Quotation(quotedTerms, 'pricing-quotation:789:actual'),
        issuedAt: issue788IssuedAt,
      });
      const confirmation = makeIssue788IssuedConfirmation(quotedTerms, { quotation });
      const quotationSource = yield* Schema.decodeEffect(PricingQuotationBackedConfirmationSourceSchema)(
        confirmation.source,
      );
      const materialEvidence = makeIssue788MaterialEvidence(quotedTerms);
      const commitmentVerification = {
        _tag: 'VERIFIED' as const,
        authenticityEvidence: verificationEvidenceFor(confirmation, quoteAcceptedAt),
        confirmation,
        verifiedAt: quoteAcceptedAt,
      };
      yield* Schema.decodeEffect(PricingAcceptedOrderHandoffSchema, { onExcessProperty: 'error' })({
        acceptedAt: quoteAcceptedAt,
        commitmentVerification,
        handoffRef: 'pricing-accepted-handoff:789:quoted-rich',
        kind: 'PRICING_ACCEPTED_ORDER_HANDOFF',
        lineage: {
          attemptRef: confirmation.binding.attemptRef,
          confirmationRef: confirmation.confirmationRef,
          decisionBundleHash: confirmation.binding.decisionBundleHash,
          decisionBundleRef: confirmation.binding.decisionBundleRef,
          decisionBundleVersion: confirmation.binding.decisionBundleVersion,
          kind: 'QUOTATION_TO_CONFIRMATION',
          quotationIssuedAt: quotationSource.quotationRevalidation.quotation.issuedAt,
          quotationRef: quotationSource.quotationRevalidation.quotation.quotationRef,
          quotationRevalidatedAt: quotationSource.quotationRevalidation.evaluatedAt,
        },
        materialEvidence,
        owner: { moduleId: 'commerce.pricing', scopeRef: `pricing-tenant:${quotedTerms.decision.tenantId}` },
        qualifiedLegacyCurrencySupportReferences: [],
        terms: confirmation.terms,
      });
      const service = yield* makePricingQuotationBackedAcceptedHandoffService.pipe(
        Effect.provideService(
          PricingCommitmentConfirmationVerification,
          verificationService(confirmation, quoteAcceptedAt),
        ),
      );
      const outcome = yield* service.build({
        acceptedAt: quoteAcceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:quoted-rich',
        materialEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        quotation,
        quotationRevalidation: quotationSource.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: `pricing-tenant:${quotedTerms.decision.tenantId}`,
      });
      const { handoff } = yield* Schema.decodeUnknownEffect(PricingQuotationBackedAcceptedHandoffBuiltSchema)(outcome);

      const laterReissue = makeIssue788IssuedConfirmation(quotedTerms, {
        confirmationRef: 'pricing-confirmation:789:later-reissue',
        quotation,
      });
      const restored = yield* serializePricingAcceptedOrderHandoff(handoff).pipe(
        Effect.flatMap(deserializePricingAcceptedOrderHandoff),
      );

      expect(restored.commitmentVerification.confirmation.confirmationRef).toBe(confirmation.confirmationRef);
      expect(restored.commitmentVerification.confirmation.confirmationRef).not.toBe(laterReissue.confirmationRef);
      expect(restored.lineage).toMatchObject({
        attemptRef: confirmation.binding.attemptRef,
        confirmationRef: confirmation.confirmationRef,
        decisionBundleHash: confirmation.binding.decisionBundleHash,
        decisionBundleRef: confirmation.binding.decisionBundleRef,
        decisionBundleVersion: confirmation.binding.decisionBundleVersion,
        kind: 'QUOTATION_TO_CONFIRMATION',
        quotationRef: quotation.quotationRef,
      });
      expect(restored.commitmentVerification.confirmation.source).toEqual(confirmation.source);
      expect(restored.terms).toEqual(quotedTerms);
      expect(restored.terms.pricingNetCommercialTotal).not.toEqual({ amount: '950', currencyCode: 'CZK' });
    }),
  );
});
