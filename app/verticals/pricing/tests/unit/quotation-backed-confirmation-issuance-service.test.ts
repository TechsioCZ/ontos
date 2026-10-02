import type { PricingQuotationRevalidationOutcome } from '@app/pricing-contracts/domain/quotation';
import type { PricingCommitmentConfirmationIssuanceOutcome } from '@app/pricing-contracts/domain/commitment-confirmation';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingQuotationBackedConfirmationIssuanceService,
  PricingCommitmentConfirmationProofIssuanceUnavailable,
  PricingQuotationBackedConfirmationBindingRejected,
} from '../../src/services/quotation-backed-confirmation-issuance.service.ts';
import type { PricingQuotationRevalidationService } from '../../src/services/quotation-revalidation.service.ts';
import {
  issue788ConfirmationAuthenticity,
  issue788IssuedAt,
  makeIssue788Binding,
  makeIssue788CommercialTotal,
  makeIssue788MaterialEvidence,
  makeIssue788Quotation,
  makeIssue788QuotationSource,
} from './support/issue-788-confirmation.fixture.ts';

const revalidationService = (outcome: PricingQuotationRevalidationOutcome): PricingQuotationRevalidationService => ({
  revalidate: () => Effect.succeed(outcome),
});

const proofIssuer = (onIssue?: () => void) => ({
  issueProof: () => {
    onIssue?.();
    return Effect.succeed({
      authenticity: issue788ConfirmationAuthenticity,
      confirmationRef: 'pricing-confirmation:788:quotation:a',
    });
  },
});

const verifiedBindingAuthority = (onVerify?: () => void) => ({
  verifyUnchangedBinding: () => {
    onVerify?.();
    return Effect.void;
  },
});

const requireIssued = (outcome: PricingCommitmentConfirmationIssuanceOutcome) =>
  Match.value(outcome).pipe(
    Match.tag('ISSUED', ({ confirmation }) => Effect.succeed(confirmation)),
    Match.orElse((unexpected) => Effect.die(`Expected ISSUED, received ${unexpected._tag}`)),
  );

const bindingMismatchReasonFor = (outcome: PricingCommitmentConfirmationIssuanceOutcome) =>
  Match.value(outcome).pipe(
    Match.tag('BINDING_MISMATCH', ({ reason }) => reason),
    Match.orElse(({ _tag }) => `unexpected:${_tag}`),
  );

const withSwappedCurrencySupportProof = (
  materialEvidence: PricingMaterialEvidenceReady,
): PricingMaterialEvidenceReady => {
  const currencySupport = Schema.decodeUnknownSync(PricingSourceEvidenceVerifiedPresentSchema)(
    materialEvidence.sourceEvidence.currencySupport,
  );
  const verification = {
    kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
    verificationRef: 'pricing:currency-support:swapped-proof:788',
  };
  return {
    ...materialEvidence,
    sourceEvidence: {
      ...materialEvidence.sourceEvidence,
      currencySupport: {
        ...currencySupport,
        completeness: { ...currencySupport.completeness, verification },
        currentFacts: currencySupport.currentFacts.map((fact) => ({ ...fact, verification })),
      },
    },
  };
};

