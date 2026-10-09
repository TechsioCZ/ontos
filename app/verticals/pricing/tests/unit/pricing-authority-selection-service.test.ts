import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import { PricingQuotationBindingSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingCurrentCommercialResult, PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  makePricingAuthoritySelectionService,
  PricingAuthorityDependencyFailure,
} from '../../src/services/pricing-authority-selection.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const readyCurrentResult = Effect.fn('test.issue782ReadyCurrentResult')(function* readyCurrentResultProgram(
  priceAmount: string,
) {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    discounts: ['0', '0', '0'],
    priceAmount,
  });
  const publication = yield* publishPricingLineValues({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    throw new Error(`Issue #782 fixture expected publication, got ${publication.failure.code}`);
  }
  const commercialTotal = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
    throw new Error(`Issue #782 fixture expected a commercial total, got ${commercialTotal.failure.code}`);
  }
  return { commercialTotal, kind: 'CURRENT_PRICING_RESULT' } satisfies PricingCurrentCommercialResult;
});

const quoteFor = (current: PricingCurrentCommercialResult): PricingQuotationIssued => ({
  binding: Schema.decodeUnknownSync(PricingQuotationBindingSchema)({
    candidateRef: current.commercialTotal.candidateRef,
    commercialScope: current.commercialTotal.decision.commercialScope,
    currencyCode: current.commercialTotal.decision.currencyCode,
    lines: current.commercialTotal.decision.lines.map(({ catalog, occurrenceId }) => ({
      occurrenceId,
      quantity: { amount: catalog.quantity.resulting, unitRef: catalog.unitRef },
      selection: catalog.selection,
    })),
    monetaryBoundary: current.commercialTotal.decision.monetaryBoundary,
    subject: {
      guestEvidenceRef: 'guest-evidence:782',
      guestSessionRef: 'guest-session:782',
      kind: 'GUEST',
      purchaseContext: {
        contextRef: current.commercialTotal.decision.purchasingContext.contextRef,
        contextRevision: current.commercialTotal.decision.purchasingContext.contextRevision,
      },
    },
    tenantId: current.commercialTotal.decision.tenantId,
  }),
  issuedAt: current.commercialTotal.decision.operationTime,
  kind: 'PRICING_QUOTATION',
  materialEvidence: makeQuotationMaterialEvidence(current.commercialTotal),
  quotationRef: 'pricing-quotation:782',
  quotedResult: current.commercialTotal,
  validity: {
    policyEvidence: {
      maximumValidityDurationMilliseconds: 3_600_000,
      policyRef: 'pricing-quotation-validity:issue-782-fixture',
      policyVersion: '1',
    },
    validFrom: current.commercialTotal.decision.operationTime,
    validUntil: '2026-09-28T13:00:00.000Z',
  },
});

const verificationAt = '2026-09-28T12:30:00.000Z';

