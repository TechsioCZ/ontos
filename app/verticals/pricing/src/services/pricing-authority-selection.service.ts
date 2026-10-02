import type { PricingCommercialTotalReady } from '@app/pricing-contracts/domain/commercial-total';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import {
  PricingCurrentCommercialResultSchema,
  PricingQuotationIssuedSchema,
  PricingRetainedDisplayOnlyResultSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingCurrentCommercialResult,
  PricingQuotationIssued,
  PricingRetainedDisplayOnlyResult,
} from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const boundedMessage = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
type PricingInstant = typeof PricingInstantSchema.Type;

export class PricingAuthorityDependencyFailure extends Schema.TaggedError<PricingAuthorityDependencyFailure>()(
  'PricingAuthorityDependencyFailure',
  {
    message: boundedMessage,
    owner: Schema.Literals(['CURRENT_PRICING', 'QUOTATION_VERIFICATION']),
    retryable: Schema.Boolean,
  },
) {}

interface PricingCurrentEvaluationRequest {
  readonly candidateRef: string;
  readonly trustedOperationAt: PricingInstant;
}

interface PricingCurrentEvaluationPort {
  readonly evaluateCurrent: (
    request: PricingCurrentEvaluationRequest,
  ) => Effect.Effect<PricingCurrentCommercialResult, PricingAuthorityDependencyFailure>;
}

interface PricingQuotationVerificationRequest {
  readonly candidateRef: string;
  readonly quotation: PricingQuotationIssued;
  readonly trustedOperationAt: PricingInstant;
}

type PricingQuotationVerificationOutcome =
  | {
      readonly kind: 'QUOTATION_VERIFIED';
      readonly quotation: PricingQuotationIssued;
      readonly verificationRef: string;
      readonly verifiedAt: PricingInstant;
    }
  | {
      readonly kind: 'QUOTATION_EXPIRED' | 'QUOTATION_MISMATCHED' | 'QUOTATION_UNVERIFIABLE';
      readonly reason: string;
    };

interface PricingQuotationVerificationPort {
  /**
   * #785 owns the verification implementation. This port deliberately returns a proof-bearing
   * assessment and never asks the ordinary Current evaluator to reproduce historical terms.
   */
  readonly verifyQuotation: (
    request: PricingQuotationVerificationRequest,
  ) => Effect.Effect<PricingQuotationVerificationOutcome, PricingAuthorityDependencyFailure>;
}

export type PricingMonetaryAuthoritySelectionRequest =
  | {
      readonly candidateRef: string;
      readonly kind: 'CURRENT_BACKED';
      readonly trustedOperationAt: PricingInstant;
    }
  | {
      readonly candidateRef: string;
      readonly kind: 'QUOTATION_BACKED';
      readonly quotation: PricingQuotationIssued;
      readonly trustedOperationAt: PricingInstant;
    }
  | {
      readonly kind: 'RETAINED_DISPLAY_ONLY';
      readonly retained: PricingRetainedDisplayOnlyResult;
    };

type PricingMonetaryAuthoritySelection =
  | {
      readonly authority: PricingCurrentCommercialResult;
      readonly commercialTotal: PricingCommercialTotalReady;
      readonly kind: 'CURRENT_BACKED_TERMS_SELECTED';
    }
  | {
      readonly commercialTotal: PricingCommercialTotalReady;
      readonly kind: 'QUOTATION_BACKED_TERMS_SELECTED';
      readonly quotation: PricingQuotationIssued;
      readonly verification: {
        readonly verificationRef: string;
        readonly verifiedAt: PricingInstant;
      };
    }
  | {
      readonly kind: 'MONETARY_AUTHORITY_REJECTED';
      readonly reason:
        | 'CURRENT_EVALUATION_UNAVAILABLE'
        | 'CURRENT_RESULT_UNVERIFIABLE'
        | 'QUOTATION_EXPIRED'
        | 'QUOTATION_MISMATCHED'
        | 'QUOTATION_UNVERIFIABLE'
        | 'QUOTATION_VERIFICATION_UNAVAILABLE'
        | 'RETAINED_DISPLAY_ONLY';
      readonly retryable: boolean;
    };

interface PricingAuthoritySelectionDependencies {
  readonly current: PricingCurrentEvaluationPort;
  readonly quotation: PricingQuotationVerificationPort;
}

interface PricingAuthoritySelectionService {
  readonly select: (
    request: PricingMonetaryAuthoritySelectionRequest,
  ) => Effect.Effect<PricingMonetaryAuthoritySelection>;
}

const sameQuotation = Schema.toEquivalence(PricingQuotationIssuedSchema);

const rejected = (
  reason: Extract<PricingMonetaryAuthoritySelection, { readonly kind: 'MONETARY_AUTHORITY_REJECTED' }>['reason'],
  retryable = false,
): PricingMonetaryAuthoritySelection => ({ kind: 'MONETARY_AUTHORITY_REJECTED', reason, retryable });

