import {
  PricingCommitmentConfirmationAuthenticityProofSchema,
  PricingCommitmentConfirmationBindingSchema,
  PricingCommitmentConfirmationIssuedSchema,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import type {
  PricingCommitmentConfirmationAuthenticityProof,
  PricingCommitmentConfirmationBinding,
  PricingCommitmentConfirmationIssuanceOutcome,
  PricingQuotationBackedConfirmationSource,
} from '@app/pricing-contracts/domain/commitment-confirmation';
import { PricingQuotationBindingSchema, PricingQuotationIssuedSchema } from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationBinding,
  PricingQuotationBindingMismatchReason,
  PricingQuotationIssued,
  PricingQuotationProposedEvidenceTransition,
  PricingQuotationRevalidationOutcome,
} from '@app/pricing-contracts/domain/quotation';
import type { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import type { PricingMaterialEvidenceReady } from '@app/pricing-contracts/domain/material-evidence';
import { PricingMaterialEvidenceReadySchema } from '@app/pricing-contracts/domain/material-evidence';
import { Context, DateTime, Effect, Match, Option, Schema } from 'effect';

import type { PricingQuotationBackedConfirmationBindingRejected } from './quotation-backed-confirmation-binding-rejected.ts';
import type { PricingQuotationBackedConfirmationBindingUnavailable } from './quotation-backed-confirmation-binding-unavailable.ts';
import type { PricingCommitmentConfirmationProofIssuanceUnavailable } from './quotation-backed-confirmation-issuance-errors.ts';
import type { PricingQuotationRevalidationService } from './quotation-revalidation.service.ts';

export { PricingQuotationBackedConfirmationBindingRejected } from './quotation-backed-confirmation-binding-rejected.ts';
export { PricingCommitmentConfirmationProofIssuanceUnavailable } from './quotation-backed-confirmation-issuance-errors.ts';

const maximumConfirmationLifetimeMilliseconds = 30_000;
const samePurchase = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameQuotation = Schema.toEquivalence(PricingQuotationIssuedSchema);
const sameMaterialEvidence = Schema.toEquivalence(PricingMaterialEvidenceReadySchema);

export interface PricingQuotationBackedConfirmationIssuanceCandidate {
  readonly binding: PricingCommitmentConfirmationBinding;
  readonly materialEvidence: PricingMaterialEvidenceReady;
  readonly proposedEvidence?: PricingQuotationProposedEvidenceTransition;
  readonly quotation: PricingQuotationIssued;
  readonly requestedBinding: PricingQuotationBinding;
}

interface PricingCommitmentConfirmationUnsignedProofInput {
  readonly binding: PricingCommitmentConfirmationBinding;
  readonly expiresAt: typeof PricingInstantSchema.Type;
  readonly issuedAt: typeof PricingInstantSchema.Type;
  readonly source: PricingQuotationBackedConfirmationSource;
  readonly terms: PricingQuotationIssued['quotedResult'];
}

interface PricingCommitmentConfirmationProofIssuer {
  /**
   * Owner-private reference/signing port. The caller cannot select a Confirmation identity,
   * signing key, payload digest, or proof lineage.
   */
  readonly issueProof: (input: PricingCommitmentConfirmationUnsignedProofInput) => Effect.Effect<
    {
      readonly authenticity: PricingCommitmentConfirmationAuthenticityProof;
      readonly confirmationRef: string;
    },
    PricingCommitmentConfirmationProofIssuanceUnavailable
  >;
}

interface PricingQuotationBackedConfirmationBindingAuthority {
  /**
   * Owner-private final read of the permanent Attempt. Success means the Attempt exists and still
   * names this exact pre-attempt Bundle reference, hash, version, and purchase meaning.
   */
  readonly verifyUnchangedBinding: (input: {
    readonly binding: PricingCommitmentConfirmationBinding;
    readonly issuedAt: typeof PricingInstantSchema.Type;
    readonly source: PricingQuotationBackedConfirmationSource;
  }) => Effect.Effect<
    void,
    PricingQuotationBackedConfirmationBindingRejected | PricingQuotationBackedConfirmationBindingUnavailable
  >;
}

export interface PricingQuotationBackedConfirmationIssuanceService {
  readonly issue: (
    input: PricingQuotationBackedConfirmationIssuanceCandidate,
  ) => Effect.Effect<PricingCommitmentConfirmationIssuanceOutcome>;
}

export class PricingQuotationBackedConfirmationIssuance extends Context.Service<
  PricingQuotationBackedConfirmationIssuance,
  PricingQuotationBackedConfirmationIssuanceService
>()(
  '@app/pricing/services/quotation-backed-confirmation-issuance.service/PricingQuotationBackedConfirmationIssuance',
) {}

interface PricingQuotationBackedConfirmationIssuanceDependencies {
  readonly bindingAuthority: PricingQuotationBackedConfirmationBindingAuthority;
  readonly proofIssuer: PricingCommitmentConfirmationProofIssuer;
  readonly revalidation: PricingQuotationRevalidationService;
}

const mismatchReason = (
  reason: PricingQuotationBindingMismatchReason,
): Extract<PricingCommitmentConfirmationIssuanceOutcome, { readonly _tag: 'BINDING_MISMATCH' }>['reason'] =>
  Match.value(reason).pipe(
    Match.whenOr('AUTHORITY_CONTEXT_CHANGED', 'TENANT_CHANGED', () => 'AUTHORITY_CONTEXT_CHANGED' as const),
    Match.when('CANDIDATE_CHANGED', () => 'CANDIDATE_CHANGED' as const),
    Match.when('COMMERCIAL_SCOPE_CHANGED', () => 'COMMERCIAL_SCOPE_CHANGED' as const),
    Match.whenOr('CURRENCY_CHANGED', 'MONETARY_BOUNDARY_CHANGED', () => 'CURRENCY_OR_BASIS_CHANGED' as const),
    Match.when('OCCURRENCE_STRUCTURE_CHANGED', () => 'OCCURRENCE_STRUCTURE_CHANGED' as const),
    Match.when('QUANTITY_CHANGED', () => 'QUANTITY_OR_UNIT_CHANGED' as const),
    Match.when('SELECTION_CHANGED', () => 'SELECTION_CHANGED' as const),
    Match.when('MATERIAL_EVIDENCE_CHANGED', () => 'PURCHASE_CHANGED' as const),
    Match.exhaustive,
  );

const sourceFailure = (
  result: Exclude<PricingQuotationRevalidationOutcome, { readonly kind: 'EXACT_REUSE' }>,
): PricingCommitmentConfirmationIssuanceOutcome =>
  Match.value(result).pipe(
    Match.when({ kind: 'NEW_QUOTATION_REQUIRED' }, (mismatch) => ({
      _tag: 'BINDING_MISMATCH' as const,
      reason: mismatchReason(mismatch.mismatchReason),
      retryable: false as const,
    })),
    Match.when({ kind: 'EXPIRED' }, () => ({
      _tag: 'SOURCE_INVALID' as const,
      reason: 'QUOTATION_EXPIRED',
      retryable: false as const,
    })),
    Match.when({ kind: 'NOT_YET_VALID' }, () => ({
      _tag: 'SOURCE_INVALID' as const,
      reason: 'QUOTATION_NOT_YET_VALID',
      retryable: false as const,
    })),
    Match.when({ kind: 'AUTHENTICITY_INVALID' }, (invalid) => ({
      _tag: 'SOURCE_INVALID' as const,
      reason: `QUOTATION_${invalid.reason}`,
      retryable: false as const,
    })),
    Match.whenOr(
      { kind: 'AUTHENTICITY_UNVERIFIABLE' },
      { kind: 'BINDING_UNVERIFIABLE' },
      { kind: 'VALIDITY_UNVERIFIABLE' },
      (unverifiable) => ({
        _tag: 'SOURCE_UNVERIFIABLE' as const,
        reason: `QUOTATION_${unverifiable.reason}`,
        retryable: unverifiable.retryable,
      }),
    ),
    Match.exhaustive,
  );

const invalidSource = (reason: string): PricingCommitmentConfirmationIssuanceOutcome => ({
  _tag: 'SOURCE_INVALID',
  reason,
  retryable: false,
});

/**
 * Issues a new immutable Confirmation exclusively from a freshly revalidated #785 Quotation.
 * The successful path has no ordinary Current Price dependency: its terms and source lineage are
 * the original quotation's exact values, capped by the quotation's still-live interval.
 */
export const makePricingQuotationBackedConfirmationIssuanceService = (
  dependencies: PricingQuotationBackedConfirmationIssuanceDependencies,
): typeof PricingQuotationBackedConfirmationIssuance.Service => ({
  issue: Effect.fn('PricingQuotationBackedConfirmationIssuance.issue')(function* issueQuotationConfirmation(input) {
    const binding = Schema.decodeOption(PricingCommitmentConfirmationBindingSchema, {
      onExcessProperty: 'error',
    })(input.binding);
    const requestedBinding = Schema.decodeOption(PricingQuotationBindingSchema, {
      onExcessProperty: 'error',
    })(input.requestedBinding);
    if (Option.isNone(binding) || Option.isNone(requestedBinding)) {
      return invalidSource('INVALID_CONFIRMATION_BINDING');
    }
    if (!samePurchase(binding.value.purchase, requestedBinding.value)) {
      return {
        _tag: 'BINDING_MISMATCH' as const,
        reason: 'PURCHASE_CHANGED' as const,
        retryable: false as const,
      };
    }

    const baseRevalidationRequest = {
      kind: 'REVALIDATE_PRICING_QUOTATION',
      quotation: input.quotation,
      requestedBinding: requestedBinding.value,
    } as const;
    const revalidationRequest =
      input.proposedEvidence === undefined
        ? baseRevalidationRequest
        : { ...baseRevalidationRequest, proposedEvidence: input.proposedEvidence };
    const revalidation = yield* dependencies.revalidation.revalidate(revalidationRequest);
    if (revalidation.kind !== 'EXACT_REUSE') {
      return sourceFailure(revalidation);
    }
    if (!sameQuotation(revalidation.quotation, input.quotation)) {
      return {
        _tag: 'SOURCE_UNVERIFIABLE' as const,
        reason: 'QUOTATION_REVALIDATION_CHANGED_IMMUTABLE_QUOTATION',
        retryable: false as const,
      };
    }
    if (!sameMaterialEvidence(input.materialEvidence, revalidation.quotation.materialEvidence)) {
      return invalidSource('QUOTATION_MATERIAL_EVIDENCE_CHANGED');
    }

    const issuedAt = revalidation.evaluatedAt;
    const maximumExpiresAt = DateTime.makeUnsafe(issuedAt).pipe(
      DateTime.add({ milliseconds: maximumConfirmationLifetimeMilliseconds }),
      DateTime.formatIso,
    );
    const expiresAt =
      maximumExpiresAt < revalidation.quotation.validity.validUntil
        ? maximumExpiresAt
        : revalidation.quotation.validity.validUntil;
    if (expiresAt <= issuedAt) {
      return invalidSource('QUOTATION_HAS_NO_POSITIVE_CONFIRMATION_INTERVAL');
    }

    const source = {
      kind: 'QUOTATION_BACKED' as const,
      materialEvidence: revalidation.quotation.materialEvidence,
      quotationRevalidation: revalidation,
    };
    const bindingVerification = yield* dependencies.bindingAuthority
      .verifyUnchangedBinding({ binding: binding.value, issuedAt, source })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ failure }) as const,
          onSuccess: () => ({ verified: true }) as const,
        }),
      );
    if ('failure' in bindingVerification) {
      return Match.value(bindingVerification.failure).pipe(
        Match.tag('PricingQuotationBackedConfirmationBindingRejected', ({ reason }) => ({
          _tag: 'BINDING_MISMATCH' as const,
          reason,
          retryable: false as const,
        })),
        Match.tag('PricingQuotationBackedConfirmationBindingUnavailable', ({ reason, retryable }) => ({
          _tag: 'SOURCE_UNVERIFIABLE' as const,
          reason,
          retryable,
        })),
        Match.exhaustive,
      );
    }
    const proof = yield* dependencies.proofIssuer
      .issueProof({
        binding: binding.value,
        expiresAt,
        issuedAt,
        source,
        terms: revalidation.quotation.quotedResult,
      })
      .pipe(
        Effect.match({
          onFailure: (failure) => ({ failure, kind: 'unavailable' as const }),
          onSuccess: (issued) => ({ issued, kind: 'issued' as const }),
        }),
      );
    if (proof.kind === 'unavailable') {
      return {
        _tag: 'SOURCE_UNVERIFIABLE' as const,
        reason: 'CONFIRMATION_PROOF_ISSUANCE_UNAVAILABLE',
        retryable: true as const,
      };
    }
    if (!Schema.is(PricingCommitmentConfirmationAuthenticityProofSchema)(proof.issued.authenticity)) {
      return {
        _tag: 'SOURCE_UNVERIFIABLE' as const,
        reason: 'CONFIRMATION_PROOF_ISSUANCE_INVALID',
        retryable: true as const,
      };
    }

    const confirmation = Schema.decodeOption(PricingCommitmentConfirmationIssuedSchema, {
      onExcessProperty: 'error',
    })({
      authenticity: proof.issued.authenticity,
      binding: binding.value,
      confirmationRef: proof.issued.confirmationRef,
      expiresAt,
      issuedAt,
      kind: 'PRICING_COMMITMENT_CONFIRMATION',
      source,
      terms: revalidation.quotation.quotedResult,
    });
    if (Option.isNone(confirmation)) {
      return invalidSource('ISSUED_CONFIRMATION_FAILED_CANONICAL_VALIDATION');
    }

    return {
      _tag: 'ISSUED',
      confirmation: confirmation.value,
    } satisfies PricingCommitmentConfirmationIssuanceOutcome;
  }),
});
