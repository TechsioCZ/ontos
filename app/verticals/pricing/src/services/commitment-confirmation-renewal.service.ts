import {
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationRenewalOutcomeSchema,
  PricingCommitmentConfirmationRenewalRequestSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssuanceOutcome,
  PricingCommitmentConfirmationRenewalOutcome,
  PricingCommitmentConfirmationRenewalRequest,
  PricingCommitmentConfirmationSource,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import {
  PricingCommercialTotalBreakdownSchema,
  PricingCommercialTotalReadySchema,
  PricingPublishedCommercialLineSchema,
} from '@app/pricing-contracts/domain/commercial-total';
import { PricingQuotationBindingSchema } from '@app/pricing-contracts/domain/quotation';
import { PricingDecisionSchema } from '@app/pricing-contracts/pricing-decision';
import { Context, Effect, Match, Option, Schema } from 'effect';

import type { PricingCurrentBackedConfirmationIssuanceService } from './current-backed-confirmation-issuance.service.ts';
import type { PricingQuotationBackedConfirmationIssuanceService } from './quotation-backed-confirmation-issuance.service.ts';

const sameBinding = Schema.toEquivalence(PricingCommitmentConfirmationBindingSchema);
const samePurchase = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameTerms = Schema.toEquivalence(PricingCommercialTotalReadySchema);
const sameBreakdown = Schema.toEquivalence(PricingCommercialTotalBreakdownSchema);
const sameDecision = Schema.toEquivalence(PricingDecisionSchema);
const samePublishedLines = Schema.toEquivalence(Schema.Array(PricingPublishedCommercialLineSchema));

export interface PricingCommitmentConfirmationRenewalService {
  readonly renew: (
    request: PricingCommitmentConfirmationRenewalRequest,
  ) => Effect.Effect<PricingCommitmentConfirmationRenewalOutcome>;
}

export class PricingCommitmentConfirmationRenewal extends Context.Service<
  PricingCommitmentConfirmationRenewal,
  PricingCommitmentConfirmationRenewalService
>()('@app/pricing/services/commitment-confirmation-renewal.service/PricingCommitmentConfirmationRenewal') {}

interface PricingCommitmentConfirmationRenewalDependencies {
  readonly currentIssuance: PricingCurrentBackedConfirmationIssuanceService;
  readonly quotationIssuance: PricingQuotationBackedConfirmationIssuanceService;
}

const sourceInvalid = (reason: string): PricingCommitmentConfirmationRenewalOutcome => ({
  _tag: 'SOURCE_INVALID',
  reason,
  retryable: false,
});

const sourceUnverifiable = (reason: string, retryable: boolean): PricingCommitmentConfirmationRenewalOutcome => ({
  _tag: 'SOURCE_UNVERIFIABLE',
  reason,
  retryable,
});

const replacementRequired = (
  reason: Extract<
    PricingCommitmentConfirmationRenewalOutcome,
    { readonly _tag: 'REPLACEMENT_BUNDLE_REQUIRED' }
  >['reason'],
): PricingCommitmentConfirmationRenewalOutcome => ({
  _tag: 'REPLACEMENT_BUNDLE_REQUIRED',
  reason,
  retryable: false,
});

const bindingPrecondition = (
  requested: PricingCommitmentConfirmationBinding,
  previous: PricingCommitmentConfirmationBinding,
): PricingCommitmentConfirmationRenewalOutcome | undefined => {
  if (requested.attemptRef !== previous.attemptRef) {
    return { _tag: 'BINDING_MISMATCH', reason: 'ATTEMPT_CHANGED', retryable: false };
  }
  if (
    requested.decisionBundleHash !== previous.decisionBundleHash ||
    requested.decisionBundleRef !== previous.decisionBundleRef ||
    requested.decisionBundleVersion !== previous.decisionBundleVersion
  ) {
    return replacementRequired('BUNDLE_CHANGED');
  }
  if (!samePurchase(requested.purchase, previous.purchase)) {
    return { _tag: 'BINDING_MISMATCH', reason: 'PURCHASE_CHANGED', retryable: false };
  }
  return undefined;
};

const issueAgain = (
  request: PricingCommitmentConfirmationRenewalRequest,
  dependencies: PricingCommitmentConfirmationRenewalDependencies,
): Effect.Effect<PricingCommitmentConfirmationIssuanceOutcome> => {
  const { previousConfirmation } = request;
  if (previousConfirmation.source.kind === 'CURRENT_BACKED') {
    // The binding-only owner entrypoint deliberately has no retained source input. It reruns the
    // complete #787 evaluation and resolves the accepted full source from owner state.
    return dependencies.currentIssuance.issue({ binding: request.binding });
  }
  const { quotation } = previousConfirmation.source.quotationRevalidation;
  return dependencies.quotationIssuance.issue({
    binding: request.binding,
    materialEvidence: quotation.materialEvidence,
    quotation,
    requestedBinding: request.binding.purchase,
  });
};

const sameTermsWithoutSourceEvidence = (
  left: typeof PricingCommercialTotalReadySchema.Type,
  right: typeof PricingCommercialTotalReadySchema.Type,
): boolean =>
  left.candidateRef === right.candidateRef &&
  left.outcome === right.outcome &&
  left.pricingNetCommercialTotal.amount === right.pricingNetCommercialTotal.amount &&
  left.pricingNetCommercialTotal.currencyCode === right.pricingNetCommercialTotal.currencyCode &&
  sameBreakdown(left.breakdown, right.breakdown) &&
  sameDecision(left.decision, right.decision) &&
  samePublishedLines(left.publishedLines, right.publishedLines);

const sourceLineageRequiresReplacement = (
  previous: PricingCommitmentConfirmationSource,
  renewed: PricingCommitmentConfirmationSource,
): boolean =>
  previous.kind !== renewed.kind ||
  (previous.kind === 'QUOTATION_BACKED' &&
    renewed.kind === 'QUOTATION_BACKED' &&
    previous.quotationRevalidation.quotation.quotationRef !== renewed.quotationRevalidation.quotation.quotationRef);

const renewedOutcome = (
  request: PricingCommitmentConfirmationRenewalRequest,
  issuance: Extract<PricingCommitmentConfirmationIssuanceOutcome, { readonly _tag: 'ISSUED' }>,
): PricingCommitmentConfirmationRenewalOutcome => {
  const { confirmation } = issuance;
  const previous = request.previousConfirmation;
  if (confirmation.confirmationRef === previous.confirmationRef) {
    return sourceUnverifiable('CONFIRMATION_IDENTITY_WAS_NOT_RENEWED', false);
  }
  if (!sameBinding(confirmation.binding, request.binding)) {
    return sourceUnverifiable('RENEWED_CONFIRMATION_BINDING_IS_UNVERIFIABLE', false);
  }
  if (sourceLineageRequiresReplacement(previous.source, confirmation.source)) {
    return replacementRequired('SOURCE_EVIDENCE_CHANGED');
  }
  if (!sameTerms(previous.terms, confirmation.terms)) {
    return replacementRequired(
      sameTermsWithoutSourceEvidence(previous.terms, confirmation.terms) ? 'SOURCE_EVIDENCE_CHANGED' : 'TERMS_CHANGED',
    );
  }

  const outcome = Schema.decodeOption(PricingCommitmentConfirmationRenewalOutcomeSchema, {
    onExcessProperty: 'error',
  })({
    _tag: 'RENEWED',
    confirmation,
    previousConfirmationRef: previous.confirmationRef,
  });
  return Option.isSome(outcome)
    ? outcome.value
    : sourceUnverifiable('RENEWED_CONFIRMATION_FAILED_CANONICAL_VALIDATION', false);
};

/**
 * Renews one proof instance without modifying it or its Attempt/Bundle. Each path delegates to its
 * canonical issuance service, so Current reruns #787 and Quotation reruns #785 without Current
 * repricing. Overlap with the previous interval is intentionally allowed.
 */
export const makePricingCommitmentConfirmationRenewalService = (
  dependencies: PricingCommitmentConfirmationRenewalDependencies,
): PricingCommitmentConfirmationRenewalService => ({
  renew: Effect.fn('PricingCommitmentConfirmationRenewal.renew')(function* renewConfirmation(input) {
    const request = Schema.decodeOption(PricingCommitmentConfirmationRenewalRequestSchema, {
      onExcessProperty: 'error',
    })(input);
    if (Option.isNone(request)) {
      return sourceInvalid('INVALID_CONFIRMATION_RENEWAL_REQUEST');
    }

    const mismatch = bindingPrecondition(request.value.binding, request.value.previousConfirmation.binding);
    if (mismatch !== undefined) {
      return mismatch;
    }

    const issuance = yield* issueAgain(request.value, dependencies);
    return Match.value(issuance).pipe(
      Match.tag('ISSUED', (issued) => renewedOutcome(request.value, issued)),
      Match.orElse((failure) => failure),
    );
  }),
});
