import {
  PricingQuotationExpiredSchema,
  PricingQuotationInvalidSchema,
  PricingQuotationValidityUnverifiableSchema,
} from '@app/pricing-contracts/domain/quotation';
import type {
  PricingQuotationBindingRevalidationAssessment,
  PricingQuotationRevalidationOutcome,
  PricingQuotationRevalidationRequest,
  PricingQuotationReuseBindingProof,
} from '@app/pricing-contracts/domain/quotation';
import { Context, Effect, Schema } from 'effect';

import type { PricingQuotationAuthenticityService } from './quotation-authenticity.service.ts';
import type { PricingQuotationBindingRevalidationService } from './quotation-binding-revalidation.service.ts';
import type { PricingQuotationValidityService } from './quotation-validity.service.ts';

interface PricingQuotationRevalidationContract {
  readonly revalidate: (
    request: PricingQuotationRevalidationRequest,
  ) => Effect.Effect<PricingQuotationRevalidationOutcome>;
}

class PricingQuotationRevalidation extends Context.Service<
  PricingQuotationRevalidation,
  PricingQuotationRevalidationContract
>()('@app/pricing/services/quotation-revalidation.service/PricingQuotationRevalidation') {}

export type PricingQuotationRevalidationService = typeof PricingQuotationRevalidation.Service;

interface PricingQuotationRevalidationDependencies {
  readonly authenticity: PricingQuotationAuthenticityService;
  readonly binding: PricingQuotationBindingRevalidationService;
  readonly validity: PricingQuotationValidityService;
}

const bindingUnverifiable = (
  quotationRef: string,
): Extract<PricingQuotationRevalidationOutcome, { readonly kind: 'BINDING_UNVERIFIABLE' }> => ({
  kind: 'BINDING_UNVERIFIABLE',
  quotationRef,
  reason: 'BINDING_DEPENDENCY_UNAVAILABLE',
  retryable: true,
});

const reuseBindingProof = (
  assessment: Extract<
    PricingQuotationBindingRevalidationAssessment,
    { readonly kind: 'EXACT_MATCH' | 'OWNER_REVALIDATION_ACCEPTED' }
  >,
): PricingQuotationReuseBindingProof =>
  assessment.kind === 'EXACT_MATCH'
    ? { kind: 'DIRECT_EXACT_MATCH' }
    : {
        kind: 'OWNER_CONFIRMED_NON_MATERIAL_TRANSITION',
        transitionEvidence: assessment.transitionEvidence,
      };

/**
 * Revalidates one immutable Pricing Quotation without consulting ordinary Current pricing. Every
 * successful path proves authenticity, trusted half-open validity, and exact or owner-confirmed
 * binding while returning the original quotation instance and its original pre-Tax terms.
 */
export const makePricingQuotationRevalidationService = (
  dependencies: PricingQuotationRevalidationDependencies,
): PricingQuotationRevalidationService => ({
  revalidate: Effect.fn('PricingQuotationRevalidation.revalidate')(function* revalidatePricingQuotation(
    request: PricingQuotationRevalidationRequest,
  ) {
    const authenticity = yield* dependencies.authenticity.verify({ quotation: request.quotation });
    if (authenticity.kind === 'QUOTATION_AUTHENTICITY_INVALID') {
      return {
        kind: 'AUTHENTICITY_INVALID' as const,
        quotationRef: request.quotation.quotationRef,
        reason: authenticity.reason,
        retryable: false as const,
      };
    }
    if (authenticity.kind === 'QUOTATION_AUTHENTICITY_UNVERIFIABLE') {
      return {
        kind: 'AUTHENTICITY_UNVERIFIABLE' as const,
        quotationRef: request.quotation.quotationRef,
        reason: authenticity.reason,
        retryable: authenticity.retryable,
      };
    }

    // #784 also performs scope verification. Passing the immutable issued binding deliberately
    // limits this call to trusted time/validity; the requested binding is independently assessed
    // below and can proceed only through exact equality or owner-confirmed non-material evidence.
    const validity = yield* dependencies.validity.verify({
      quotation: request.quotation,
      requestedBinding: request.quotation.binding,
    });
    if ('kind' in validity) {
      return bindingUnverifiable(request.quotation.quotationRef);
    }
    if (Schema.is(PricingQuotationExpiredSchema)(validity)) {
      return {
        evaluatedAt: validity.evaluatedAt,
        kind: 'EXPIRED' as const,
        quotationRef: validity.quotationRef,
        validity: validity.validity,
      };
    }
    if (Schema.is(PricingQuotationInvalidSchema)(validity)) {
      return {
        evaluatedAt: validity.evaluatedAt,
        kind: 'NOT_YET_VALID' as const,
        quotationRef: validity.quotationRef,
        validity: validity.validity,
      };
    }
    if (Schema.is(PricingQuotationValidityUnverifiableSchema)(validity)) {
      return {
        kind: 'VALIDITY_UNVERIFIABLE' as const,
        quotationRef: validity.quotationRef,
        reason: validity.reason,
        retryable: true as const,
      };
    }

    const binding = yield* dependencies.binding.assess(request);
    if (binding.kind === 'BINDING_UNVERIFIABLE') {
      return binding;
    }
    if (binding.kind === 'MISMATCH') {
      return {
        kind: 'NEW_QUOTATION_REQUIRED' as const,
        mismatchReason: binding.reason,
        quotationRef: binding.quotationRef,
        retryable: false as const,
      };
    }
    if (binding.kind === 'OWNER_REVALIDATION_REQUIRED') {
      return bindingUnverifiable(request.quotation.quotationRef);
    }

    return {
      authenticityEvidence: authenticity.evidence,
      bindingProof: reuseBindingProof(binding),
      evaluatedAt: validity.evaluatedAt,
      kind: 'EXACT_REUSE' as const,
      quotation: request.quotation,
      termsAuthority: 'ORIGINAL_QUOTATION' as const,
    };
  }),
});
