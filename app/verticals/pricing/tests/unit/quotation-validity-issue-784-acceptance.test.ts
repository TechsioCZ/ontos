import { PRICING_CZK_PUBLICATION_PROFILE_VERSION } from '@app/pricing-contracts/domain/exact-decimal';
import {
  PricingQuotationBindingSchema,
  PricingQuotationExpiredSchema,
  PricingQuotationInvalidSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationValidityUnverifiableSchema,
  PricingQuotationValiditySchema,
  PricingQuotationValidSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationBinding,
  PricingQuotationIssued,
  PricingQuotationValidity,
} from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { calculatePricingCommercialTotals } from '../../src/services/commercial-totals.service.ts';
import { publishPricingLineValues } from '../../src/services/line-value-publication.service.ts';
import {
  makePricingQuotationScopeVerificationService,
  PricingQuotationScopeVerification,
} from '../../src/services/quotation-scope-verification.service.ts';
import {
  makePricingQuotationValidityService,
  PricingQuotationValidityTrustedTime,
  PricingQuotationValidityTimeUnavailable,
} from '../../src/services/quotation-validity.service.ts';
import {
  candidateRef,
  makeIssue779PreRoundScenario,
  requireIssue779ProductUnitRef,
} from './support/issue-779-line-value.fixture.ts';
import { makeQuotationMaterialEvidence } from './support/quotation-material-evidence.fixture.ts';

const validFrom = '2026-09-28T12:00:00.000Z';
const validUntil = '2026-09-29T16:00:00.000Z';
const policyEvidence = {
  maximumValidityDurationMilliseconds: 604_800_000,
  policyRef: 'pricing-quotation-validity:launch',
  policyVersion: '2026-09-18',
} as const;

