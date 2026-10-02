import type { PricingAcceptedLegacyCurrencySupportReference } from '@app/pricing-contracts/domain/accepted-order-handoff';
import { PricingAcceptedOrderHandoffSchema } from '@app/pricing-contracts/domain/accepted-order-handoff';
import type {
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationOutcome,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingCommitmentConfirmationVerificationOutcomeSchema,
  PricingCommitmentConfirmationVerifiedSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingCommercialTotalSafeProjectionSchema } from '@app/pricing-contracts/domain/commercial-total';
import type { PricingInstantSchema } from '@app/pricing-contracts/domain/currency-support';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import { PricingMaterialEvidenceReadySchema } from '@app/pricing-contracts/domain/material-evidence';
import {
  PricingEvaluationAttemptSchema,
  PricingFreshAttemptOutcomeSchema,
} from '@app/pricing-contracts/domain/material-change';
import { Context, Effect, Option, Schema } from 'effect';

import type { PricingCommitmentConfirmationVerificationService } from './commitment-confirmation-verification.service.ts';
import { projectPricingCommercialTotal } from './commercial-total-projection.service.ts';
import type { PricingOrdinaryCurrentPublished } from './ordinary-current-pricing-evaluation.service.ts';

const sameMaterialEvidence = Schema.toEquivalence(PricingMaterialEvidenceReadySchema);
const sameCurrentness = Schema.toEquivalence(PricingFreshAttemptOutcomeSchema);
const sameAttempt = Schema.toEquivalence(PricingEvaluationAttemptSchema);
const samePublication = Schema.toEquivalence(PricingCommercialTotalSafeProjectionSchema);

export interface PricingCurrentBackedAcceptedHandoffRequest {
  readonly acceptedAt: typeof PricingInstantSchema.Type;
  readonly confirmation: PricingCommitmentConfirmationIssued;
  readonly currentPublication: PricingOrdinaryCurrentPublished;
  readonly handoffRef: string;
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly qualifiedLegacyCurrencySupportReferences: readonly PricingAcceptedLegacyCurrencySupportReference[];
  readonly requestedBinding: PricingCommitmentConfirmationBinding;
  readonly scopeRef: string;
}

export const PricingCurrentBackedAcceptedHandoffInvalidReasonSchema = Schema.Literals([
  'COMMITMENT_CONFIRMATION_NOT_VERIFIED',
  'CURRENT_EVALUATION_CHANGED',
  'CURRENT_PUBLICATION_CHANGED',
  'HANDOFF_FAILED_CANONICAL_VALIDATION',
  'MATERIAL_EVIDENCE_CHANGED',
  'NOT_CURRENT_BACKED',
]);
export const PricingCurrentBackedAcceptedHandoffBuiltSchema = Schema.TaggedStruct('HANDOFF_BUILT', {
  handoff: Schema.toType(PricingAcceptedOrderHandoffSchema),
});
export const PricingCurrentBackedAcceptedHandoffInvalidSchema = Schema.TaggedStruct('HANDOFF_INVALID', {
  reason: PricingCurrentBackedAcceptedHandoffInvalidReasonSchema,
  retryable: Schema.Boolean,
  verificationOutcome: Schema.optionalKey(Schema.toType(PricingCommitmentConfirmationVerificationOutcomeSchema)),
});
export const PricingCurrentBackedAcceptedHandoffOutcomeSchema = Schema.Union([
  PricingCurrentBackedAcceptedHandoffBuiltSchema,
  PricingCurrentBackedAcceptedHandoffInvalidSchema,
]);
export type PricingCurrentBackedAcceptedHandoffOutcome = typeof PricingCurrentBackedAcceptedHandoffOutcomeSchema.Type;

export interface PricingCurrentBackedAcceptedHandoffService {
  readonly build: (
    request: PricingCurrentBackedAcceptedHandoffRequest,
  ) => Effect.Effect<PricingCurrentBackedAcceptedHandoffOutcome>;
}

export class PricingCurrentBackedAcceptedHandoff extends Context.Service<
  PricingCurrentBackedAcceptedHandoff,
  PricingCurrentBackedAcceptedHandoffService
>()('@app/pricing/services/current-backed-accepted-handoff.service/PricingCurrentBackedAcceptedHandoff') {}

const verificationRetryable = (outcome: PricingCommitmentConfirmationVerificationOutcome): boolean =>
  'retryable' in outcome ? outcome.retryable : false;

/**
 * Builds the owner-to-owner historical payload exclusively from the exact Confirmation and the
 * already-published Current aggregate. It never reads Current sources or recalculates monetary
 * values; projection below only proves that the retained full terms reproduce the accepted #787
 * publication.
 */
export const makePricingCurrentBackedAcceptedHandoffService = (
  verification: PricingCommitmentConfirmationVerificationService,
): PricingCurrentBackedAcceptedHandoffService => ({
  build: Effect.fn('PricingCurrentBackedAcceptedHandoff.build')(function* buildCurrentBackedHandoff(request) {
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
    if (verified.confirmation.source.kind !== 'CURRENT_BACKED') {
      return { _tag: 'HANDOFF_INVALID', reason: 'NOT_CURRENT_BACKED', retryable: false } as const;
    }
    const { source } = verified.confirmation;
    if (!sameMaterialEvidence(request.materialEvidence, source.materialEvidence)) {
      return { _tag: 'HANDOFF_INVALID', reason: 'MATERIAL_EVIDENCE_CHANGED', retryable: false } as const;
    }
    if (
      request.currentPublication.outcome !== 'ORDINARY_CURRENT_PRICING_PUBLISHED' ||
      request.currentPublication.attempts !== source.currentness.attempt.attemptOrdinal ||
      !sameAttempt(request.currentPublication.acceptedAttempt, source.currentness.attempt) ||
      !sameCurrentness(request.currentPublication.currentness, source.currentness)
    ) {
      return { _tag: 'HANDOFF_INVALID', reason: 'CURRENT_EVALUATION_CHANGED', retryable: false } as const;
    }

    const preservedPublication = yield* projectPricingCommercialTotal(verified.confirmation.terms).pipe(Effect.option);
    if (
      Option.isNone(preservedPublication) ||
      !samePublication(preservedPublication.value, request.currentPublication.publication)
    ) {
      return { _tag: 'HANDOFF_INVALID', reason: 'CURRENT_PUBLICATION_CHANGED', retryable: false } as const;
    }

    const handoffPayload = {
      acceptedAt: request.acceptedAt,
      commitmentVerification: verified,
      handoffRef: request.handoffRef,
      kind: 'PRICING_ACCEPTED_ORDER_HANDOFF' as const,
      lineage: {
        attemptRef: verified.confirmation.binding.attemptRef,
        confirmationRef: verified.confirmation.confirmationRef,
        decisionBundleHash: verified.confirmation.binding.decisionBundleHash,
        decisionBundleRef: verified.confirmation.binding.decisionBundleRef,
        decisionBundleVersion: verified.confirmation.binding.decisionBundleVersion,
        kind: 'CURRENT_TO_CONFIRMATION' as const,
        materialEvidenceValidatedAt: source.materialEvidence.validatedAt,
      },
      materialEvidence: source.materialEvidence,
      owner: { moduleId: 'commerce.pricing' as const, scopeRef: request.scopeRef },
      qualifiedLegacyCurrencySupportReferences: request.qualifiedLegacyCurrencySupportReferences,
      terms: verified.confirmation.terms,
    };
    const handoffOption = Schema.decodeOption(PricingAcceptedOrderHandoffSchema, {
      onExcessProperty: 'error',
    })(handoffPayload);
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
});
