import {
  PricingCommitmentConfirmationAuthenticityInvalidSchema,
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
  PricingCommitmentConfirmationBindingMismatchSchema,
  PricingCommitmentConfirmationExpiredSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationNotYetValidSchema,
  PricingCommitmentConfirmationVerifiedSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingCommitmentConfirmationVerificationService,
  PricingCommitmentConfirmationOwnerVerifier,
  PricingCommitmentConfirmationOwnerVerifierUnavailable,
} from '../../src/services/commitment-confirmation-verification.service.ts';
import type {
  PricingCommitmentConfirmationOwnerVerificationInput,
  PricingCommitmentConfirmationOwnerVerifierService,
} from '../../src/services/commitment-confirmation-verification.service.ts';
import {
  issue788ConfirmationAuthenticity,
  issue788ExpiresAt,
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788Quotation,
  makeIssue788QuotationSource,
} from './support/issue-788-confirmation.fixture.ts';

const decodeConfirmation = Schema.decodeUnknownSync(PricingCommitmentConfirmationIssuedSchema, {
  onExcessProperty: 'error',
});

const makeConfirmation = Effect.fn('test.issue788VerificationConfirmation')(
  function* issue788VerificationConfirmation() {
    const terms = yield* makeIssue788CommercialTotal('900');
    const quotation = makeIssue788Quotation(terms);
    return decodeConfirmation({
      authenticity: issue788ConfirmationAuthenticity,
      binding: makeIssue788Binding(terms),
      confirmationRef: 'pricing-commitment-confirmation:788:verification-a',
      expiresAt: issue788ExpiresAt,
      issuedAt: issue788IssuedAt,
      kind: 'PRICING_COMMITMENT_CONFIRMATION',
      source: makeIssue788QuotationSource(quotation),
      terms,
    });
  },
);

const evidenceFor = (
  confirmation: PricingCommitmentConfirmationIssued,
  verifiedAt: string,
  keyStatus: 'ACTIVE' | 'HISTORICAL' = 'ACTIVE',
): PricingCommitmentConfirmationVerificationEvidence => ({
  authenticityRef: `pricing-confirmation-authenticity:${keyStatus.toLowerCase()}`,
  confirmationRef: confirmation.confirmationRef,
  issuerRef: confirmation.authenticity.issuerRef,
  keyRef: confirmation.authenticity.keyRef,
  keyStatus,
  keyVersion: confirmation.authenticity.keyVersion,
  lineageRef: confirmation.authenticity.lineageRef,
  payloadDigest: confirmation.authenticity.payloadDigest,
  proofRef: confirmation.authenticity.proofRef,
  proofVersion: confirmation.authenticity.proofVersion,
  verifiedAt,
});

const verifyingOwner: PricingCommitmentConfirmationOwnerVerifierService = {
  verifyImmutableConfirmation: ({ confirmation, verifiedAt }) =>
    Effect.succeed({ _tag: 'VERIFIED', authenticityEvidence: evidenceFor(confirmation, verifiedAt) }),
};

const verifyWith = (
  confirmation: PricingCommitmentConfirmationIssued,
  requestedBinding: PricingCommitmentConfirmationBinding,
  attemptedAt: string,
  ownerVerifier: PricingCommitmentConfirmationOwnerVerifierService = verifyingOwner,
) =>
  makePricingCommitmentConfirmationVerificationService.pipe(
    Effect.provideService(PricingCommitmentConfirmationOwnerVerifier, ownerVerifier),
    Effect.flatMap((service) =>
      service.verify({
        attemptedAt,
        confirmation,
        kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
        requestedBinding,
      }),
    ),
  );

