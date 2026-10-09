import {
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationRenewedOutcomeSchema,
  PricingCommitmentConfirmationReplacementBundleRequiredSchema,
  PricingCommitmentConfirmationSourceUnverifiableSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationSource,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makePricingCommitmentConfirmationRenewalService } from '../../src/services/commitment-confirmation-renewal.service.ts';
import {
  makePricingQuotationBackedConfirmationIssuanceService,
  PricingQuotationBackedConfirmationBindingRejected,
} from '../../src/services/quotation-backed-confirmation-issuance.service.ts';
import {
  issue788ConfirmationAuthenticity,
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788CurrentSource,
  makeIssue788Quotation,
  makeIssue788QuotationSource,
} from './support/issue-788-confirmation.fixture.ts';

const decodeConfirmation = Schema.decodeUnknownSync(PricingCommitmentConfirmationIssuedSchema, {
  onExcessProperty: 'error',
});

const confirmationFor = (
  input: {
    readonly confirmationRef: string;
    readonly expiresAt: string;
    readonly issuedAt: string;
    readonly source: PricingCommitmentConfirmationSource;
  },
  terms: Effect.Success<ReturnType<typeof makeIssue788CommercialTotal>>,
): PricingCommitmentConfirmationIssued =>
  decodeConfirmation({
    authenticity: {
      ...issue788ConfirmationAuthenticity,
      payloadDigest: `sha256:${input.confirmationRef}`,
      proofRef: `proof:${input.confirmationRef}`,
    },
    binding: makeIssue788Binding(terms),
    confirmationRef: input.confirmationRef,
    expiresAt: input.expiresAt,
    issuedAt: input.issuedAt,
    kind: 'PRICING_COMMITMENT_CONFIRMATION',
    source: input.source,
    terms,
  });

