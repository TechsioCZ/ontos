import {
  PricingQuotationAuthorityBindingSchema,
  PricingQuotationBindingSchema,
  PricingQuotationLineBindingSchema,
  PricingQuotationOwnerTransitionEvidenceSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationBinding,
  PricingQuotationBindingMismatchReason,
  PricingQuotationBindingRevalidationAssessment,
  PricingQuotationOwnerTransitionEvidence,
  PricingQuotationProposedEvidenceTransition,
  PricingQuotationRevalidationRequest,
} from '@app/pricing-contracts/domain/quotation';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCatalogSelectionSchema, PricingQuantitySchema } from '@app/pricing-contracts/pricing-decision';
import { Context, Data, Effect, Option, Schema } from 'effect';

import { PricingGuestQuotationAuthority } from './guest-quotation-authority.service.ts';
import type { PricingGuestQuotationAuthorityService } from './guest-quotation-authority.service.ts';

const PricingAuthenticatedQuotationAuthorityVerifiedSchema = Schema.Struct({
  binding: Schema.toType(PricingQuotationBindingSchema),
  kind: Schema.Literal('PRICING_AUTHENTICATED_QUOTATION_AUTHORITY_VERIFIED'),
  quotationRef: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
});
export type PricingAuthenticatedQuotationAuthorityVerified =
  typeof PricingAuthenticatedQuotationAuthorityVerifiedSchema.Type;

export const PricingAuthenticatedQuotationAuthorityDeniedSchema = Schema.TaggedStruct(
  'PricingAuthenticatedQuotationAuthorityDenied',
  {
    reason: Schema.Literal('SUBJECT_OR_ACTOR_NOT_AUTHORIZED'),
    retryable: Schema.Literal(false),
  },
);
export type PricingAuthenticatedQuotationAuthorityDenied =
  typeof PricingAuthenticatedQuotationAuthorityDeniedSchema.Type;

export const PricingAuthenticatedQuotationAuthorityUnavailableSchema = Schema.TaggedStruct(
  'PricingAuthenticatedQuotationAuthorityUnavailable',
  {
    reason: Schema.Literals(['OWNER_EVIDENCE_UNVERIFIABLE', 'OWNER_VERIFICATION_UNAVAILABLE']),
    retryable: Schema.Literal(true),
  },
);
export type PricingAuthenticatedQuotationAuthorityUnavailable =
  typeof PricingAuthenticatedQuotationAuthorityUnavailableSchema.Type;

export interface PricingAuthenticatedQuotationAuthorityService {
  /**
   * Resolves the live authenticated subject, Actor access, and request context from owner-private
   * state. Exact references in a retained quotation are not authority by themselves.
   */
  readonly verify: (input: {
    readonly quotationRef: string;
    readonly quotedBinding: PricingQuotationBinding;
    readonly requestedBinding: PricingQuotationBinding;
  }) => Effect.Effect<
    PricingAuthenticatedQuotationAuthorityVerified,
    PricingAuthenticatedQuotationAuthorityDenied | PricingAuthenticatedQuotationAuthorityUnavailable
  >;
}

export class PricingAuthenticatedQuotationAuthority extends Context.Service<
  PricingAuthenticatedQuotationAuthority,
  PricingAuthenticatedQuotationAuthorityService
>()('@app/pricing/services/quotation-binding-revalidation.service/PricingAuthenticatedQuotationAuthority') {}

export class PricingQuotationOwnerTransitionFailure extends Data.TaggedError('PricingQuotationOwnerTransitionFailure')<{
  readonly reason:
    | 'MATERIAL_CHANGE'
    | 'OWNER_ATTESTATION_REJECTED'
    | 'OWNER_EVIDENCE_UNVERIFIABLE'
    | 'OWNER_UNAVAILABLE';
  readonly retryable: boolean;
}> {}

export interface PricingQuotationOwnerTransitionVerificationInput {
  readonly proposedEvidence: PricingQuotationProposedEvidenceTransition;
  readonly quotation: PricingQuotationRevalidationRequest['quotation'];
  readonly requestedBinding: PricingQuotationBinding;
}

export interface PricingQuotationOwnerTransitionVerifierService {
  /**
   * Calls the domain that owns the changed evidence. Equal JSON, revision labels, or monetary
   * results cannot implement this capability; the owner must issue a bound attestation.
   */
  readonly verifyTransition: (
    input: PricingQuotationOwnerTransitionVerificationInput,
  ) => Effect.Effect<PricingQuotationOwnerTransitionEvidence, PricingQuotationOwnerTransitionFailure>;
}

export class PricingQuotationOwnerTransitionVerifier extends Context.Service<
  PricingQuotationOwnerTransitionVerifier,
  PricingQuotationOwnerTransitionVerifierService
>()('@app/pricing/services/quotation-binding-revalidation.service/PricingQuotationOwnerTransitionVerifier') {}

