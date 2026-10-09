import type { PricingCommercialTotalReady } from '@app/pricing-contracts/domain/commercial-total';
import { PRICING_CZK_PUBLICATION_PROFILE } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingCommercialAuthorityResultSchema,
  PricingCommitmentConfirmationReferenceSchema,
  PricingCurrentCommercialResultSchema,
  PricingQuotationBindingSchema,
  PricingQuotationIssuanceRequestSchema,
  PricingQuotationIssuedSchema,
  PricingRetainedDisplayOnlyResultSchema,
} from '@app/pricing-contracts/domain/quotation';
import type { PricingCurrentCommercialResult, PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { projectPricingCommercialTotal } from '../../src/services/commercial-total-projection.service.ts';
import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import {
  PricingAuthorityDependencyFailure,
  makePricingAuthoritySelectionService,
} from '../../src/services/pricing-authority-selection.service.ts';
import type { PricingMonetaryAuthoritySelectionRequest } from '../../src/services/pricing-authority-selection.service.ts';
import { candidateRef, makeIssue779PreRoundScenario, money } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const quotationRef = 'pricing-quotation:782';

const bindingFor = (commercialTotal: PricingCommercialTotalReady) => {
  const { decision } = commercialTotal;
  return Schema.decodeUnknownSync(PricingQuotationBindingSchema)({
    candidateRef: commercialTotal.candidateRef,
    commercialScope: decision.commercialScope,
    currencyCode: decision.currencyCode,
    lines: decision.lines.map(({ catalog, occurrenceId }) => ({
      occurrenceId,
      quantity: { amount: catalog.quantity.resulting, unitRef: catalog.unitRef },
      selection: catalog.selection,
    })),
    monetaryBoundary: decision.monetaryBoundary,
    subject: {
      guestEvidenceRef: 'guest-evidence:782',
      guestSessionRef: 'guest-session:782',
      kind: 'GUEST',
      purchaseContext: {
        contextRef: decision.purchasingContext.contextRef,
        contextRevision: decision.purchasingContext.contextRevision,
      },
    },
    tenantId: decision.tenantId,
  });
};

const currentResultAt = Effect.fn('test.issue782CurrentResultAt')(function* currentResultAtProgram(amount: string) {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    discounts: ['0', '0', '0'],
    priceAmount: amount,
  });
  const [line] = preRound.lines;
  if (line === undefined) {
    return yield* Effect.die('Issue #782 fixture requires one complete Pricing line');
  }
  const commercialTotal = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: [
      {
        occurrenceId: line.occurrenceId,
        publicationProfile: PRICING_CZK_PUBLICATION_PROFILE,
        publishedLineValue: line.nonNegativePreRoundValue,
        roundingAdjustment: money('0'),
      },
    ],
  });
  if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Issue #782 fixture expected ready commercial terms: ${commercialTotal.failure.code}`);
  }
  return {
    commercialTotal,
    kind: 'CURRENT_PRICING_RESULT' as const,
  } satisfies PricingCurrentCommercialResult;
});

const quoteFrom = (commercialTotal: PricingCommercialTotalReady): PricingQuotationIssued => ({
  binding: bindingFor(commercialTotal),
  issuedAt: commercialTotal.decision.operationTime,
  kind: 'PRICING_QUOTATION',
  materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
  quotationRef,
  quotedResult: commercialTotal,
  validity: {
    policyEvidence: {
      maximumValidityDurationMilliseconds: 3_600_000,
      policyRef: 'pricing-quotation-validity:issue-782-fixture',
      policyVersion: '1',
    },
    validFrom: commercialTotal.decision.operationTime,
    validUntil: '2026-09-28T13:00:00.000Z',
  },
});

