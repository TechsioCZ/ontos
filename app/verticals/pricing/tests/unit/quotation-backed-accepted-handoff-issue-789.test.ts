import { PricingAcceptedOrderHandoffSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type {
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingQuotationBackedConfirmationSourceSchema } from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import { PricingSourceEvidenceVerifiedPresentSchema } from '@app/pricing-contracts/domain/source-revision-evidence';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingCommitmentConfirmationVerificationService,
  PricingCommitmentConfirmationOwnerVerifier,
  PricingCommitmentConfirmationVerification,
} from '../../src/services/commitment-confirmation-verification.service.ts';
import type { PricingCommitmentConfirmationOwnerVerifierService } from '../../src/services/commitment-confirmation-verification.service.ts';
import {
  makePricingQuotationBackedAcceptedHandoffService,
  PricingQuotationBackedAcceptedHandoffBuiltSchema,
  PricingQuotationBackedAcceptedHandoffInvalidSchema,
} from '../../src/services/quotation-backed-accepted-handoff.service.ts';
import {
  issue788IssuedAt,
  makeIssue788CommercialTotal,
  makeIssue788CurrentConfirmation,
  makeIssue788IssuedConfirmation,
  makeIssue788MaterialEvidence,
  makeIssue788Quotation,
} from './support/issue-788-confirmation.fixture.ts';

const acceptedAt = '2026-09-28T12:00:10.000Z';
const decodeQuotation = Schema.decodeUnknownSync(PricingQuotationIssuedSchema, { onExcessProperty: 'error' });
const decodeQuotationSource = Schema.decodeUnknownSync(PricingQuotationBackedConfirmationSourceSchema);
const decodeBuilt = Schema.decodeUnknownSync(PricingQuotationBackedAcceptedHandoffBuiltSchema);
const decodeInvalid = Schema.decodeUnknownSync(PricingQuotationBackedAcceptedHandoffInvalidSchema);

const quotationAtConfirmationTime = (
  terms: Effect.Success<ReturnType<typeof makeIssue788CommercialTotal>>,
  quotationRef = 'pricing-quotation:789:original-900',
) => decodeQuotation({ ...makeIssue788Quotation(terms, quotationRef), issuedAt: issue788IssuedAt });

