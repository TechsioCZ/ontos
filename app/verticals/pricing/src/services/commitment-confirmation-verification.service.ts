import {
  PricingCommitmentConfirmationAuthenticityInvalidSchema,
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationIssuedSchema,
  PricingCommitmentConfirmationVerificationEvidenceSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssued,
  PricingCommitmentConfirmationVerificationEvidence,
  PricingCommitmentConfirmationVerificationOutcome,
  PricingCommitmentConfirmationVerificationRequest,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import {
  PricingQuotationAuthorityBindingSchema,
  PricingQuotationBindingSchema,
  PricingQuotationLineBindingSchema,
} from '@app/pricing-contracts/domain/quotation';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { Context, Data, DateTime, Effect, Match, Option, Schema } from 'effect';

const PricingCommitmentConfirmationOwnerVerifiedSchema = Schema.TaggedStruct('VERIFIED', {
  authenticityEvidence: PricingCommitmentConfirmationVerificationEvidenceSchema,
});

const PricingCommitmentConfirmationOwnerVerificationOutcomeSchema = Schema.Union([
  PricingCommitmentConfirmationOwnerVerifiedSchema,
  PricingCommitmentConfirmationAuthenticityInvalidSchema,
  PricingCommitmentConfirmationAuthenticityUnverifiableSchema,
]);

export class PricingCommitmentConfirmationOwnerVerifierUnavailable extends Data.TaggedError(
  'PricingCommitmentConfirmationOwnerVerifierUnavailable',
)<{
  readonly cause?: unknown;
  readonly reason: 'VERIFICATION_DEPENDENCY_UNAVAILABLE';
}> {}

/**
 * The owner verifier receives the complete immutable instance. Its implementation may load the
 * retained proof and key lineage by `confirmationRef`, but must not read ordinary Current sources.
 */
export interface PricingCommitmentConfirmationOwnerVerificationInput {
  readonly confirmation: PricingCommitmentConfirmationIssued;
  readonly verifiedAt: typeof PricingInstantSchema.Type;
}

export interface PricingCommitmentConfirmationOwnerVerifierService {
  readonly verifyImmutableConfirmation: (
    input: PricingCommitmentConfirmationOwnerVerificationInput,
  ) => Effect.Effect<unknown, PricingCommitmentConfirmationOwnerVerifierUnavailable>;
}

export class PricingCommitmentConfirmationOwnerVerifier extends Context.Service<
  PricingCommitmentConfirmationOwnerVerifier,
  PricingCommitmentConfirmationOwnerVerifierService
>()('@app/pricing/services/commitment-confirmation-verification.service/PricingCommitmentConfirmationOwnerVerifier') {}

export interface PricingCommitmentConfirmationVerificationService {
  readonly verify: (
    request: PricingCommitmentConfirmationVerificationRequest,
  ) => Effect.Effect<PricingCommitmentConfirmationVerificationOutcome>;
}

export class PricingCommitmentConfirmationVerification extends Context.Service<
  PricingCommitmentConfirmationVerification,
  PricingCommitmentConfirmationVerificationService
>()('@app/pricing/services/commitment-confirmation-verification.service/PricingCommitmentConfirmationVerification') {}

const samePurchase = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameAuthority = Schema.toEquivalence(PricingQuotationAuthorityBindingSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameSelection = Schema.toEquivalence(PricingQuotationLineBindingSchema.fields.selection);
const sameQuantity = Schema.toEquivalence(PricingQuotationLineBindingSchema.fields.quantity);

type BindingMismatchReason = Extract<
  PricingCommitmentConfirmationVerificationOutcome,
  { readonly _tag: 'BINDING_MISMATCH' }
>['reason'];

const bindingMismatchReason = (
  issued: PricingCommitmentConfirmationBinding,
  requested: PricingCommitmentConfirmationBinding,
): BindingMismatchReason | undefined => {
  if (issued.attemptRef !== requested.attemptRef) {
    return 'ATTEMPT_CHANGED';
  }
  if (
    issued.decisionBundleRef !== requested.decisionBundleRef ||
    issued.decisionBundleHash !== requested.decisionBundleHash ||
    issued.decisionBundleVersion !== requested.decisionBundleVersion
  ) {
    return 'BUNDLE_CHANGED';
  }
  if (issued.purchase.candidateRef !== requested.purchase.candidateRef) {
    return 'CANDIDATE_CHANGED';
  }
  if (
    issued.purchase.tenantId !== requested.purchase.tenantId ||
    !sameAuthority(issued.purchase.subject, requested.purchase.subject)
  ) {
    return 'AUTHORITY_CONTEXT_CHANGED';
  }
  if (!sameCommercialScope(issued.purchase.commercialScope, requested.purchase.commercialScope)) {
    return 'COMMERCIAL_SCOPE_CHANGED';
  }
  if (
    issued.purchase.currencyCode !== requested.purchase.currencyCode ||
    issued.purchase.monetaryBoundary !== requested.purchase.monetaryBoundary
  ) {
    return 'CURRENCY_OR_BASIS_CHANGED';
  }
  if (
    issued.purchase.lines.length !== requested.purchase.lines.length ||
    issued.purchase.lines.some(
      ({ occurrenceId }, index) => occurrenceId !== requested.purchase.lines[index]?.occurrenceId,
    )
  ) {
    return 'OCCURRENCE_STRUCTURE_CHANGED';
  }
  if (
    issued.purchase.lines.some(({ selection }, index) => {
      const requestedLine = requested.purchase.lines[index];
      return requestedLine === undefined || !sameSelection(selection, requestedLine.selection);
    })
  ) {
    return 'SELECTION_CHANGED';
  }
  if (
    issued.purchase.lines.some(({ quantity }, index) => {
      const requestedLine = requested.purchase.lines[index];
      return requestedLine === undefined || !sameQuantity(quantity, requestedLine.quantity);
    })
  ) {
    return 'QUANTITY_OR_UNIT_CHANGED';
  }
  return samePurchase(issued.purchase, requested.purchase) ? undefined : 'PURCHASE_CHANGED';
};

const authenticityUnavailable = (confirmationRef: string): PricingCommitmentConfirmationVerificationOutcome => ({
  _tag: 'AUTHENTICITY_UNVERIFIABLE',
  confirmationRef,
  reason: 'DEPENDENCY_UNAVAILABLE',
  retryable: true,
});

const evidenceAuthenticates = (
  evidence: PricingCommitmentConfirmationVerificationEvidence,
  confirmation: PricingCommitmentConfirmationIssued,
  attemptedAt: typeof PricingInstantSchema.Type,
): boolean =>
  evidence.confirmationRef === confirmation.confirmationRef &&
  evidence.issuerRef === confirmation.authenticity.issuerRef &&
  evidence.keyRef === confirmation.authenticity.keyRef &&
  evidence.keyVersion === confirmation.authenticity.keyVersion &&
  evidence.lineageRef === confirmation.authenticity.lineageRef &&
  evidence.payloadDigest === confirmation.authenticity.payloadDigest &&
  evidence.proofRef === confirmation.authenticity.proofRef &&
  evidence.proofVersion === confirmation.authenticity.proofVersion &&
  evidence.verifiedAt === attemptedAt;

/**
 * Verifies one already-issued immutable Confirmation. Source state changes and source outages after
 * issuance are deliberately absent from this service; the bounded owner proof is the authority.
 * Independent Order/Permission/Inventory/Tax/Payment gates remain outside this owner boundary.
 */
export const makePricingCommitmentConfirmationVerificationService = Effect.gen(
  function* makePricingCommitmentConfirmationVerificationService() {
    const ownerVerifier = yield* PricingCommitmentConfirmationOwnerVerifier;
    return {
      verify: Effect.fn('PricingCommitmentConfirmationVerification.verify')(
        function* verifyPricingCommitmentConfirmation(request: PricingCommitmentConfirmationVerificationRequest) {
          const { confirmationRef } = request.confirmation;
          const confirmationOption = Schema.decodeOption(PricingCommitmentConfirmationIssuedSchema, {
            onExcessProperty: 'error',
          })(request.confirmation);
          if (Option.isNone(confirmationOption)) {
            return {
              _tag: 'AUTHENTICITY_INVALID' as const,
              confirmationRef,
              reason: 'PAYLOAD_TAMPERED' as const,
              retryable: false as const,
            };
          }

          const requestedBindingOption = Schema.decodeOption(PricingCommitmentConfirmationBindingSchema, {
            onExcessProperty: 'error',
          })(request.requestedBinding);
          if (Option.isNone(requestedBindingOption)) {
            return {
              _tag: 'BINDING_UNVERIFIABLE' as const,
              confirmationRef,
              reason: 'Requested Attempt and Bundle binding is malformed',
              retryable: true as const,
            };
          }

          const attemptedAtOption = Schema.decodeOption(PricingInstantSchema)(request.attemptedAt);
          if (Option.isNone(attemptedAtOption)) {
            return {
              _tag: 'VALIDITY_UNVERIFIABLE' as const,
              confirmationRef,
              reason: 'TRUSTED_TIME_UNAVAILABLE' as const,
              retryable: true as const,
            };
          }

          const confirmation = confirmationOption.value;
          const attemptedAt = attemptedAtOption.value;
          const ownerRead = yield* ownerVerifier
            .verifyImmutableConfirmation({ confirmation, verifiedAt: attemptedAt })
            .pipe(
              Effect.match({
                onFailure: (failure) => ({ failure, kind: 'failure' as const }),
                onSuccess: (value) => ({ kind: 'success' as const, value }),
              }),
            );
          if (ownerRead.kind === 'failure') {
            return authenticityUnavailable(confirmationRef);
          }

          const ownerOutcome = Schema.decodeUnknownOption(PricingCommitmentConfirmationOwnerVerificationOutcomeSchema, {
            onExcessProperty: 'error',
          })(ownerRead.value);
          if (Option.isNone(ownerOutcome)) {
            return authenticityUnavailable(confirmationRef);
          }

          const authenticity = Match.value(ownerOutcome.value).pipe(
            Match.tag('AUTHENTICITY_INVALID', (invalid) => invalid),
            Match.tag('AUTHENTICITY_UNVERIFIABLE', (unverifiable) => unverifiable),
            Match.tag('VERIFIED', (verified) =>
              evidenceAuthenticates(verified.authenticityEvidence, confirmation, attemptedAt)
                ? verified
                : {
                    _tag: 'AUTHENTICITY_INVALID' as const,
                    confirmationRef,
                    reason: 'INVALID_PROOF' as const,
                    retryable: false as const,
                  },
            ),
            Match.exhaustive,
          );
          if (!Schema.is(PricingCommitmentConfirmationOwnerVerifiedSchema)(authenticity)) {
            return authenticity.confirmationRef === confirmationRef
              ? authenticity
              : {
                  _tag: 'AUTHENTICITY_INVALID' as const,
                  confirmationRef,
                  reason: 'INVALID_PROOF' as const,
                  retryable: false as const,
                };
          }

          const mismatchReason = bindingMismatchReason(confirmation.binding, requestedBindingOption.value);
          if (mismatchReason !== undefined) {
            return {
              _tag: 'BINDING_MISMATCH' as const,
              confirmationRef,
              reason: mismatchReason,
              retryable: false as const,
            };
          }

          const evaluatedMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(attemptedAt));
          const issuedMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.issuedAt));
          const expiresMilliseconds = DateTime.toEpochMillis(DateTime.makeUnsafe(confirmation.expiresAt));
          if (evaluatedMilliseconds < issuedMilliseconds) {
            return {
              _tag: 'NOT_YET_VALID' as const,
              confirmationRef,
              evaluatedAt: attemptedAt,
              issuedAt: confirmation.issuedAt,
            };
          }
          if (evaluatedMilliseconds >= expiresMilliseconds) {
            return {
              _tag: 'EXPIRED' as const,
              confirmationRef,
              evaluatedAt: attemptedAt,
              expiresAt: confirmation.expiresAt,
            };
          }

          return {
            _tag: 'VERIFIED' as const,
            authenticityEvidence: authenticity.authenticityEvidence,
            confirmation,
            verifiedAt: attemptedAt,
          };
        },
      ),
    } satisfies PricingCommitmentConfirmationVerificationService;
  },
);
