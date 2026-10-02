import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import { ExactPriceFoundResolutionSchema } from '@app/pricing-contracts/domain/exact-price-resolution';
import { PricingQuotationIssuanceRequestSchema } from '@app/pricing-contracts/domain/quotation';
import type { PricingRetainedDisplayOnlyResult } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  makePricingQuotationIssuanceService,
  PricingQuotationIssuanceRejected,
  PricingQuotationIssuanceUnavailable,
} from '../../src/services/quotation-issuance.service.ts';
import { candidateRef, makeIssue779PreRoundScenario } from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const quotationRef = 'pricing-quotation:782';

const readyRequest = Effect.fn('test.issue782ReadyIssuanceRequest')(function* readyIssuanceRequest(
  priceAmount = '900',
  requestedOccurrenceId?: string,
) {
  const scenarioOptions =
    requestedOccurrenceId === undefined
      ? { discounts: ['0', '0', '0'] as const, priceAmount }
      : { discounts: ['0', '0', '0'] as const, occurrenceId: requestedOccurrenceId, priceAmount };
  const { preRound } = yield* makeIssue779PreRoundScenario(scenarioOptions);
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
  const { decision } = commercialTotal;
  return yield* Schema.decodeEffect(PricingQuotationIssuanceRequestSchema)({
    binding: {
      candidateRef,
      commercialScope: decision.commercialScope,
      currencyCode: decision.currencyCode,
      lines: decision.lines.map(({ catalog, occurrenceId }) => ({
        occurrenceId,
        quantity: { amount: catalog.quantity.resulting, unitRef: catalog.unitRef },
        selection: catalog.selection,
      })),
      monetaryBoundary: decision.monetaryBoundary,
      subject: {
        guestEvidenceRef: 'guest-evidence:783',
        guestSessionRef: 'guest-session:783',
        kind: 'GUEST',
        purchaseContext: {
          contextRef: decision.purchasingContext.contextRef,
          contextRevision: decision.purchasingContext.contextRevision,
        },
      },
      tenantId: decision.tenantId,
    },
    currentResult: { commercialTotal, kind: 'CURRENT_PRICING_RESULT' },
    kind: 'ISSUE_PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
  });
});

const issuer = {
  issueReference: () => Effect.succeed(quotationRef),
};

const trustedTimeAt = (operationTime: string) => ({
  readOperationTime: Effect.succeed(operationTime),
});

const acceptingAuthority = {
  verifyIssuanceAuthority: () => Effect.void,
};

const validityPolicy = {
  selectValidity: () =>
    Effect.succeed({
      durationMilliseconds: 15 * 60 * 1000,
      policyEvidence: {
        maximumValidityDurationMilliseconds: 24 * 60 * 60 * 1000,
        policyRef: 'pricing-quotation-validity:launch',
        policyVersion: '1',
      },
    }),
};

const ownerBoundary = { ...acceptingAuthority, ...issuer, ...validityPolicy };

