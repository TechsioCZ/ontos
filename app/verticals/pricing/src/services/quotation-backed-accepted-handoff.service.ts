import {
  PricingAcceptedLegacyCurrencySupportReferenceSchema,
  PricingAcceptedOrderHandoffSchema,
} from '@app/pricing-contracts/domain/accepted-order-handoff';
import {
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationVerificationOutcomeSchema,
  PricingCommitmentConfirmationVerifiedSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import { PricingMaterialEvidenceReadySchema } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingQuotationExactReuseSchema,
  PricingQuotationIssuedSchema,
} from '@app/pricing-contracts/domain/quotation';
import { Effect, Option, Schema } from 'effect';

import { PricingCommitmentConfirmationVerification } from './commitment-confirmation-verification.service.ts';

const sameQuotation = Schema.toEquivalence(PricingQuotationIssuedSchema);
const sameQuotationRevalidation = Schema.toEquivalence(PricingQuotationExactReuseSchema);
const sameMaterialEvidence = Schema.toEquivalence(PricingMaterialEvidenceReadySchema);

export const PricingQuotationBackedAcceptedHandoffRequestSchema = Schema.Struct({
  acceptedAt: PricingInstantSchema,
  confirmation: Schema.toType(PricingCommitmentConfirmationIssuedSchema),
  handoffRef: Schema.String,
  materialEvidence: Schema.toType(PricingMaterialEvidenceReadySchema),
  qualifiedLegacyCurrencySupportReferences: Schema.Array(PricingAcceptedLegacyCurrencySupportReferenceSchema),
  quotation: Schema.toType(PricingQuotationIssuedSchema),
  quotationRevalidation: Schema.toType(PricingQuotationExactReuseSchema),
  requestedBinding: PricingCommitmentConfirmationBindingSchema,
  scopeRef: Schema.String,
});
export type PricingQuotationBackedAcceptedHandoffRequest =
  typeof PricingQuotationBackedAcceptedHandoffRequestSchema.Type;

export const PricingQuotationBackedAcceptedHandoffInvalidReasonSchema = Schema.Literals([
  'COMMITMENT_CONFIRMATION_NOT_VERIFIED',
  'HANDOFF_FAILED_CANONICAL_VALIDATION',
  'MATERIAL_EVIDENCE_CHANGED',
  'NOT_QUOTATION_BACKED',
  'ORIGINAL_QUOTATION_CHANGED',
  'QUOTATION_REVALIDATION_CHANGED',
]);
export const PricingQuotationBackedAcceptedHandoffBuiltSchema = Schema.TaggedStruct('HANDOFF_BUILT', {
  handoff: Schema.toType(PricingAcceptedOrderHandoffSchema),
});

export const PricingQuotationBackedAcceptedHandoffInvalidSchema = Schema.TaggedStruct('HANDOFF_INVALID', {
  reason: PricingQuotationBackedAcceptedHandoffInvalidReasonSchema,
  retryable: Schema.Boolean,
  verificationOutcome: Schema.optionalKey(Schema.toType(PricingCommitmentConfirmationVerificationOutcomeSchema)),
});

export const PricingQuotationBackedAcceptedHandoffOutcomeSchema = Schema.Union([
  PricingQuotationBackedAcceptedHandoffBuiltSchema,
  PricingQuotationBackedAcceptedHandoffInvalidSchema,
]);
export type PricingQuotationBackedAcceptedHandoffOutcome =
  typeof PricingQuotationBackedAcceptedHandoffOutcomeSchema.Type;

interface PricingQuotationBackedAcceptedHandoffService {
  readonly build: (
    request: PricingQuotationBackedAcceptedHandoffRequest,
  ) => Effect.Effect<PricingQuotationBackedAcceptedHandoffOutcome>;
}

const verificationRetryable = (outcome: typeof PricingCommitmentConfirmationVerificationOutcomeSchema.Type): boolean =>
  'retryable' in outcome ? outcome.retryable : false;