describe('issue #788 quotation-backed Confirmation issuance', () => {
  it.effect('preserves the immutable quoted 900 terms without a Current repricing dependency', () =>
    Effect.gen(function* preservesQuotedTerms() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const ordinaryCurrent950 = yield* makeIssue788CommercialTotal('950');
      const quotation = makeIssue788Quotation(quoted900);
      const source = makeIssue788QuotationSource(quotation);
      let bindingAuthorityCalls = 0;
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: verifiedBindingAuthority(() => {
          bindingAuthorityCalls += 1;
        }),
        proofIssuer: proofIssuer(),
        revalidation: revalidationService(source.quotationRevalidation),
      });

      const outcome = yield* service.issue({
        binding: makeIssue788Binding(quoted900),
        materialEvidence: source.materialEvidence,
        quotation,
        requestedBinding: quotation.binding,
      });

      const confirmation = yield* requireIssued(outcome);
      expect(confirmation.terms.pricingNetCommercialTotal.amount).toBe('900');
      expect(ordinaryCurrent950.pricingNetCommercialTotal.amount).toBe('950');
      expect(confirmation.source.kind).toBe('QUOTATION_BACKED');
      expect(confirmation.issuedAt).toBe(issue788IssuedAt);
      expect(confirmation.expiresAt).toBe('2026-09-28T12:00:30.000Z');
      expect(bindingAuthorityCalls).toBe(1);
    }),
  );

  it.effect('caps the new interval at the source quotation expiry', () =>
    Effect.gen(function* capsAtQuotationExpiry() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quoted900, 'pricing-quotation:788:short', '2026-09-28T12:00:09.000Z');
      const source = makeIssue788QuotationSource(quotation);
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: verifiedBindingAuthority(),
        proofIssuer: proofIssuer(),
        revalidation: revalidationService(source.quotationRevalidation),
      });

      const outcome = yield* service.issue({
        binding: makeIssue788Binding(quoted900),
        materialEvidence: source.materialEvidence,
        quotation,
        requestedBinding: quotation.binding,
      });

      const confirmation = yield* requireIssued(outcome);
      expect(confirmation.expiresAt).toBe('2026-09-28T12:00:09.000Z');
    }),
  );

  it.effect('does not call the owner signer when #785 reports mismatch, expiry, or unverifiability', () =>
    Effect.gen(function* keepsFailuresDistinct() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quoted900);
      const binding = makeIssue788Binding(quoted900);
      const materialEvidence = makeIssue788MaterialEvidence(quoted900, quotation.issuedAt);
      let signerCalls = 0;
      const issueWith = (outcome: PricingQuotationRevalidationOutcome) =>
        makePricingQuotationBackedConfirmationIssuanceService({
          bindingAuthority: verifiedBindingAuthority(),
          proofIssuer: proofIssuer(() => {
            signerCalls += 1;
          }),
          revalidation: revalidationService(outcome),
        }).issue({ binding, materialEvidence, quotation, requestedBinding: quotation.binding });

      const mismatch = yield* issueWith({
        kind: 'NEW_QUOTATION_REQUIRED',
        mismatchReason: 'SELECTION_CHANGED',
        quotationRef: quotation.quotationRef,
        retryable: false,
      });
      const expired = yield* issueWith({
        evaluatedAt: quotation.validity.validUntil,
        kind: 'EXPIRED',
        quotationRef: quotation.quotationRef,
        validity: quotation.validity,
      });
      const unverifiable = yield* issueWith({
        kind: 'AUTHENTICITY_UNVERIFIABLE',
        quotationRef: quotation.quotationRef,
        reason: 'DEPENDENCY_UNAVAILABLE',
        retryable: true,
      });

      const mismatchReason = Match.value(mismatch).pipe(
        Match.tag('BINDING_MISMATCH', ({ reason }) => reason),
        Match.orElse(({ _tag }) => `unexpected:${_tag}`),
      );
      const expiredReason = Match.value(expired).pipe(
        Match.tag('SOURCE_INVALID', ({ reason }) => reason),
        Match.orElse(({ _tag }) => `unexpected:${_tag}`),
      );
      const unverifiableReason = Match.value(unverifiable).pipe(
        Match.tag('SOURCE_UNVERIFIABLE', ({ reason, retryable }) => `${reason}:${retryable}`),
        Match.orElse(({ _tag }) => `unexpected:${_tag}`),
      );
      expect(mismatchReason).toBe('SELECTION_CHANGED');
      expect(expiredReason).toBe('QUOTATION_EXPIRED');
      expect(unverifiableReason).toBe('QUOTATION_DEPENDENCY_UNAVAILABLE:true');
      expect(signerCalls).toBe(0);
    }),
  );

  it.effect('distinguishes nonexistent and changed owner Attempt/Bundle bindings before proof mint', () =>
    Effect.gen(function* rejectsOwnerBindingChanges() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quoted900);
      const source = makeIssue788QuotationSource(quotation);
      const binding = makeIssue788Binding(quoted900);
      let proofCalls = 0;
      let bindingCalls = 0;
      const issueWith = (reason: 'ATTEMPT_CHANGED' | 'ATTEMPT_NOT_FOUND' | 'BUNDLE_CHANGED' | 'PURCHASE_CHANGED') =>
        makePricingQuotationBackedConfirmationIssuanceService({
          bindingAuthority: {
            verifyUnchangedBinding: () => {
              bindingCalls += 1;
              return Effect.fail(new PricingQuotationBackedConfirmationBindingRejected({ reason }));
            },
          },
          proofIssuer: proofIssuer(() => {
            proofCalls += 1;
          }),
          revalidation: revalidationService(source.quotationRevalidation),
        }).issue({
          binding,
          materialEvidence: source.materialEvidence,
          quotation,
          requestedBinding: quotation.binding,
        });

      const notFound = yield* issueWith('ATTEMPT_NOT_FOUND');
      const attemptChanged = yield* issueWith('ATTEMPT_CHANGED');
      const bundleChanged = yield* issueWith('BUNDLE_CHANGED');
      const purchaseChanged = yield* issueWith('PURCHASE_CHANGED');
      expect(bindingMismatchReasonFor(notFound)).toBe('ATTEMPT_NOT_FOUND');
      expect(bindingMismatchReasonFor(attemptChanged)).toBe('ATTEMPT_CHANGED');
      expect(bindingMismatchReasonFor(bundleChanged)).toBe('BUNDLE_CHANGED');
      expect(bindingMismatchReasonFor(purchaseChanged)).toBe('PURCHASE_CHANGED');
      expect(bindingCalls).toBe(4);
      expect(proofCalls).toBe(0);
    }),
  );

  it.effect('fails safely when the owner-private proof issuer is unavailable', () =>
    Effect.gen(function* failsIssuerUnavailable() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quoted900);
      const source = makeIssue788QuotationSource(quotation);
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: verifiedBindingAuthority(),
        proofIssuer: {
          issueProof: () =>
            Effect.fail(
              new PricingCommitmentConfirmationProofIssuanceUnavailable({
                reason: 'ISSUER_UNAVAILABLE',
                retryable: true,
              }),
            ),
        },
        revalidation: revalidationService(source.quotationRevalidation),
      });

      const outcome = yield* service.issue({
        binding: makeIssue788Binding(quoted900),
        materialEvidence: source.materialEvidence,
        quotation,
        requestedBinding: quotation.binding,
      });
      const failure = Match.value(outcome).pipe(
        Match.tag('SOURCE_UNVERIFIABLE', ({ reason, retryable }) => ({ reason, retryable })),
        Match.orElse(({ _tag }) => ({ reason: `unexpected:${_tag}`, retryable: false })),
      );
      expect(failure).toEqual({ reason: 'CONFIRMATION_PROOF_ISSUANCE_UNAVAILABLE', retryable: true });
    }),
  );

  it.effect('rejects caller-swapped proof references with unchanged terms before invoking the signer', () =>
    Effect.gen(function* rejectsSwappedProofBeforeSigner() {
      const quoted900 = yield* makeIssue788CommercialTotal('900');
      const quotation = makeIssue788Quotation(quoted900);
      const source = makeIssue788QuotationSource(quotation);
      let signerCalls = 0;
      const service = makePricingQuotationBackedConfirmationIssuanceService({
        bindingAuthority: verifiedBindingAuthority(),
        proofIssuer: proofIssuer(() => {
          signerCalls += 1;
        }),
        revalidation: revalidationService(source.quotationRevalidation),
      });

      const outcome = yield* service.issue({
        binding: makeIssue788Binding(quoted900),
        materialEvidence: withSwappedCurrencySupportProof(quotation.materialEvidence),
        quotation,
        requestedBinding: quotation.binding,
      });
      const reason = Match.value(outcome).pipe(
        Match.tag('SOURCE_INVALID', (failure) => failure.reason),
        Match.orElse(({ _tag }) => `unexpected:${_tag}`),
      );

      expect(reason).toBe('QUOTATION_MATERIAL_EVIDENCE_CHANGED');
      expect(signerCalls).toBe(0);
    }),
  );
});