describe('Pricing Commitment Confirmation owner verification (#788)', () => {
  it.effect('authenticates the complete immutable instance and exact Attempt plus Bundle binding', () =>
    Effect.gen(function* verifiesCompleteImmutableConfirmation() {
      const confirmation = yield* makeConfirmation();
      let received: PricingCommitmentConfirmationOwnerVerificationInput | undefined;
      const result = yield* verifyWith(confirmation, confirmation.binding, issue788IssuedAt, {
        verifyImmutableConfirmation: (input) => {
          received = input;
          return Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: evidenceFor(input.confirmation, input.verifiedAt),
          });
        },
      });

      expect(received).toEqual({ confirmation, verifiedAt: issue788IssuedAt });
      const verified = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationVerifiedSchema)(result);
      expect(verified.authenticityEvidence).toEqual(evidenceFor(confirmation, issue788IssuedAt));
      expect(verified.confirmation).toEqual(confirmation);
      expect(verified.verifiedAt).toBe(issue788IssuedAt);
      expect(verified.confirmation.source.kind).toBe('QUOTATION_BACKED');
      expect(verified.confirmation.terms.pricingNetCommercialTotal.amount).toBe('900');
    }),
  );

  it.effect('distinguishes exact Attempt, Bundle hash/version, and purchase mismatches', () =>
    Effect.gen(function* rejectsEveryBindingDimension() {
      const confirmation = yield* makeConfirmation();
      const changedQuantity = confirmation.binding.purchase.lines.map((line, index) =>
        index === 0 ? { ...line, quantity: { ...line.quantity, amount: '99' } } : line,
      );
      const cases = [
        [{ ...confirmation.binding, attemptRef: 'order-commitment-attempt:788:other' }, 'ATTEMPT_CHANGED'],
        [{ ...confirmation.binding, decisionBundleHash: 'sha256:changed-bundle' }, 'BUNDLE_CHANGED'],
        [{ ...confirmation.binding, decisionBundleVersion: '2' }, 'BUNDLE_CHANGED'],
        [
          { ...confirmation.binding, purchase: { ...confirmation.binding.purchase, lines: changedQuantity } },
          'QUANTITY_OR_UNIT_CHANGED',
        ],
      ] as const;

      for (const [requestedBinding, reason] of cases) {
        const result = yield* verifyWith(confirmation, requestedBinding, issue788IssuedAt);
        const mismatch = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationBindingMismatchSchema)(result);
        expect(mismatch.confirmationRef).toBe(confirmation.confirmationRef);
        expect(mismatch.reason).toBe(reason);
        expect(mismatch.retryable).toBe(false);
      }
    }),
  );

  it.effect('uses the trusted half-open interval before, at, and after both boundaries', () =>
    Effect.gen(function* verifiesHalfOpenInterval() {
      const confirmation = yield* makeConfirmation();
      const before = yield* verifyWith(confirmation, confirmation.binding, '2026-09-28T11:59:59.999Z');
      const atStart = yield* verifyWith(confirmation, confirmation.binding, issue788IssuedAt);
      const lastMillisecond = yield* verifyWith(confirmation, confirmation.binding, '2026-09-28T12:00:29.999Z');
      const atEnd = yield* verifyWith(confirmation, confirmation.binding, issue788ExpiresAt);
      const after = yield* verifyWith(confirmation, confirmation.binding, '2026-09-28T12:00:30.001Z');

      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationNotYetValidSchema)(before);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationVerifiedSchema)(atStart);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationVerifiedSchema)(lastMillisecond);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationExpiredSchema)(atEnd);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationExpiredSchema)(after);
    }),
  );

  it.effect('rejects over-30-second, quote-cap, and source/terms tampering before owner use', () =>
    Effect.gen(function* rejectsInvalidImmutablePayloads() {
      const confirmation = yield* makeConfirmation();
      const current950 = yield* makeIssue788CommercialTotal('950');
      let verifierCalls = 0;
      const ownerVerifier: PricingCommitmentConfirmationOwnerVerifierService = {
        verifyImmutableConfirmation: () => {
          verifierCalls += 1;
          return Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: evidenceFor(confirmation, issue788IssuedAt),
          });
        },
      };
      const quotationWithShortCap = makeIssue788Quotation(
        confirmation.terms,
        'pricing-quotation:788:short-cap',
        '2026-09-28T12:00:20.000Z',
      );
      const invalidPayloads = [
        { ...confirmation, expiresAt: '2026-09-28T12:00:30.001Z' },
        {
          ...confirmation,
          source: makeIssue788QuotationSource(quotationWithShortCap),
        },
        {
          ...confirmation,
          source: {
            kind: 'QUOTATION_BACKED' as const,
            materialEvidence:
              confirmation.source.kind === 'QUOTATION_BACKED'
                ? confirmation.source.materialEvidence
                : makeIssue788QuotationSource(makeIssue788Quotation(confirmation.terms)).materialEvidence,
            quotationRevalidation: {
              ...(confirmation.source.kind === 'QUOTATION_BACKED'
                ? confirmation.source.quotationRevalidation
                : makeIssue788QuotationSource(makeIssue788Quotation(confirmation.terms)).quotationRevalidation),
              quotation: makeIssue788Quotation(current950, 'pricing-quotation:788:tampered-terms'),
            },
          },
        },
      ];

      for (const invalid of invalidPayloads) {
        const result = yield* verifyWith(invalid, confirmation.binding, issue788IssuedAt, ownerVerifier);
        yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationAuthenticityInvalidSchema)(result);
      }
      expect(verifierCalls).toBe(0);
    }),
  );

  it.effect('keeps quoted 900 terms valid through ordinary Current 950 and source outage', () =>
    Effect.gen(function* ignoresOrdinarySourceChangesAfterIssuance() {
      const confirmation = yield* makeConfirmation();
      const ordinaryCurrentAfterIssuance = yield* makeIssue788CommercialTotal('950');
      let proofChecks = 0;
      const result = yield* verifyWith(confirmation, confirmation.binding, '2026-09-28T12:00:10.000Z', {
        verifyImmutableConfirmation: ({ confirmation: issued, verifiedAt }) => {
          proofChecks += 1;
          return Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: evidenceFor(issued, verifiedAt),
          });
        },
      });

      expect(ordinaryCurrentAfterIssuance.pricingNetCommercialTotal.amount).toBe('950');
      const verified = yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationVerifiedSchema)(result);
      expect(verified.confirmation.terms.pricingNetCommercialTotal.amount).toBe('900');
      expect(proofChecks).toBe(1);
    }),
  );

  it.effect('keeps invalid, unverifiable, expired, and binding mismatch distinct and unusable', () =>
    Effect.gen(function* distinguishesUnusableProofs() {
      const confirmation = yield* makeConfirmation();
      const invalid = yield* verifyWith(confirmation, confirmation.binding, issue788IssuedAt, {
        verifyImmutableConfirmation: () =>
          Effect.succeed({
            _tag: 'AUTHENTICITY_INVALID',
            confirmationRef: confirmation.confirmationRef,
            reason: 'PAYLOAD_TAMPERED',
            retryable: false,
          }),
      });
      const unverifiable = yield* verifyWith(confirmation, confirmation.binding, issue788IssuedAt, {
        verifyImmutableConfirmation: () =>
          Effect.fail(
            new PricingCommitmentConfirmationOwnerVerifierUnavailable({
              reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE',
            }),
          ),
      });
      const expired = yield* verifyWith(confirmation, confirmation.binding, issue788ExpiresAt);
      const mismatch = yield* verifyWith(
        confirmation,
        { ...confirmation.binding, decisionBundleRef: 'order-decision-bundle:788:other' },
        issue788IssuedAt,
      );

      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationAuthenticityInvalidSchema)(invalid);
      const proofUnavailable = yield* Schema.decodeUnknownEffect(
        PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
      )(unverifiable);
      expect(proofUnavailable.confirmationRef).toBe(confirmation.confirmationRef);
      expect(proofUnavailable.reason).toBe('DEPENDENCY_UNAVAILABLE');
      expect(proofUnavailable.retryable).toBe(true);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationExpiredSchema)(expired);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationBindingMismatchSchema)(mismatch);
    }),
  );

  it.effect('rejects owner evidence for another proof or verification instant', () =>
    Effect.gen(function* rejectsReplayedOwnerEvidence() {
      const confirmation = yield* makeConfirmation();
      const wrongReference = yield* verifyWith(confirmation, confirmation.binding, issue788IssuedAt, {
        verifyImmutableConfirmation: ({ confirmation: issued, verifiedAt }) =>
          Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: {
              ...evidenceFor(issued, verifiedAt),
              confirmationRef: 'pricing-commitment-confirmation:788:other',
            },
          }),
      });
      const staleVerification = yield* verifyWith(confirmation, confirmation.binding, '2026-09-28T12:00:10.000Z', {
        verifyImmutableConfirmation: ({ confirmation: issued }) =>
          Effect.succeed({
            _tag: 'VERIFIED',
            authenticityEvidence: evidenceFor(issued, issue788IssuedAt, 'HISTORICAL'),
          }),
      });

      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationAuthenticityInvalidSchema)(wrongReference);
      yield* Schema.decodeUnknownEffect(PricingCommitmentConfirmationAuthenticityInvalidSchema)(staleVerification);
    }),
  );
});