export const makePricingQuotationBackedAcceptedHandoffService = Effect.gen(
  function* makePricingQuotationBackedAcceptedHandoffService() {
    const verification = yield* PricingCommitmentConfirmationVerification;
    return {
      build: Effect.fn('PricingQuotationBackedAcceptedHandoff.build')(function* buildQuotationBackedHandoff(request) {
        const verificationOutcome = yield* verification.verify({
          attemptedAt: request.acceptedAt,
          confirmation: request.confirmation,
          kind: 'VERIFY_PRICING_COMMITMENT_CONFIRMATION',
          requestedBinding: request.requestedBinding,
        });
        const verifiedOption = Schema.decodeUnknownOption(PricingCommitmentConfirmationVerifiedSchema, {
          onExcessProperty: 'error',
        })(verificationOutcome);
        if (Option.isNone(verifiedOption)) {
          return {
            _tag: 'HANDOFF_INVALID',
            reason: 'COMMITMENT_CONFIRMATION_NOT_VERIFIED',
            retryable: verificationRetryable(verificationOutcome),
            verificationOutcome,
          } as const;
        }

        const verified = verifiedOption.value;
        if (verified.confirmation.source.kind !== 'QUOTATION_BACKED') {
          return { _tag: 'HANDOFF_INVALID', reason: 'NOT_QUOTATION_BACKED', retryable: false } as const;
        }
        const usedRevalidation = verified.confirmation.source.quotationRevalidation;
        if (!sameQuotation(request.quotation, usedRevalidation.quotation)) {
          return { _tag: 'HANDOFF_INVALID', reason: 'ORIGINAL_QUOTATION_CHANGED', retryable: false } as const;
        }
        if (!sameQuotationRevalidation(request.quotationRevalidation, usedRevalidation)) {
          return { _tag: 'HANDOFF_INVALID', reason: 'QUOTATION_REVALIDATION_CHANGED', retryable: false } as const;
        }
        if (!sameMaterialEvidence(request.materialEvidence, verified.confirmation.source.materialEvidence)) {
          return { _tag: 'HANDOFF_INVALID', reason: 'MATERIAL_EVIDENCE_CHANGED', retryable: false } as const;
        }

        const handoffOption = Schema.decodeOption(PricingAcceptedOrderHandoffSchema, {
          onExcessProperty: 'error',
        })({
          acceptedAt: request.acceptedAt,
          commitmentVerification: verified,
          handoffRef: request.handoffRef,
          kind: 'PRICING_ACCEPTED_ORDER_HANDOFF',
          lineage: {
            attemptRef: verified.confirmation.binding.attemptRef,
            confirmationRef: verified.confirmation.confirmationRef,
            decisionBundleHash: verified.confirmation.binding.decisionBundleHash,
            decisionBundleRef: verified.confirmation.binding.decisionBundleRef,
            decisionBundleVersion: verified.confirmation.binding.decisionBundleVersion,
            kind: 'QUOTATION_TO_CONFIRMATION',
            quotationIssuedAt: usedRevalidation.quotation.issuedAt,
            quotationRef: usedRevalidation.quotation.quotationRef,
            quotationRevalidatedAt: usedRevalidation.evaluatedAt,
          },
          materialEvidence: request.materialEvidence,
          owner: { moduleId: 'commerce.pricing', scopeRef: request.scopeRef },
          qualifiedLegacyCurrencySupportReferences: request.qualifiedLegacyCurrencySupportReferences,
          terms: verified.confirmation.terms,
        });
        return Option.match(handoffOption, {
          onNone: () =>
            ({
              _tag: 'HANDOFF_INVALID',
              reason: 'HANDOFF_FAILED_CANONICAL_VALIDATION',
              retryable: false,
            }) as const,
          onSome: (handoff) => ({ _tag: 'HANDOFF_BUILT', handoff }) as const,
        });
      }),
    } satisfies PricingQuotationBackedAcceptedHandoffService;
  },
);