const verificationEvidence = (
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

const verifyingOwner: PricingCommitmentConfirmationOwnerVerifierService = {
  verifyImmutableConfirmation: ({ confirmation, verifiedAt }) =>
    Effect.succeed({
      _tag: 'VERIFIED',
      authenticityEvidence: verificationEvidence(confirmation, verifiedAt),
    }),
};

const builder = makePricingCommitmentConfirmationVerificationService.pipe(
  Effect.provideService(PricingCommitmentConfirmationOwnerVerifier, verifyingOwner),
  Effect.flatMap((verification) =>
    makePricingQuotationBackedAcceptedHandoffService.pipe(
      Effect.provideService(PricingCommitmentConfirmationVerification, verification),
    ),
  ),
);

describe('Quotation-backed Pricing Accepted handoff (#789)', () => {
  it.effect('uses the exact quote 900 Confirmation and original evidence when ordinary Current is 950', () =>
    Effect.gen(function* buildsFromActuallyCommittedQuote() {
      const quote900Terms = yield* makeIssue788CommercialTotal('900');
      const ordinaryCurrent950 = yield* makeIssue788CommercialTotal('950');
      const quotation = quotationAtConfirmationTime(quote900Terms);
      const confirmation = makeIssue788IssuedConfirmation(quote900Terms, { quotation });
      const quotationSource = decodeQuotationSource(confirmation.source);
      const materialEvidence = makeIssue788MaterialEvidence(quote900Terms);
      const service = yield* builder;
      const outcome = yield* service.build({
        acceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:quote-900',
        materialEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        quotation,
        quotationRevalidation: quotationSource.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: 'tenant:pricing-accepted:789',
      });

      expect(ordinaryCurrent950.pricingNetCommercialTotal.amount).toBe('950');
      const built = decodeBuilt(outcome);
      const handoff = yield* Schema.decodeEffect(PricingAcceptedOrderHandoffSchema)(built.handoff);
      expect(handoff.terms.pricingNetCommercialTotal.amount).toBe('900');
      expect(handoff.materialEvidence).toEqual(materialEvidence);
      expect(handoff.commitmentVerification.confirmation).toEqual(confirmation);
      expect(handoff.commitmentVerification.verifiedAt).toBe(acceptedAt);
      expect(handoff.lineage).toEqual({
        attemptRef: confirmation.binding.attemptRef,
        confirmationRef: confirmation.confirmationRef,
        decisionBundleHash: confirmation.binding.decisionBundleHash,
        decisionBundleRef: confirmation.binding.decisionBundleRef,
        decisionBundleVersion: confirmation.binding.decisionBundleVersion,
        kind: 'QUOTATION_TO_CONFIRMATION',
        quotationIssuedAt: quotation.issuedAt,
        quotationRef: quotation.quotationRef,
        quotationRevalidatedAt: issue788IssuedAt,
      });
      expect(handoff.commitmentVerification.confirmation.source.kind).toBe('QUOTATION_BACKED');
    }),
  );

  it.effect('rejects a later quotation or revalidation in place of the proof actually used', () =>
    Effect.gen(function* rejectsReplacementGuaranteeProof() {
      const terms = yield* makeIssue788CommercialTotal('900');
      const quotation = quotationAtConfirmationTime(terms);
      const confirmation = makeIssue788IssuedConfirmation(terms, { quotation });
      const source = decodeQuotationSource(confirmation.source);
      const service = yield* builder;
      const base = {
        acceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:no-replacement',
        materialEvidence: makeIssue788MaterialEvidence(terms),
        qualifiedLegacyCurrencySupportReferences: [],
        quotationRevalidation: source.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: 'tenant:pricing-accepted:789',
      } as const;
      const replacementQuotation = quotationAtConfirmationTime(terms, 'pricing-quotation:789:later-reissue');
      const replacedQuotation = yield* service.build({ ...base, quotation: replacementQuotation });
      const replacedRevalidation = yield* service.build({
        ...base,
        quotation,
        quotationRevalidation: {
          ...source.quotationRevalidation,
          authenticityEvidence: {
            ...source.quotationRevalidation.authenticityEvidence,
            keyStatus: 'HISTORICAL',
          },
        },
      });

      expect(decodeInvalid(replacedQuotation)).toMatchObject({
        reason: 'ORIGINAL_QUOTATION_CHANGED',
        retryable: false,
      });
      expect(decodeInvalid(replacedRevalidation)).toMatchObject({
        reason: 'QUOTATION_REVALIDATION_CHANGED',
        retryable: false,
      });
    }),
  );

  it.effect('rejects an expired Confirmation and a changed Attempt or Bundle without a handoff', () =>
    Effect.gen(function* rejectsUncommittedProof() {
      const terms = yield* makeIssue788CommercialTotal('900');
      const quotation = quotationAtConfirmationTime(terms);
      const confirmation = makeIssue788IssuedConfirmation(terms, { quotation });
      const quotationSource = decodeQuotationSource(confirmation.source);
      const service = yield* builder;
      const base = {
        acceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:verification-failure',
        materialEvidence: makeIssue788MaterialEvidence(terms),
        qualifiedLegacyCurrencySupportReferences: [],
        quotation,
        quotationRevalidation: quotationSource.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: 'tenant:pricing-accepted:789',
      } as const;
      const expired = yield* service.build({ ...base, acceptedAt: confirmation.expiresAt });
      const changedBundle = yield* service.build({
        ...base,
        requestedBinding: { ...confirmation.binding, decisionBundleHash: 'sha256:replacement-bundle' },
      });

      expect(decodeInvalid(expired)).toMatchObject({
        reason: 'COMMITMENT_CONFIRMATION_NOT_VERIFIED',
        retryable: false,
        verificationOutcome: { _tag: 'EXPIRED' },
      });
      expect(decodeInvalid(changedBundle)).toMatchObject({
        reason: 'COMMITMENT_CONFIRMATION_NOT_VERIFIED',
        retryable: false,
        verificationOutcome: { _tag: 'BINDING_MISMATCH', reason: 'BUNDLE_CHANGED' },
      });
    }),
  );

  it.effect('rejects Current-backed proof and later-Current material evidence', () =>
    Effect.gen(function* rejectsRelabelingHistoricalQuoteSources() {
      const quote900Terms = yield* makeIssue788CommercialTotal('900');
      const current950Terms = yield* makeIssue788CommercialTotal('950');
      const quotation = quotationAtConfirmationTime(quote900Terms);
      const confirmation = makeIssue788IssuedConfirmation(quote900Terms, { quotation });
      const quotationSource = decodeQuotationSource(confirmation.source);
      const service = yield* builder;
      const request = {
        acceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:historical-source',
        materialEvidence: makeIssue788MaterialEvidence(current950Terms),
        qualifiedLegacyCurrencySupportReferences: [],
        quotation,
        quotationRevalidation: quotationSource.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: 'tenant:pricing-accepted:789',
      } as const;
      const relabeledCurrent = yield* service.build(request);
      const currentConfirmation = makeIssue788CurrentConfirmation(current950Terms);
      const currentBacked = yield* service.build({
        ...request,
        confirmation: currentConfirmation,
        quotation: quotationAtConfirmationTime(current950Terms),
        requestedBinding: currentConfirmation.binding,
      });

      expect(decodeInvalid(relabeledCurrent)).toMatchObject({
        reason: 'MATERIAL_EVIDENCE_CHANGED',
        retryable: false,
      });
      expect(decodeInvalid(currentBacked)).toMatchObject({
        reason: 'NOT_QUOTATION_BACKED',
        retryable: false,
      });
    }),
  );

  it.effect('rejects swapped source proof references even when candidate and monetary terms are unchanged', () =>
    Effect.gen(function* rejectsSwappedSourceProof() {
      const terms = yield* makeIssue788CommercialTotal('900');
      const quotation = quotationAtConfirmationTime(terms);
      const originalEvidence = makeIssue788MaterialEvidence(terms);
      const confirmation = makeIssue788IssuedConfirmation(terms, { materialEvidence: originalEvidence, quotation });
      const quotationSource = decodeQuotationSource(confirmation.source);
      const {
        sourceEvidence: { currencySupport: unverifiedCurrencySupport },
      } = originalEvidence;
      const currencySupport = yield* Schema.decodeUnknownEffect(PricingSourceEvidenceVerifiedPresentSchema)(
        unverifiedCurrencySupport,
      );
      const swappedVerification = {
        kind: 'OWNER_VERIFIABLE_OPAQUE_REFERENCE' as const,
        verificationRef: 'pricing:currency-support:swapped-proof:789',
      };
      const swappedEvidence = {
        ...originalEvidence,
        sourceEvidence: {
          ...originalEvidence.sourceEvidence,
          currencySupport: {
            ...currencySupport,
            completeness: { ...currencySupport.completeness, verification: swappedVerification },
            currentFacts: currencySupport.currentFacts.map((fact) => ({
              ...fact,
              verification: swappedVerification,
            })),
          },
        },
      };
      const service = yield* builder;
      const outcome = yield* service.build({
        acceptedAt,
        confirmation,
        handoffRef: 'pricing-accepted-handoff:789:swapped-proof',
        materialEvidence: swappedEvidence,
        qualifiedLegacyCurrencySupportReferences: [],
        quotation,
        quotationRevalidation: quotationSource.quotationRevalidation,
        requestedBinding: confirmation.binding,
        scopeRef: 'tenant:pricing-accepted:789',
      });

      expect(decodeInvalid(outcome)).toMatchObject({
        reason: 'MATERIAL_EVIDENCE_CHANGED',
        retryable: false,
      });
    }),
  );
});