describe('Pricing Quotation issuance', () => {
  it.effect('issues only through the explicit backend boundary and preserves the complete 900 CZK result', () =>
    Effect.gen(function* issuesExactCurrentResult() {
      const request = yield* readyRequest();
      const { operationTime } = request.currentResult.commercialTotal.decision;
      const result = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTimeAt(operationTime)).issue(
        request,
      );

      expect(result).toMatchObject({
        issuedAt: operationTime,
        kind: 'PRICING_QUOTATION',
        quotationRef,
        quotedResult: {
          decision: { currencyCode: 'CZK', monetaryBoundary: 'PRE_TAX' },
          outcome: 'COMMERCIAL_TOTAL_READY',
          pricingNetCommercialTotal: { amount: '900', currencyCode: 'CZK' },
        },
        validity: {
          policyEvidence: {
            maximumValidityDurationMilliseconds: 86_400_000,
            policyRef: 'pricing-quotation-validity:launch',
            policyVersion: '1',
          },
          validFrom: operationTime,
          validUntil: '2026-09-28T12:15:00.000Z',
        },
      });
      expect(result.binding).toEqual(request.binding);
      expect(result.materialEvidence).toEqual(request.materialEvidence);
      expect(result.quotedResult).toEqual(request.currentResult.commercialTotal);
      expect(
        Schema.is(ExactPriceFoundResolutionSchema)(
          result.quotedResult.sourceEvidence.preRound.lines[0]?.composition.unitPriceCalculation.input.exactPrice,
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects replay of an old Current result at a later backend-trusted operation instant', () =>
    Effect.gen(function* rejectsEarlierRead() {
      const request = yield* readyRequest();
      const originalOperationTime = request.currentResult.commercialTotal.decision.operationTime;
      const failure = yield* makePricingQuotationIssuanceService(
        ownerBoundary,
        trustedTimeAt('2026-09-28T12:00:00.001Z'),
      )
        .issue(request)
        .pipe(Effect.flip);

      expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'CURRENT_RESULT_NOT_FRESH' }));

      const fresh = yield* makePricingQuotationIssuanceService(
        ownerBoundary,
        trustedTimeAt(originalOperationTime),
      ).issue(request);
      expect(fresh.issuedAt).toBe(originalOperationTime);
    }),
  );

  it.effect('does not accept retained display, Cart, cache, Approval, or a client-supplied quotation reference', () =>
    Effect.gen(function* rejectsNonCurrentAuthority() {
      const request = yield* readyRequest();
      const retained: PricingRetainedDisplayOnlyResult = {
        display: {
          candidateRef,
          currencyCode: 'CZK',
          lines: request.currentResult.commercialTotal.publishedLines.map(({ occurrenceId, publishedLineValue }) => ({
            occurrenceId,
            publishedLineValue,
          })),
          monetaryBoundary: 'PRE_TAX',
          pricingNetCommercialTotal: request.currentResult.commercialTotal.pricingNetCommercialTotal,
        },
        guarantee: 'NONE',
        kind: 'RETAINED_DISPLAY_ONLY',
        retainedAt: request.currentResult.commercialTotal.decision.operationTime,
      };
      const trustedTime = trustedTimeAt(request.currentResult.commercialTotal.decision.operationTime);
      const failure = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTime)
        .issue(retained)
        .pipe(Effect.flip);

      expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));
      const clientDecoratedRequest = {
        ...request,
        approvalRef: 'approval:must-not-authorize-pricing',
        cartRef: 'cart:must-not-issue',
        issuedAt: request.currentResult.commercialTotal.decision.operationTime,
        quotationRef: 'client-forged:quotation',
        validity: {
          validFrom: request.currentResult.commercialTotal.decision.operationTime,
          validUntil: '2099-01-01T00:00:00.000Z',
        },
      };
      const decoratedFailure = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTime)
        .issue(clientDecoratedRequest)
        .pipe(Effect.flip);
      expect(decoratedFailure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));

      const issued = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTime).issue(request);
      const reissueFailure = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTime)
        // @ts-expect-error An issued Quotation cannot inhabit the issuance request type.
        .issue(issued)
        .pipe(Effect.flip);
      expect(reissueFailure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));
    }),
  );

  it.effect('returns a typed retryable failure when the owner cannot mint a valid reference', () =>
    Effect.gen(function* rejectsInvalidOwnerReference() {
      const request = yield* readyRequest();
      const failure = yield* makePricingQuotationIssuanceService(
        { ...acceptingAuthority, ...validityPolicy, issueReference: () => Effect.succeed('') },
        trustedTimeAt(request.currentResult.commercialTotal.decision.operationTime),
      )
        .issue(request)
        .pipe(Effect.flip);

      expect(failure).toEqual(
        new PricingQuotationIssuanceUnavailable({
          reason: 'REFERENCE_ISSUANCE_UNAVAILABLE',
          retryable: true,
        }),
      );
    }),
  );

  it.effect('rejects incomplete or ambiguous exact purchase bindings before owner authority or reference minting', () =>
    Effect.gen(function* rejectsIncompleteBinding() {
      const request = yield* readyRequest();
      const [firstLine] = request.binding.lines;
      if (firstLine === undefined) {
        throw new Error('Issue #783 fixture requires one bound line');
      }
      const { productRef: _productRef, ...selectionWithoutProduct } = firstLine.selection;
      const { variantRef: _variantRef, ...selectionWithoutVariant } = firstLine.selection;
      const { marketId: _marketId, ...scopeWithoutMarket } = request.binding.commercialScope;
      const { amount: _amount, ...quantityWithoutAmount } = firstLine.quantity;
      const { unitRef: _unitRef, ...quantityWithoutUnit } = firstLine.quantity;
      const invalidBindings = [
        {
          ...request.binding,
          lines: [{ ...firstLine, selection: selectionWithoutProduct }],
        },
        {
          ...request.binding,
          lines: [{ ...firstLine, selection: selectionWithoutVariant }],
        },
        { ...request.binding, commercialScope: scopeWithoutMarket },
        { ...request.binding, lines: [{ ...firstLine, quantity: quantityWithoutAmount }] },
        { ...request.binding, lines: [{ ...firstLine, quantity: quantityWithoutUnit }] },
        {
          ...request.binding,
          subject: {
            ...request.binding.subject,
            kind: 'GUEST',
            subjectEvidenceRef: 'subject-evidence:must-not-mix',
            subjectRef: {
              moduleId: 'commerce.customer-context',
              resourceId: 'profile:must-not-mix',
              resourceType: 'commerce.customer-context.retail-customer-profile',
              tenantId: request.binding.tenantId,
            },
          },
        },
      ];
      let authorityCalls = 0;
      let referenceCalls = 0;
      const service = makePricingQuotationIssuanceService(
        {
          issueReference: () => {
            referenceCalls += 1;
            return Effect.succeed(quotationRef);
          },
          ...validityPolicy,
          verifyIssuanceAuthority: () => {
            authorityCalls += 1;
            return Effect.void;
          },
        },
        trustedTimeAt(request.currentResult.commercialTotal.decision.operationTime),
      );

      for (const binding of invalidBindings) {
        // @ts-expect-error The issuance boundary must reject malformed untyped transport input.
        const failure = yield* service.issue({ ...request, binding }).pipe(Effect.flip);
        expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));
      }
      expect(authorityCalls).toBe(0);
      expect(referenceCalls).toBe(0);
    }),
  );

  it.effect('requires the private owner authority to validate the exact binding before reference minting', () =>
    Effect.gen(function* rejectsUnverifiedAuthority() {
      const request = yield* readyRequest();
      let referenceCalls = 0;
      const failure = yield* makePricingQuotationIssuanceService(
        {
          issueReference: () => {
            referenceCalls += 1;
            return Effect.succeed(quotationRef);
          },
          ...validityPolicy,
          verifyIssuanceAuthority: ({ binding, operationTime }) => {
            expect(binding).toEqual(request.binding);
            expect(operationTime).toBe(request.currentResult.commercialTotal.decision.operationTime);
            return Effect.fail(new PricingQuotationIssuanceRejected({ reason: 'AUTHORITY_BINDING_REJECTED' }));
          },
        },
        trustedTimeAt(request.currentResult.commercialTotal.decision.operationTime),
      )
        .issue(request)
        .pipe(Effect.flip);

      expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'AUTHORITY_BINDING_REJECTED' }));
      expect(referenceCalls).toBe(0);
    }),
  );

  it.effect('rejects substituted material evidence even when the quoted monetary terms are unchanged', () =>
    Effect.gen(function* rejectsSubstitutedMaterialEvidence() {
      const original = yield* readyRequest('900', 'line-quotation-original');
      const substitute = yield* readyRequest('900', 'line-quotation-substituted');
      let ownerCalls = 0;
      const failure = yield* makePricingQuotationIssuanceService(
        {
          issueReference: () => {
            ownerCalls += 1;
            return Effect.succeed(quotationRef);
          },
          ...validityPolicy,
          verifyIssuanceAuthority: () => {
            ownerCalls += 1;
            return Effect.void;
          },
        },
        trustedTimeAt(original.currentResult.commercialTotal.decision.operationTime),
      )
        .issue({ ...original, materialEvidence: substitute.materialEvidence })
        .pipe(Effect.flip);

      expect(original.currentResult.commercialTotal.pricingNetCommercialTotal).toEqual(
        substitute.currentResult.commercialTotal.pricingNetCommercialTotal,
      );
      expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));
      expect(ownerCalls).toBe(0);
    }),
  );

  it.effect('rejects material evidence captured after the trusted issuance instant', () =>
    Effect.gen(function* rejectsFutureEvidence() {
      const request = yield* readyRequest();
      const trustedOperationTime = request.currentResult.commercialTotal.decision.operationTime;
      const futureEvidence = makeQuotationMaterialEvidence(
        request.currentResult.commercialTotal,
        '2026-09-28T12:00:00.001Z',
      );
      const failure = yield* makePricingQuotationIssuanceService(ownerBoundary, trustedTimeAt(trustedOperationTime))
        .issue({ ...request, materialEvidence: futureEvidence })
        .pipe(Effect.flip);

      expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_ISSUANCE_REQUEST' }));
    }),
  );

  it.effect('derives a bounded positive interval from owner policy and never from browser input', () =>
    Effect.gen(function* derivesOwnerValidity() {
      const request = yield* readyRequest();
      const {
        currentResult: { commercialTotal },
      } = request;
      const { operationTime } = commercialTotal.decision;
      const rejectedDurations = [0, -1, 86_400_001, 1.5, Number.NaN];

      for (const durationMilliseconds of rejectedDurations) {
        const failure = yield* makePricingQuotationIssuanceService(
          {
            ...acceptingAuthority,
            ...issuer,
            selectValidity: () =>
              Effect.succeed({
                durationMilliseconds,
                policyEvidence: {
                  maximumValidityDurationMilliseconds: 86_400_000,
                  policyRef: 'pricing-quotation-validity:launch',
                  policyVersion: '1',
                },
              }),
          },
          trustedTimeAt(operationTime),
        )
          .issue(request)
          .pipe(Effect.flip);

        expect(failure).toEqual(new PricingQuotationIssuanceRejected({ reason: 'INVALID_VALIDITY_POLICY' }));
      }
    }),
  );

  it.effect('passes exact immutable quoted terms to policy and does not read ordinary sources again', () =>
    Effect.gen(function* preservesQuotedTermsForPolicy() {
      const request = yield* readyRequest('900');
      const {
        currentResult: { commercialTotal },
      } = request;
      const { operationTime } = commercialTotal.decision;
      let policyCalls = 0;
      const result = yield* makePricingQuotationIssuanceService(
        {
          ...acceptingAuthority,
          ...issuer,
          selectValidity: ({ binding, quotedResult, validFrom }) => {
            policyCalls += 1;
            expect(binding).toEqual(request.binding);
            expect(quotedResult).toEqual(commercialTotal);
            expect(validFrom).toBe(operationTime);
            return validityPolicy.selectValidity();
          },
        },
        trustedTimeAt(operationTime),
      ).issue(request);

      expect(policyCalls).toBe(1);
      expect(result.binding).toEqual(request.binding);
      expect(result.quotedResult).toEqual(commercialTotal);
      expect(result.quotedResult.pricingNetCommercialTotal.amount).toBe('900');
    }),
  );
});