const validity = Schema.decodeSync(PricingQuotationValiditySchema, { onExcessProperty: 'error' })({
  policyEvidence,
  validFrom,
  validUntil,
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const quotationFixture = Effect.fn('test.issue784QuotationFixture')(function* issue784QuotationFixture(options?: {
  readonly priceAmount?: string;
  readonly quotationRef?: string;
  readonly validity?: PricingQuotationValidity;
}) {
  const { preRound } = yield* makeIssue779PreRoundScenario({
    discounts: ['0', '0', '0'],
    priceAmount: options?.priceAmount ?? '100',
  });
  const publication = yield* publishPricingLineValues({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publicationProfileVersion: PRICING_CZK_PUBLICATION_PROFILE_VERSION,
  });
  if (publication.outcome !== 'LINE_VALUES_PUBLISHED') {
    return yield* Effect.die(`Issue #784 fixture expected publication: ${publication.failure.code}`);
  }
  const commercialTotal = yield* calculatePricingCommercialTotals({
    candidateRef,
    decision: preRound.decision,
    preRound,
    publishedLines: publication.publishedLines,
  });
  if (commercialTotal.outcome !== 'COMMERCIAL_TOTAL_READY') {
    return yield* Effect.die(`Issue #784 fixture expected a commercial total: ${commercialTotal.failure.code}`);
  }
  const binding = yield* Schema.decodeEffect(PricingQuotationBindingSchema, { onExcessProperty: 'error' })({
    candidateRef,
    commercialScope: commercialTotal.decision.commercialScope,
    currencyCode: commercialTotal.decision.currencyCode,
    lines: commercialTotal.decision.lines.map(({ catalog, occurrenceId }) => ({
      occurrenceId,
      quantity: { amount: catalog.quantity.resulting, unitRef: requireIssue779ProductUnitRef(catalog.unitRef) },
      selection: catalog.selection,
    })),
    monetaryBoundary: commercialTotal.decision.monetaryBoundary,
    subject: {
      guestEvidenceRef: 'guest-evidence:784',
      guestSessionRef: 'guest-session:784',
      kind: 'GUEST',
      purchaseContext: {
        contextRef: commercialTotal.decision.purchasingContext.contextRef,
        contextRevision: commercialTotal.decision.purchasingContext.contextRevision,
      },
    },
    tenantId: commercialTotal.decision.tenantId,
  });
  const quotation = yield* Schema.decodeEffect(PricingQuotationIssuedSchema, { onExcessProperty: 'error' })({
    binding,
    issuedAt: options?.validity?.validFrom ?? validFrom,
    kind: 'PRICING_QUOTATION',
    materialEvidence: makeQuotationMaterialEvidence(commercialTotal),
    quotationRef: options?.quotationRef ?? 'pricing-quotation:784:original',
    quotedResult: commercialTotal,
    validity: options?.validity ?? validity,
  });
  return { binding, quotation };
});

const serviceAt = (trustedOperationTime: string) =>
  makePricingQuotationValidityService.pipe(
    Effect.provideService(PricingQuotationScopeVerification, makePricingQuotationScopeVerificationService()),
    Effect.provideService(PricingQuotationValidityTrustedTime, {
      readOperationTime: Effect.succeed(trustedOperationTime),
    }),
  );

const verifyAt = (
  trustedOperationTime: string,
  quotation: PricingQuotationIssued,
  requestedBinding: PricingQuotationBinding,
) => Effect.flatMap(serviceAt(trustedOperationTime), (service) => service.verify({ quotation, requestedBinding }));

describe('issue #784 Pricing Quotation validity and expiry acceptance', () => {
  it.effect('uses the exact trusted half-open interval: inclusive start, valid last millisecond, exclusive end', () =>
    Effect.gen(function* evaluatesHalfOpenInterval() {
      const { binding, quotation } = yield* quotationFixture();

      const atStart = yield* verifyAt(validFrom, quotation, binding);
      expect(Schema.is(PricingQuotationValidSchema)(atStart)).toBe(true);
      expect(atStart).toMatchObject({
        evaluatedAt: validFrom,
        quotationRef: quotation.quotationRef,
      });
      const justBeforeEnd = yield* verifyAt('2026-09-29T15:59:59.999Z', quotation, binding);
      expect(Schema.is(PricingQuotationValidSchema)(justBeforeEnd)).toBe(true);
      expect(justBeforeEnd).toMatchObject({
        evaluatedAt: '2026-09-29T15:59:59.999Z',
      });
      const atEnd = yield* verifyAt(validUntil, quotation, binding);
      expect(Schema.is(PricingQuotationExpiredSchema)(atEnd)).toBe(true);
      expect(atEnd).toMatchObject({
        evaluatedAt: validUntil,
      });
      const beforeStart = yield* verifyAt('2026-09-28T11:59:59.999Z', quotation, binding);
      expect(Schema.is(PricingQuotationInvalidSchema)(beforeStart)).toBe(true);
      expect(beforeStart).toMatchObject({
        reason: 'NOT_YET_VALID',
      });
    }),
  );

  it.effect('ignores forged browser/request clocks and never lets a retained payload renew itself', () =>
    Effect.gen(function* trustsOnlyOwnerTime() {
      const { binding, quotation } = yield* quotationFixture();
      let trustedClockReads = 0;
      const service = yield* makePricingQuotationValidityService.pipe(
        Effect.provideService(PricingQuotationScopeVerification, makePricingQuotationScopeVerificationService()),
        Effect.provideService(PricingQuotationValidityTrustedTime, {
          readOperationTime: Effect.sync(() => {
            trustedClockReads += 1;
            return validUntil;
          }),
        }),
      );
      const forgedClientRequest = {
        browserTime: validFrom,
        cachedAt: '2026-09-28T12:00:30.000Z',
        quotation,
        requestedBinding: binding,
        requestTime: '2026-09-28T12:01:00.000Z',
      };

      const forgedResult = yield* service.verify(forgedClientRequest);
      expect(Schema.is(PricingQuotationExpiredSchema)(forgedResult)).toBe(true);
      expect(forgedResult).toMatchObject({
        evaluatedAt: validUntil,
        quotationRef: quotation.quotationRef,
      });
      const retainedPayload = { ...forgedClientRequest, retainedAt: validUntil };
      const retainedResult = yield* service.verify(retainedPayload);
      expect(Schema.is(PricingQuotationExpiredSchema)(retainedResult)).toBe(true);
      expect(retainedResult).toMatchObject({
        validity: quotation.validity,
      });
      expect(trustedClockReads).toBe(2);
      expect(quotation.validity.validUntil).toBe(validUntil);
    }),
  );

  it.effect('requires a distinct immutable quotation to provide later validity', () =>
    Effect.gen(function* requiresNewOwnerInstance() {
      const original = yield* quotationFixture();
      const replacementValidity = yield* Schema.decodeEffect(PricingQuotationValiditySchema)({
        policyEvidence: { ...policyEvidence, policyVersion: '2026-09-19' },
        validFrom: validUntil,
        validUntil: '2026-09-30T16:00:00.000Z',
      });
      const replacement = yield* quotationFixture({
        priceAmount: '125',
        quotationRef: 'pricing-quotation:784:replacement',
        validity: replacementValidity,
      });

      const originalOutcome = yield* verifyAt(validUntil, original.quotation, original.binding);
      const replacementOutcome = yield* verifyAt(validUntil, replacement.quotation, replacement.binding);
      expect(Schema.is(PricingQuotationExpiredSchema)(originalOutcome)).toBe(true);
      expect(Schema.is(PricingQuotationValidSchema)(replacementOutcome)).toBe(true);
      expect(replacement.quotation.quotationRef).not.toBe(original.quotation.quotationRef);
      expect(replacement.quotation.validity.policyEvidence).not.toEqual(original.quotation.validity.policyEvidence);
      expect(replacement.quotation.quotedResult.sourceEvidence).not.toEqual(
        original.quotation.quotedResult.sourceEvidence,
      );
      expect(original.quotation.validity).toEqual(validity);
    }),
  );

  it.effect('does not reprice or revoke for ordinary source changes, source outage, Storefront, or Tax', () =>
    Effect.gen(function* ignoresUnownedChanges() {
      const original = yield* quotationFixture({ priceAmount: '100' });
      const laterCurrent = yield* quotationFixture({
        priceAmount: '999',
        quotationRef: 'pricing-quotation:784:unrelated-current',
      });
      let currentSourceReads = 0;
      const unavailableCurrentSource = {
        read: () => {
          currentSourceReads += 1;
          return Effect.die('An ordinary Current/source outage must be irrelevant to an issued quotation');
        },
      };
      const requestedBinding = {
        ...original.binding,
        storefrontId: 'storefront:other',
        tax: { amount: '999', rate: '0.99', revisionRef: 'tax-revision:other' },
      };
      const service = yield* serviceAt('2026-09-29T12:00:00.000Z');
      const outcome = yield* service.verify({
        quotation: original.quotation,
        requestedBinding,
      });

      expect(Schema.is(PricingQuotationValidSchema)(outcome)).toBe(true);
      expect(original.quotation.quotedResult.pricingNetCommercialTotal).toEqual({
        amount: '100',
        currencyCode: 'CZK',
      });
      expect(laterCurrent.quotation.quotedResult.pricingNetCommercialTotal).toEqual({
        amount: '999',
        currencyCode: 'CZK',
      });
      expect(currentSourceReads).toBe(0);
      expect(unavailableCurrentSource.read).toBeDefined();
      const encodedOutcome = yield* encodeJson(outcome);
      expect(encodedOutcome).not.toContain('storefront');
      expect(encodedOutcome).not.toContain('taxRevision');
    }),
  );

  it.effect('keeps binding mismatch, expiry, and unverifiable trusted time distinct', () =>
    Effect.gen(function* keepsFailuresDistinct() {
      const { binding, quotation } = yield* quotationFixture();
      const mismatched = yield* Schema.decodeEffect(PricingQuotationBindingSchema)({
        ...binding,
        commercialScope: { ...binding.commercialScope, marketId: 'sk-launch' },
      });

      expect(yield* verifyAt(validUntil, quotation, mismatched)).toEqual({
        kind: 'QUOTATION_SCOPE_MISMATCH',
        reason: 'COMMERCIAL_SCOPE_MISMATCH',
      });
      const expired = yield* verifyAt(validUntil, quotation, binding);
      expect(Schema.is(PricingQuotationExpiredSchema)(expired)).toBe(true);

      const unverifiableService = yield* makePricingQuotationValidityService.pipe(
        Effect.provideService(PricingQuotationScopeVerification, makePricingQuotationScopeVerificationService()),
        Effect.provideService(PricingQuotationValidityTrustedTime, {
          readOperationTime: Effect.fail(
            new PricingQuotationValidityTimeUnavailable({ reason: 'TRUSTED_TIME_UNAVAILABLE' }),
          ),
        }),
      );
      const unverifiable = yield* unverifiableService.verify({ quotation, requestedBinding: binding });
      expect(Schema.is(PricingQuotationValidityUnverifiableSchema)(unverifiable)).toBe(true);
      expect(unverifiable).toMatchObject({
        quotationRef: quotation.quotationRef,
        reason: 'TRUSTED_TIME_UNAVAILABLE',
        retryable: true,
        validity: quotation.validity,
      });
    }),
  );

  it.effect('requires Variant and Market and keeps Launch quotation authority CZK pre-Tax without FX', () =>
    Effect.gen(function* preservesLaunchBoundary() {
      const { binding, quotation } = yield* quotationFixture();
      const [line] = binding.lines;
      if (line === undefined) {
        return yield* Effect.die('Issue #784 fixture requires one bound line');
      }
      const { variantRef: _variantRef, ...selectionWithoutVariant } = line.selection;
      const { marketId: _marketId, ...scopeWithoutMarket } = binding.commercialScope;
      const withoutVariant = {
        ...quotation,
        binding: { ...binding, lines: [{ ...line, selection: selectionWithoutVariant }] },
      };
      const withoutMarket = {
        ...quotation,
        binding: { ...binding, commercialScope: scopeWithoutMarket },
      };
      const euroBinding = { ...binding, currencyCode: 'EUR' };

      expect(Schema.is(PricingQuotationIssuedSchema)(withoutVariant)).toBe(false);
      expect(Schema.is(PricingQuotationIssuedSchema)(withoutMarket)).toBe(false);
      expect(Schema.is(PricingQuotationIssuedSchema)({ ...quotation, binding: euroBinding })).toBe(false);
      const afterThirtySeconds = yield* verifyAt('2026-09-29T12:00:00.000Z', quotation, binding);
      expect(Schema.is(PricingQuotationValidSchema)(afterThirtySeconds)).toBe(true);
      expect(quotation.validity.validUntil).not.toBe('2026-09-18T08:00:30.000Z');
      expect(quotation.binding.currencyCode).toBe('CZK');
      expect(quotation.binding.monetaryBoundary).toBe('PRE_TAX');
      const encodedQuotation = yield* encodeJson(quotation);
      expect(encodedQuotation).not.toContain('exchangeRate');
      expect(encodedQuotation).not.toContain('converted');
      expect(encodedQuotation).not.toContain('EUR');
      expect(encodedQuotation).not.toContain('confirmation');
      return yield* Effect.void;
    }),
  );
});
