import type {
  PricingQuotationBinding,
  PricingQuotationIssued,
  PricingQuotationValidityEvaluation,
} from '@app/pricing-contracts/domain/quotation';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Context, Data, Effect, Option, Schema } from 'effect';

import { PricingQuotationScopeVerification } from './quotation-scope-verification.service.ts';
import type {
  PricingQuotationScopeVerificationOutcome,
  PricingQuotationScopeVerificationService,
} from './quotation-scope-verification.service.ts';

export interface PricingQuotationValidityRequest {
  readonly quotation: PricingQuotationIssued;
  readonly requestedBinding: PricingQuotationBinding;
}

type PricingQuotationScopeNonApplicable = Exclude<
  PricingQuotationScopeVerificationOutcome,
  { readonly kind: 'QUOTATION_SCOPE_APPLICABLE' }
>;

export type PricingQuotationValidityOutcome = PricingQuotationScopeNonApplicable | PricingQuotationValidityEvaluation;

export class PricingQuotationValidityTimeUnavailable extends Data.TaggedError(
  'PricingQuotationValidityTimeUnavailable',
)<{
  readonly reason: 'TRUSTED_TIME_UNAVAILABLE';
}> {}

export interface PricingQuotationValidityTrustedTimeService {
  /** Owner-private trusted time. A request, browser clock, or cached payload cannot supply it. */
  readonly readOperationTime: Effect.Effect<string, PricingQuotationValidityTimeUnavailable>;
}

export class PricingQuotationValidityTrustedTime extends Context.Service<
  PricingQuotationValidityTrustedTime,
  PricingQuotationValidityTrustedTimeService
>()('@app/pricing/services/quotation-validity.service/PricingQuotationValidityTrustedTime') {}

export interface PricingQuotationValidityService {
  readonly verify: (request: PricingQuotationValidityRequest) => Effect.Effect<PricingQuotationValidityOutcome>;
}

class PricingQuotationValidity extends Context.Service<PricingQuotationValidity, PricingQuotationValidityService>()(
  '@app/pricing/services/quotation-validity.service/PricingQuotationValidity',
) {}

/**
 * Evaluates one immutable quotation against its original exact purchase binding and owner-private
 * backend time. It deliberately has no Current Price, Discount, Fee, promotion, or source-read
 * dependency: ordinary commercial changes and source outages cannot reprice or revoke a matching
 * quotation before its exclusive end.
 */
export const makePricingQuotationValidityService = Effect.gen(function* makePricingQuotationValidityService() {
  const scopeVerification: PricingQuotationScopeVerificationService = yield* PricingQuotationScopeVerification;
  const trustedTime = yield* PricingQuotationValidityTrustedTime;
  return {
    verify: Effect.fn('PricingQuotationValidity.verify')(function* verifyPricingQuotationValidity(
      request: PricingQuotationValidityRequest,
    ) {
      const scope = yield* scopeVerification.verify(request);
      if (scope.kind !== 'QUOTATION_SCOPE_APPLICABLE') {
        return scope;
      }

      const trustedTimeRead = yield* trustedTime.readOperationTime.pipe(
        Effect.match({
          onFailure: (failure) => ({ failure, kind: 'failure' as const }),
          onSuccess: (value) => ({ kind: 'success' as const, value }),
        }),
      );
      const trustedOperationTime =
        trustedTimeRead.kind === 'failure'
          ? Option.none<typeof PricingInstantSchema.Type>()
          : Schema.decodeOption(PricingInstantSchema)(trustedTimeRead.value);
      const { quotation } = scope;
      if (Option.isNone(trustedOperationTime)) {
        return {
          _tag: 'UNVERIFIABLE' as const,
          quotationRef: quotation.quotationRef,
          reason: 'TRUSTED_TIME_UNAVAILABLE' as const,
          retryable: true as const,
          validity: quotation.validity,
        };
      }

      const evaluatedAt = trustedOperationTime.value;
      if (evaluatedAt < quotation.validity.validFrom) {
        return {
          _tag: 'INVALID' as const,
          evaluatedAt,
          quotationRef: quotation.quotationRef,
          reason: 'NOT_YET_VALID' as const,
          validity: quotation.validity,
        };
      }
      if (evaluatedAt >= quotation.validity.validUntil) {
        return {
          _tag: 'EXPIRED' as const,
          evaluatedAt,
          quotationRef: quotation.quotationRef,
          validity: quotation.validity,
        };
      }
      return {
        _tag: 'VALID' as const,
        evaluatedAt,
        quotationRef: quotation.quotationRef,
        validity: quotation.validity,
      };
    }),
  } satisfies typeof PricingQuotationValidity.Service;
});