export interface PricingQuotationBindingRevalidationService {
  readonly assess: (
    request: PricingQuotationRevalidationRequest,
  ) => Effect.Effect<PricingQuotationBindingRevalidationAssessment>;
}

export class PricingQuotationBindingRevalidation extends Context.Service<
  PricingQuotationBindingRevalidation,
  PricingQuotationBindingRevalidationService
>()('@app/pricing/services/quotation-binding-revalidation.service/PricingQuotationBindingRevalidation') {}

const sameAuthority = Schema.toEquivalence(PricingQuotationAuthorityBindingSchema);
const sameBinding = Schema.toEquivalence(PricingQuotationBindingSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameLine = Schema.toEquivalence(PricingQuotationLineBindingSchema);
const sameQuantity = Schema.toEquivalence(PricingQuantitySchema);
const sameSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);

const bindingMismatch = (
  issued: PricingQuotationBinding,
  requested: PricingQuotationBinding,
): PricingQuotationBindingMismatchReason | undefined => {
  if (issued.candidateRef !== requested.candidateRef) {
    return 'CANDIDATE_CHANGED';
  }
  if (issued.tenantId !== requested.tenantId) {
    return 'TENANT_CHANGED';
  }
  if (!sameCommercialScope(issued.commercialScope, requested.commercialScope)) {
    return 'COMMERCIAL_SCOPE_CHANGED';
  }
  if (issued.currencyCode !== requested.currencyCode) {
    return 'CURRENCY_CHANGED';
  }
  if (issued.monetaryBoundary !== requested.monetaryBoundary) {
    return 'MONETARY_BOUNDARY_CHANGED';
  }
  if (!sameAuthority(issued.subject, requested.subject)) {
    return 'AUTHORITY_CONTEXT_CHANGED';
  }
  if (
    issued.lines.length !== requested.lines.length ||
    issued.lines.some((line, index) => line.occurrenceId !== requested.lines[index]?.occurrenceId)
  ) {
    return 'OCCURRENCE_STRUCTURE_CHANGED';
  }
  for (let index = 0; index < issued.lines.length; index += 1) {
    const issuedLine = issued.lines[index];
    const requestedLine = requested.lines[index];
    if (issuedLine === undefined || requestedLine === undefined) {
      return 'OCCURRENCE_STRUCTURE_CHANGED';
    }
    if (!sameQuantity(issuedLine.quantity, requestedLine.quantity)) {
      return 'QUANTITY_CHANGED';
    }
    if (!sameSelection(issuedLine.selection, requestedLine.selection)) {
      return 'SELECTION_CHANGED';
    }
    if (!sameLine(issuedLine, requestedLine)) {
      return 'OCCURRENCE_STRUCTURE_CHANGED';
    }
  }
  return undefined;
};

const unverifiable = (
  quotationRef: string,
  reason: 'BINDING_DEPENDENCY_UNAVAILABLE' | 'OWNER_EVIDENCE_UNAVAILABLE' | 'OWNER_REVALIDATION_UNAVAILABLE',
): PricingQuotationBindingRevalidationAssessment => ({
  kind: 'BINDING_UNVERIFIABLE',
  quotationRef,
  reason,
  retryable: true,
});

const transitionMatchesRequest = (
  evidence: PricingQuotationOwnerTransitionEvidence,
  request: PricingQuotationRevalidationRequest & {
    readonly proposedEvidence: PricingQuotationProposedEvidenceTransition;
  },
): boolean =>
  evidence.quotationRef === request.quotation.quotationRef &&
  evidence.candidateRef === request.quotation.binding.candidateRef &&
  evidence.tenantId === request.quotation.binding.tenantId &&
  evidence.ownerModuleId === request.proposedEvidence.ownerModuleId &&
  evidence.originalEvidenceRef === request.proposedEvidence.originalEvidenceRef &&
  evidence.proposedEvidenceRef === request.proposedEvidence.proposedEvidenceRef;

/**
 * Resolves only the binding/evidence part of quotation revalidation. It never reads Current Price,
 * substitutes a newer result, or mutates/rebinds the immutable quotation. An explicit evidence
 * transition is authority only after the owning domain confirms it as non-material.
 */