const quotationFailureReason = (
  kind: Exclude<PricingQuotationVerificationOutcome['kind'], 'QUOTATION_VERIFIED'>,
): Extract<PricingMonetaryAuthoritySelection, { readonly kind: 'MONETARY_AUTHORITY_REJECTED' }>['reason'] => kind;

const validCurrentResult = (
  result: PricingCurrentCommercialResult,
  request: PricingCurrentEvaluationRequest,
): boolean =>
  Schema.is(PricingCurrentCommercialResultSchema)(result) &&
  result.commercialTotal.candidateRef === request.candidateRef &&
  result.commercialTotal.decision.operationTime === request.trustedOperationAt &&
  result.commercialTotal.decision.monetaryBoundary === 'PRE_TAX';

/**
 * Chooses one monetary authority without making a retained display authoritative. The quotation
 * path preserves the exact issued terms and never invokes ordinary Current evaluation.
 */
export const makePricingAuthoritySelectionService = (
  dependencies: PricingAuthoritySelectionDependencies,
): PricingAuthoritySelectionService => ({
  select: Effect.fn('PricingAuthoritySelection.select')(function* selectPricingMonetaryAuthority(
    request: PricingMonetaryAuthoritySelectionRequest,
  ) {
    if (request.kind === 'RETAINED_DISPLAY_ONLY') {
      return Schema.is(PricingRetainedDisplayOnlyResultSchema)(request.retained)
        ? rejected('RETAINED_DISPLAY_ONLY')
        : rejected('CURRENT_RESULT_UNVERIFIABLE');
    }

    const requestIdentityIsValid =
      Schema.is(stableReference)(request.candidateRef) && Schema.is(PricingInstantSchema)(request.trustedOperationAt);
    if (!requestIdentityIsValid) {
      return request.kind === 'CURRENT_BACKED'
        ? rejected('CURRENT_RESULT_UNVERIFIABLE')
        : rejected('QUOTATION_UNVERIFIABLE');
    }

    if (request.kind === 'CURRENT_BACKED') {
      const currentRequest: PricingCurrentEvaluationRequest = {
        candidateRef: request.candidateRef,
        trustedOperationAt: request.trustedOperationAt,
      };
      const result = yield* dependencies.current.evaluateCurrent(currentRequest).pipe(
        Effect.match({
          onFailure: (failure) => ({ failure, kind: 'FAILURE' as const }),
          onSuccess: (authority) => ({ authority, kind: 'SUCCESS' as const }),
        }),
      );
      if (result.kind === 'FAILURE') {
        return rejected('CURRENT_EVALUATION_UNAVAILABLE', result.failure.retryable);
      }
      const { authority } = result;
      return validCurrentResult(authority, request)
        ? {
            authority,
            commercialTotal: authority.commercialTotal,
            kind: 'CURRENT_BACKED_TERMS_SELECTED' as const,
          }
        : rejected('CURRENT_RESULT_UNVERIFIABLE');
    }

    if (
      !Schema.is(PricingQuotationIssuedSchema)(request.quotation) ||
      request.quotation.quotedResult.candidateRef !== request.candidateRef
    ) {
      return rejected('QUOTATION_UNVERIFIABLE');
    }

    const quotationRequest: PricingQuotationVerificationRequest = {
      candidateRef: request.candidateRef,
      quotation: request.quotation,
      trustedOperationAt: request.trustedOperationAt,
    };
    const verificationResult = yield* dependencies.quotation.verifyQuotation(quotationRequest).pipe(
      Effect.match({
        onFailure: (failure) => ({ failure, kind: 'FAILURE' as const }),
        onSuccess: (verification) => ({ kind: 'SUCCESS' as const, verification }),
      }),
    );
    if (verificationResult.kind === 'FAILURE') {
      return rejected('QUOTATION_VERIFICATION_UNAVAILABLE', verificationResult.failure.retryable);
    }
    const { verification } = verificationResult;
    if (verification.kind !== 'QUOTATION_VERIFIED') {
      return rejected(quotationFailureReason(verification.kind), verification.kind === 'QUOTATION_UNVERIFIABLE');
    }
    if (
      !Schema.is(PricingQuotationIssuedSchema)(verification.quotation) ||
      !sameQuotation(request.quotation, verification.quotation) ||
      verification.verifiedAt !== request.trustedOperationAt ||
      !Schema.is(stableReference)(verification.verificationRef)
    ) {
      return rejected('QUOTATION_UNVERIFIABLE');
    }
    return {
      commercialTotal: request.quotation.quotedResult,
      kind: 'QUOTATION_BACKED_TERMS_SELECTED',
      quotation: request.quotation,
      verification: {
        verificationRef: verification.verificationRef,
        verifiedAt: verification.verifiedAt,
      },
    };
  }),
});