describe('issue #788 Pricing Commitment Confirmation renewal', () => {
  it.effect(
    'reruns Current issuance and creates an overlapping immutable proof for the unchanged Attempt and Bundle',
    () =>
      Effect.gen(function* renewsCurrentProof() {
        const terms = yield* makeIssue788CommercialTotal('950');
        const source = makeIssue788CurrentSource(terms);
        const previous = confirmationFor(
          {
            confirmationRef: 'pricing-confirmation:788:current:old',
            expiresAt: '2026-09-28T12:00:30.000Z',
            issuedAt: issue788IssuedAt,
            source,
          },
          terms,
        );
        const renewed = confirmationFor(
          {
            confirmationRef: 'pricing-confirmation:788:current:new',
            expiresAt: '2026-09-28T12:00:40.000Z',
            issuedAt: '2026-09-28T12:00:10.000Z',
            source,
          },
          terms,
        );
        const previousSnapshot = structuredClone(previous);
        let currentRequests: readonly unknown[] = [];
        let quotationCalls = 0;
        const outcome = yield* makePricingCommitmentConfirmationRenewalService({
          currentIssuance: {
            issue: (request) => {
              currentRequests = [...currentRequests, request];
              return Effect.succeed({ _tag: 'ISSUED' as const, confirmation: renewed });
            },
          },
          quotationIssuance: {
            issue: () => {
              quotationCalls += 1;
              return Effect.die('Current renewal must not enter Quotation issuance');
            },
          },
        }).renew({
          binding: previous.binding,
          kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
          previousConfirmation: previous,
        });

        const renewedOutcome = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationRenewedOutcomeSchema)(
          outcome,
        );
        expect(renewedOutcome.confirmation.confirmationRef).toBe(renewed.confirmationRef);
        expect(renewedOutcome.confirmation.expiresAt).toBe(renewed.expiresAt);
        expect(renewedOutcome.confirmation.issuedAt).toBe(renewed.issuedAt);
        expect(renewedOutcome.previousConfirmationRef).toBe(previous.confirmationRef);
        expect(currentRequests).toEqual([{ binding: previous.binding }]);
        expect(quotationCalls).toBe(0);
        expect(renewed.issuedAt < previous.expiresAt).toBe(true);
        expect(previous).toEqual(previousSnapshot);
      }),
  );

  it.effect(
    'revalidates the same Quotation, preserves quoted 900 terms, and accepts its expiry cap without Current lookup',
    () =>
      Effect.gen(function* renewsQuotedProof() {
        const terms = yield* makeIssue788CommercialTotal('900');
        const quotation = makeIssue788Quotation(terms, 'pricing-quotation:788:renewal', '2026-09-28T12:00:25.000Z');
        const source = makeIssue788QuotationSource(quotation);
        const previous = confirmationFor(
          {
            confirmationRef: 'pricing-confirmation:788:quote:old',
            expiresAt: '2026-09-28T12:00:20.000Z',
            issuedAt: issue788IssuedAt,
            source,
          },
          terms,
        );
        const renewed = confirmationFor(
          {
            confirmationRef: 'pricing-confirmation:788:quote:new',
            expiresAt: quotation.validity.validUntil,
            issuedAt: '2026-09-28T12:00:10.000Z',
            source: {
              ...source,
              quotationRevalidation: {
                ...source.quotationRevalidation,
                authenticityEvidence: {
                  ...source.quotationRevalidation.authenticityEvidence,
                  verifiedAt: '2026-09-28T12:00:10.000Z',
                },
                evaluatedAt: '2026-09-28T12:00:10.000Z',
              },
            },
          },
          terms,
        );
        let currentCalls = 0;
        let quotationRequests: readonly unknown[] = [];
        const outcome = yield* makePricingCommitmentConfirmationRenewalService({
          currentIssuance: {
            issue: () => {
              currentCalls += 1;
              return Effect.die('Quotation renewal must not consult ordinary Current pricing');
            },
          },
          quotationIssuance: {
            issue: (request) => {
              quotationRequests = [...quotationRequests, request];
              return Effect.succeed({ _tag: 'ISSUED' as const, confirmation: renewed });
            },
          },
        }).renew({
          binding: previous.binding,
          kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
          previousConfirmation: previous,
        });

        const renewedOutcome = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationRenewedOutcomeSchema)(
          outcome,
        );
        expect(renewedOutcome.confirmation.expiresAt).toBe(quotation.validity.validUntil);
        expect(renewedOutcome.confirmation.source.kind).toBe('QUOTATION_BACKED');
        expect(renewedOutcome.confirmation.terms.pricingNetCommercialTotal).toEqual({
          amount: '900',
          currencyCode: 'CZK',
        });
        expect(currentCalls).toBe(0);
        expect(quotationRequests).toEqual([
          {
            binding: previous.binding,
            materialEvidence: source.materialEvidence,
            quotation,
            requestedBinding: previous.binding.purchase,
          },
        ]);
      }),
  );

  it.effect('propagates final Quotation Attempt/Bundle rejection without minting a renewal proof', () =>
    Effect.gen(function* rejectsChangedOwnerBinding() {
      const terms = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(terms, 'pricing-quotation:788:binding-rejected');
      const source = makeIssue788QuotationSource(quotation);
      const previous = confirmationFor(
        {
          confirmationRef: 'pricing-confirmation:788:quote:binding-old',
          expiresAt: '2026-09-28T12:00:30.000Z',
          issuedAt: issue788IssuedAt,
          source,
        },
        terms,
      );
      let bindingChecks = 0;
      let proofCalls = 0;
      let revalidationCalls = 0;
      const quotationIssuance = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: {
          verifyUnchangedBinding: ({ binding, issuedAt, source: checkedSource }) => {
            bindingChecks += 1;
            expect(binding).toEqual(previous.binding);
            expect(issuedAt).toBe(issue788IssuedAt);
            expect(checkedSource.quotationRevalidation.quotation.quotationRef).toBe(quotation.quotationRef);
            return Effect.fail(new PricingQuotationBackedConfirmationBindingRejected({ reason: 'BUNDLE_CHANGED' }));
          },
        },
        proofIssuer: {
          issueProof: () => {
            proofCalls += 1;
            return Effect.die('Rejected final Attempt/Bundle binding must fail before proof issuance');
          },
        },
        revalidation: {
          revalidate: () => {
            revalidationCalls += 1;
            return Effect.succeed(source.quotationRevalidation);
          },
        },
      });
      const outcome = yield* makePricingCommitmentConfirmationRenewalService({
        currentIssuance: { issue: () => Effect.die('Quotation renewal must not enter Current issuance') },
        quotationIssuance,
      }).renew({
        binding: previous.binding,
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previous,
      });

      const mismatch = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationBindingMismatchSchema)(outcome);
      expect(mismatch.reason).toBe('BUNDLE_CHANGED');
      expect(mismatch.retryable).toBe(false);
      expect(revalidationCalls).toBe(1);
      expect(bindingChecks).toBe(1);
      expect(proofCalls).toBe(0);
    }),
  );

  it.effect('requires a replacement Bundle before issuance when Bundle identity changed', () =>
    Effect.gen(function* rejectsChangedBundle() {
      const terms = yield* makeIssue788CommercialTotal('950');
      const previous = confirmationFor(
        {
          confirmationRef: 'pricing-confirmation:788:bundle:old',
          expiresAt: '2026-09-28T12:00:30.000Z',
          issuedAt: issue788IssuedAt,
          source: makeIssue788CurrentSource(terms),
        },
        terms,
      );
      let issuanceCalls = 0;
      const unavailable = () => {
        issuanceCalls += 1;
        return Effect.die('Changed Bundle must fail before source evaluation or proof issuance');
      };
      const outcome = yield* makePricingCommitmentConfirmationRenewalService({
        currentIssuance: { issue: unavailable },
        quotationIssuance: { issue: unavailable },
      }).renew({
        binding: { ...previous.binding, decisionBundleHash: 'sha256:changed-bundle' },
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previous,
      });

      const replacement = yield* Schema.decodeUnknownEffect(
        PricingCommitmentConfirmationReplacementBundleRequiredSchema,
      )(outcome);
      expect(replacement.reason).toBe('BUNDLE_CHANGED');
      expect(replacement.retryable).toBe(false);
      expect(issuanceCalls).toBe(0);
    }),
  );

  it.effect('keeps changed terms on the replacement-Bundle path', () =>
    Effect.gen(function* rejectsChangedTermsOrEvidence() {
      const terms900 = yield* makeIssue788CommercialTotal('900');
      const terms950 = yield* makeIssue788CommercialTotal('950');
      const previous = confirmationFor(
        {
          confirmationRef: 'pricing-confirmation:788:terms:old',
          expiresAt: '2026-09-28T12:00:30.000Z',
          issuedAt: issue788IssuedAt,
          source: makeIssue788CurrentSource(terms900),
        },
        terms900,
      );
      const changedTerms = decodeConfirmation({
        ...previous,
        authenticity: {
          ...previous.authenticity,
          payloadDigest: 'sha256:pricing-confirmation:788:terms:new',
          proofRef: 'proof:pricing-confirmation:788:terms:new',
        },
        binding: makeIssue788Binding(terms950),
        confirmationRef: 'pricing-confirmation:788:terms:new',
        expiresAt: '2026-09-28T12:00:40.000Z',
        issuedAt: '2026-09-28T12:00:10.000Z',
        source: makeIssue788CurrentSource(terms950),
        terms: terms950,
      });
      const service = makePricingCommitmentConfirmationRenewalService({
        currentIssuance: { issue: () => Effect.succeed({ _tag: 'ISSUED' as const, confirmation: changedTerms }) },
        quotationIssuance: { issue: () => Effect.die('Wrong path') },
      });
      const outcome = yield* service.renew({
        binding: previous.binding,
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previous,
      });

      // A fresh owner result cannot silently alter the immutable Bundle terms. The separately
      // minted instance is discarded and the caller must replace the Bundle/Attempt explicitly.
      const replacement = yield* Schema.decodeUnknownEffect(
        PricingCommitmentConfirmationReplacementBundleRequiredSchema,
      )(outcome);
      expect(replacement.reason).toBe('TERMS_CHANGED');
      expect(replacement.retryable).toBe(false);
    }),
  );

  it.effect('rejects a proof issuer that reuses the previous immutable confirmation identity', () =>
    Effect.gen(function* rejectsIdentityReuse() {
      const terms = yield* makeIssue788CommercialTotal('950');
      const previous = confirmationFor(
        {
          confirmationRef: 'pricing-confirmation:788:identity:old',
          expiresAt: '2026-09-28T12:00:30.000Z',
          issuedAt: issue788IssuedAt,
          source: makeIssue788CurrentSource(terms),
        },
        terms,
      );
      const outcome = yield* makePricingCommitmentConfirmationRenewalService({
        currentIssuance: { issue: () => Effect.succeed({ _tag: 'ISSUED' as const, confirmation: previous }) },
        quotationIssuance: { issue: () => Effect.die('Wrong path') },
      }).renew({
        binding: previous.binding,
        kind: 'RENEW_PRICING_COMMITMENT_CONFIRMATION',
        previousConfirmation: previous,
      });

      const unverifiable = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationSourceUnverifiableSchema)(
        outcome,
      );
      expect(unverifiable.reason).toBe('CONFIRMATION_IDENTITY_WAS_NOT_RENEWED');
      expect(unverifiable.retryable).toBe(false);
    }),
  );
});