describe('Pricing monetary authority selection', () => {
  it.effect('selects a fresh complete Current result and keeps quotation verification idle', () =>
    Effect.gen(function* selectsCurrentResult() {
      const current = yield* readyCurrentResult('950');
      let currentCalls = 0;
      let quotationCalls = 0;
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: () => {
            currentCalls += 1;
            return Effect.succeed(current);
          },
        },
        quotation: {
          verifyQuotation: () => {
            quotationCalls += 1;
            return Effect.die('Current-backed selection must not verify a quotation');
          },
        },
      });

      const result = yield* service.select({
        candidateRef,
        kind: 'CURRENT_BACKED',
        trustedOperationAt: current.commercialTotal.decision.operationTime,
      });

      expect(result).toMatchObject({
        commercialTotal: { pricingNetCommercialTotal: { amount: '950', currencyCode: 'CZK' } },
        kind: 'CURRENT_BACKED_TERMS_SELECTED',
      });
      expect(currentCalls).toBe(1);
      expect(quotationCalls).toBe(0);
    }),
  );

  it.effect('preserves a verified quoted 900 result when ordinary Current would now be 950', () =>
    Effect.gen(function* preservesQuotedTerms() {
      const quotedCurrent = yield* readyCurrentResult('900');
      const ordinaryCurrent = yield* readyCurrentResult('950');
      const quotation = quoteFor(quotedCurrent);
      let currentCalls = 0;
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: () => {
            currentCalls += 1;
            return Effect.succeed(ordinaryCurrent);
          },
        },
        quotation: {
          verifyQuotation: (request) =>
            Effect.succeed({
              kind: 'QUOTATION_VERIFIED',
              quotation: request.quotation,
              verificationRef: 'quotation-verification:782',
              verifiedAt: request.trustedOperationAt,
            }),
        },
      });

      const result = yield* service.select({
        candidateRef,
        kind: 'QUOTATION_BACKED',
        quotation,
        trustedOperationAt: verificationAt,
      });

      expect(result).toMatchObject({
        commercialTotal: { pricingNetCommercialTotal: { amount: '900', currencyCode: 'CZK' } },
        kind: 'QUOTATION_BACKED_TERMS_SELECTED',
        quotation: { quotationRef: quotation.quotationRef },
      });
      if (result.kind !== 'QUOTATION_BACKED_TERMS_SELECTED') {
        throw new Error('Expected verified quotation-backed terms');
      }
      expect(result.commercialTotal).toBe(quotation.quotedResult);
      expect(result.commercialTotal.sourceEvidence).toBe(quotation.quotedResult.sourceEvidence);
      expect(result.commercialTotal.decision.operationTime).not.toBe(verificationAt);
      expect(currentCalls).toBe(0);
    }),
  );

  it.effect('refuses retained display-only values without consulting either authority port', () =>
    Effect.gen(function* refusesRetainedDisplay() {
      const current = yield* readyCurrentResult('900');
      let calls = 0;
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: () => {
            calls += 1;
            return Effect.succeed(current);
          },
        },
        quotation: {
          verifyQuotation: () => {
            calls += 1;
            return Effect.die('Retained display must not invoke verification');
          },
        },
      });

      const result = yield* service.select({
        kind: 'RETAINED_DISPLAY_ONLY',
        retained: {
          display: {
            candidateRef,
            currencyCode: 'CZK',
            lines: current.commercialTotal.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
              occurrenceId,
              publishedLineValue,
            })),
            monetaryBoundary: 'PRE_TAX',
            pricingNetCommercialTotal: current.commercialTotal.pricingNetCommercialTotal,
          },
          guarantee: 'NONE',
          kind: 'RETAINED_DISPLAY_ONLY',
          retainedAt: current.commercialTotal.decision.operationTime,
        },
      });

      expect(result).toEqual({
        kind: 'MONETARY_AUTHORITY_REJECTED',
        reason: 'RETAINED_DISPLAY_ONLY',
        retryable: false,
      });
      expect(calls).toBe(0);
    }),
  );

  it.effect('fails closed on stale Current output, quote mismatch, and unavailable verification', () =>
    Effect.gen(function* rejectsInvalidAuthority() {
      const quotedCurrent = yield* readyCurrentResult('900');
      const changedCurrent = yield* readyCurrentResult('950');
      const quotation = quoteFor(quotedCurrent);
      const staleService = makePricingAuthoritySelectionService({
        current: { evaluateCurrent: () => Effect.succeed(changedCurrent) },
        quotation: { verifyQuotation: () => Effect.die('unused') },
      });
      expect(
        yield* staleService.select({ candidateRef, kind: 'CURRENT_BACKED', trustedOperationAt: verificationAt }),
      ).toMatchObject({ kind: 'MONETARY_AUTHORITY_REJECTED', reason: 'CURRENT_RESULT_UNVERIFIABLE' });

      const mismatchService = makePricingAuthoritySelectionService({
        current: { evaluateCurrent: () => Effect.die('unused') },
        quotation: {
          verifyQuotation: () => Effect.succeed({ kind: 'QUOTATION_MISMATCHED', reason: 'exact binding changed' }),
        },
      });
      expect(
        yield* mismatchService.select({
          candidateRef,
          kind: 'QUOTATION_BACKED',
          quotation,
          trustedOperationAt: verificationAt,
        }),
      ).toEqual({
        kind: 'MONETARY_AUTHORITY_REJECTED',
        reason: 'QUOTATION_MISMATCHED',
        retryable: false,
      });

      const unavailableService = makePricingAuthoritySelectionService({
        current: { evaluateCurrent: () => Effect.die('unused') },
        quotation: {
          verifyQuotation: () =>
            Effect.fail(
              new PricingAuthorityDependencyFailure({
                message: 'verification owner unavailable',
                owner: 'QUOTATION_VERIFICATION',
                retryable: true,
              }),
            ),
        },
      });
      expect(
        yield* unavailableService.select({
          candidateRef,
          kind: 'QUOTATION_BACKED',
          quotation,
          trustedOperationAt: verificationAt,
        }),
      ).toEqual({
        kind: 'MONETARY_AUTHORITY_REJECTED',
        reason: 'QUOTATION_VERIFICATION_UNAVAILABLE',
        retryable: true,
      });
    }),
  );

  it.effect('rejects a verifier that substitutes freshly repriced terms under the historical reference', () =>
    Effect.gen(function* rejectsRelabelledEvidence() {
      const quotedCurrent = yield* readyCurrentResult('900');
      const changedCurrent = yield* readyCurrentResult('950');
      const quotation = quoteFor(quotedCurrent);
      const service = makePricingAuthoritySelectionService({
        current: { evaluateCurrent: () => Effect.die('Quotation path must not reprice') },
        quotation: {
          verifyQuotation: (request) =>
            Effect.succeed({
              kind: 'QUOTATION_VERIFIED',
              quotation: { ...request.quotation, quotedResult: changedCurrent.commercialTotal },
              verificationRef: 'quotation-verification:782',
              verifiedAt: request.trustedOperationAt,
            }),
        },
      });

      expect(
        yield* service.select({
          candidateRef,
          kind: 'QUOTATION_BACKED',
          quotation,
          trustedOperationAt: verificationAt,
        }),
      ).toEqual({
        kind: 'MONETARY_AUTHORITY_REJECTED',
        reason: 'QUOTATION_UNVERIFIABLE',
        retryable: false,
      });
    }),
  );
});