export const makePricingQuotationBindingRevalidationService = Effect.gen(
  function* makePricingQuotationBindingRevalidationService() {
    const ownerTransitionVerifier = yield* PricingQuotationOwnerTransitionVerifier;
    const guestAuthority: PricingGuestQuotationAuthorityService = yield* PricingGuestQuotationAuthority;
    const authenticatedAuthority = yield* PricingAuthenticatedQuotationAuthority;
    return {
      assess: Effect.fn('PricingQuotationBindingRevalidation.assess')(function* assessPricingQuotationBinding(
        request: PricingQuotationRevalidationRequest,
      ) {
        const mismatch = bindingMismatch(request.quotation.binding, request.requestedBinding);
        if (mismatch !== undefined) {
          return {
            kind: 'MISMATCH' as const,
            quotationRef: request.quotation.quotationRef,
            reason: mismatch,
          };
        }

        if (request.quotation.binding.subject.kind === 'GUEST') {
          const authority = yield* guestAuthority
            .verify({
              quotationRef: request.quotation.quotationRef,
              quotedBinding: request.quotation.binding,
              requestedBinding: request.requestedBinding,
            })
            .pipe(
              Effect.as({ kind: 'verified' as const }),
              Effect.catchTags({
                PricingGuestQuotationAuthorityRejected: () => Effect.succeed({ kind: 'rejected' as const }),
                PricingGuestQuotationAuthorityUnavailable: () => Effect.succeed({ kind: 'unavailable' as const }),
              }),
            );
          if (authority.kind === 'rejected') {
            return {
              kind: 'MISMATCH' as const,
              quotationRef: request.quotation.quotationRef,
              reason: 'AUTHORITY_CONTEXT_CHANGED' as const,
            };
          }
          if (authority.kind === 'unavailable') {
            return unverifiable(request.quotation.quotationRef, 'BINDING_DEPENDENCY_UNAVAILABLE');
          }
        } else {
          const authority = yield* authenticatedAuthority
            .verify({
              quotationRef: request.quotation.quotationRef,
              quotedBinding: request.quotation.binding,
              requestedBinding: request.requestedBinding,
            })
            .pipe(
              Effect.map((evidence) => ({ evidence, kind: 'verified' as const })),
              Effect.catchTags({
                PricingAuthenticatedQuotationAuthorityDenied: () => Effect.succeed({ kind: 'rejected' as const }),
                PricingAuthenticatedQuotationAuthorityUnavailable: () =>
                  Effect.succeed({ kind: 'unavailable' as const }),
              }),
            );
          if (authority.kind === 'rejected') {
            return {
              kind: 'MISMATCH' as const,
              quotationRef: request.quotation.quotationRef,
              reason: 'AUTHORITY_CONTEXT_CHANGED' as const,
            };
          }
          if (authority.kind === 'unavailable') {
            return unverifiable(request.quotation.quotationRef, 'BINDING_DEPENDENCY_UNAVAILABLE');
          }
          const verified = Schema.decodeOption(PricingAuthenticatedQuotationAuthorityVerifiedSchema)(
            authority.evidence,
          );
          if (
            Option.isNone(verified) ||
            verified.value.quotationRef !== request.quotation.quotationRef ||
            verified.value.binding.subject.kind !== 'AUTHENTICATED' ||
            !sameBinding(verified.value.binding, request.requestedBinding)
          ) {
            return unverifiable(request.quotation.quotationRef, 'BINDING_DEPENDENCY_UNAVAILABLE');
          }
        }

        const { proposedEvidence } = request;
        if (proposedEvidence === undefined) {
          return {
            kind: 'EXACT_MATCH' as const,
            quotationRef: request.quotation.quotationRef,
          };
        }
        if (proposedEvidence.originalEvidenceRef === proposedEvidence.proposedEvidenceRef) {
          return {
            kind: 'MISMATCH' as const,
            quotationRef: request.quotation.quotationRef,
            reason: 'MATERIAL_EVIDENCE_CHANGED' as const,
          };
        }

        const verification = yield* ownerTransitionVerifier
          .verifyTransition({
            proposedEvidence,
            quotation: request.quotation,
            requestedBinding: request.requestedBinding,
          })
          .pipe(
            Effect.match({
              onFailure: (failure) => ({ failure, kind: 'failure' as const }),
              onSuccess: (evidence) => ({ evidence, kind: 'success' as const }),
            }),
          );
        if (verification.kind === 'failure') {
          return verification.failure.retryable
            ? unverifiable(request.quotation.quotationRef, 'OWNER_REVALIDATION_UNAVAILABLE')
            : {
                kind: 'MISMATCH' as const,
                quotationRef: request.quotation.quotationRef,
                reason: 'MATERIAL_EVIDENCE_CHANGED' as const,
              };
        }

        const transitionEvidence = Schema.decodeOption(PricingQuotationOwnerTransitionEvidenceSchema)(
          verification.evidence,
        );
        if (
          Option.isNone(transitionEvidence) ||
          !transitionMatchesRequest(transitionEvidence.value, {
            ...request,
            proposedEvidence,
          })
        ) {
          return unverifiable(request.quotation.quotationRef, 'OWNER_EVIDENCE_UNAVAILABLE');
        }

        return {
          kind: 'OWNER_REVALIDATION_ACCEPTED' as const,
          transitionEvidence: transitionEvidence.value,
        };
      }),
    } satisfies PricingQuotationBindingRevalidationService;
  },
);