describe('issue #782 Current Pricing Decision versus Quotation acceptance', () => {
  it.effect('keeps support, retained display, Current, Quotation, and Confirmation as distinct authorities', () =>
    Effect.gen(function* keepsAuthoritiesDistinct() {
      const quotedCurrent = yield* currentResultAt('900');
      const laterCurrent = yield* currentResultAt('950');
      const quote = quoteFrom(quotedCurrent.commercialTotal);
      const display = yield* projectPricingCommercialTotal(quotedCurrent.commercialTotal);
      const retained = {
        display,
        guarantee: 'NONE' as const,
        kind: 'RETAINED_DISPLAY_ONLY' as const,
        retainedAt: quotedCurrent.commercialTotal.decision.operationTime,
      };
      const supportRead = {
        outcome: 'CURRENT_SUPPORTED_CURRENCIES_READY',
        supportedCurrencies: ['CZK'],
      };
      const confirmation = {
        confirmationRef: 'pricing-confirmation:782',
        kind: 'PRICING_COMMITMENT_CONFIRMATION_REFERENCE' as const,
      };

      expect(Schema.is(PricingCurrentCommercialResultSchema)(quotedCurrent)).toBe(true);
      expect(Schema.is(PricingRetainedDisplayOnlyResultSchema)(retained)).toBe(true);
      expect(Schema.is(PricingQuotationIssuedSchema)(quote)).toBe(true);
      expect(Schema.is(PricingCommitmentConfirmationReferenceSchema)(confirmation)).toBe(true);
      expect(Schema.is(PricingCurrentCommercialResultSchema)(supportRead)).toBe(false);
      expect(Schema.is(PricingCurrentCommercialResultSchema)(retained)).toBe(false);
      expect(Schema.is(PricingQuotationIssuedSchema)(retained)).toBe(false);
      expect(Schema.is(PricingQuotationIssuedSchema)(confirmation)).toBe(false);
      expect(Schema.is(PricingCommercialAuthorityResultSchema)(supportRead)).toBe(false);
      expect(Schema.is(PricingCommercialAuthorityResultSchema)(laterCurrent)).toBe(true);
      expect(Schema.is(PricingCommercialAuthorityResultSchema)(quote)).toBe(true);

      expect(
        Schema.is(PricingQuotationIssuanceRequestSchema)({
          currentResult: retained,
          issuedAt: quote.issuedAt,
          kind: 'ISSUE_PRICING_QUOTATION',
          validity: quote.validity,
        }),
      ).toBe(false);
      expect(confirmation).not.toHaveProperty('quotedResult');
      expect(confirmation).not.toHaveProperty('commercialTotal');
    }),
  );

  it.effect('preserves quoted 900 CZK terms and complete original evidence beside fresh Current 950 CZK', () =>
    Effect.gen(function* preservesQuotedTerms() {
      const quotedCurrent = yield* currentResultAt('900');
      const laterCurrent = yield* currentResultAt('950');
      const quote = quoteFrom(quotedCurrent.commercialTotal);

      expect(quote.quotedResult.pricingNetCommercialTotal).toEqual(money('900'));
      expect(laterCurrent.commercialTotal.pricingNetCommercialTotal).toEqual(money('950'));
      expect(quote.quotedResult).toEqual(quotedCurrent.commercialTotal);
      expect(quote.quotedResult.sourceEvidence).toEqual(quotedCurrent.commercialTotal.sourceEvidence);
      expect(quote.quotedResult.sourceEvidence).not.toEqual(laterCurrent.commercialTotal.sourceEvidence);
      expect(quote.quotedResult.decision.monetaryBoundary).toBe('PRE_TAX');
      expect(quote.quotedResult.decision.currencyCode).toBe('CZK');
      const encodedQuote = yield* encodeJson(quote);
      expect(encodedQuote).not.toContain('storefront');
      expect(encodedQuote).not.toContain('exchangeRate');
      expect(encodedQuote).not.toContain('EUR');
    }),
  );

  it.effect('selects fresh Current terms but verifies quoted terms without ordinary repricing', () =>
    Effect.gen(function* selectsOnlyRequestedAuthority() {
      const quotedCurrent = yield* currentResultAt('900');
      const laterCurrent = yield* currentResultAt('950');
      const quote = quoteFrom(quotedCurrent.commercialTotal);
      let currentCalls = 0;
      let quotationCalls = 0;
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: () => {
            currentCalls += 1;
            return Effect.succeed(laterCurrent);
          },
        },
        quotation: {
          verifyQuotation: ({ quotation, trustedOperationAt }) => {
            quotationCalls += 1;
            return Effect.succeed({
              kind: 'QUOTATION_VERIFIED' as const,
              quotation,
              verificationRef: 'quotation-verification:782',
              verifiedAt: trustedOperationAt,
            });
          },
        },
      });

      const current = yield* service.select({
        candidateRef,
        kind: 'CURRENT_BACKED',
        trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
      });
      expect(current).toMatchObject({
        commercialTotal: { pricingNetCommercialTotal: money('950') },
        kind: 'CURRENT_BACKED_TERMS_SELECTED',
      });
      expect(currentCalls).toBe(1);
      expect(quotationCalls).toBe(0);

      const quoted = yield* service.select({
        candidateRef,
        kind: 'QUOTATION_BACKED',
        quotation: quote,
        trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
      });
      expect(quoted).toMatchObject({
        commercialTotal: { pricingNetCommercialTotal: money('900') },
        kind: 'QUOTATION_BACKED_TERMS_SELECTED',
        quotation: quote,
      });
      expect(currentCalls).toBe(1);
      expect(quotationCalls).toBe(1);
    }),
  );

  it.effect('refuses retained display and distinguishes Current outage from unverifiable Quotation', () =>
    Effect.gen(function* distinguishesOutageAndVerificationFailure() {
      const quotedCurrent = yield* currentResultAt('900');
      const quote = quoteFrom(quotedCurrent.commercialTotal);
      const display = yield* projectPricingCommercialTotal(quotedCurrent.commercialTotal);
      let currentCalls = 0;
      let quotationCalls = 0;
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: () => {
            currentCalls += 1;
            return Effect.fail(
              new PricingAuthorityDependencyFailure({
                message: 'Ordinary Current source is unavailable',
                owner: 'CURRENT_PRICING',
                retryable: true,
              }),
            );
          },
        },
        quotation: {
          verifyQuotation: () => {
            quotationCalls += 1;
            return Effect.succeed({
              kind: 'QUOTATION_UNVERIFIABLE' as const,
              reason: 'Quotation authenticity cannot currently be established',
            });
          },
        },
      });

      expect(
        yield* service.select({
          kind: 'RETAINED_DISPLAY_ONLY',
          retained: {
            display,
            guarantee: 'NONE',
            kind: 'RETAINED_DISPLAY_ONLY',
            retainedAt: quotedCurrent.commercialTotal.decision.operationTime,
          },
        }),
      ).toEqual({ kind: 'MONETARY_AUTHORITY_REJECTED', reason: 'RETAINED_DISPLAY_ONLY', retryable: false });
      expect(currentCalls).toBe(0);
      expect(quotationCalls).toBe(0);

      expect(
        yield* service.select({
          candidateRef,
          kind: 'CURRENT_BACKED',
          trustedOperationAt: quotedCurrent.commercialTotal.decision.operationTime,
        }),
      ).toEqual({
        kind: 'MONETARY_AUTHORITY_REJECTED',
        reason: 'CURRENT_EVALUATION_UNAVAILABLE',
        retryable: true,
      });
      expect(
        yield* service.select({
          candidateRef,
          kind: 'QUOTATION_BACKED',
          quotation: quote,
          trustedOperationAt: quotedCurrent.commercialTotal.decision.operationTime,
        }),
      ).toEqual({ kind: 'MONETARY_AUTHORITY_REJECTED', reason: 'QUOTATION_UNVERIFIABLE', retryable: true });
    }),
  );

  it.effect('does not forward Storefront as a monetary selector to either owner path', () =>
    Effect.gen(function* doesNotForwardStorefront() {
      const quotedCurrent = yield* currentResultAt('900');
      const laterCurrent = yield* currentResultAt('950');
      const quote = quoteFrom(quotedCurrent.commercialTotal);
      const observedRequests: unknown[] = [];
      const service = makePricingAuthoritySelectionService({
        current: {
          evaluateCurrent: (request) => {
            observedRequests.push(request);
            return Effect.succeed(laterCurrent);
          },
        },
        quotation: {
          verifyQuotation: (request) => {
            observedRequests.push(request);
            return Effect.succeed({
              kind: 'QUOTATION_VERIFIED' as const,
              quotation: request.quotation,
              verificationRef: 'quotation-verification:storefront-invariant',
              verifiedAt: request.trustedOperationAt,
            });
          },
        },
      });

      const injectedCurrentRequest = {
        candidateRef,
        kind: 'CURRENT_BACKED',
        storefrontId: 'storefront-a',
        trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
      } satisfies PricingMonetaryAuthoritySelectionRequest & { readonly storefrontId: string };
      const injectedQuotationRequest = {
        candidateRef,
        kind: 'QUOTATION_BACKED',
        quotation: quote,
        storefrontId: 'storefront-b',
        trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
      } satisfies PricingMonetaryAuthoritySelectionRequest & { readonly storefrontId: string };

      yield* service.select(injectedCurrentRequest);
      yield* service.select(injectedQuotationRequest);

      expect(observedRequests).toEqual([
        {
          candidateRef,
          trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
        },
        {
          candidateRef,
          quotation: quote,
          trustedOperationAt: laterCurrent.commercialTotal.decision.operationTime,
        },
      ]);
      expect(yield* encodeJson(observedRequests)).not.toContain('storefront');
    }),
  );
});
