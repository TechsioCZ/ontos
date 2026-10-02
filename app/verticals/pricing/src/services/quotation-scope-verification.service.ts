import {
  PricingQuotationAuthorityBindingSchema,
  PricingQuotationBindingSchema,
  PricingQuotationIssuedSchema,
  PricingQuotationLineBindingSchema,
} from '@app/pricing-contracts/domain/quotation';
import type { PricingQuotationBinding, PricingQuotationIssued } from '@app/pricing-contracts/domain/quotation';
import { PricingCommercialScopeSchema } from '@app/pricing-contracts/domain/pricing-commercial-scope';
import { PricingCatalogSelectionSchema, PricingQuantitySchema } from '@app/pricing-contracts/pricing-decision';
import { Context, Effect, Option, Schema } from 'effect';

export interface PricingQuotationScopeVerificationRequest {
  readonly quotation: PricingQuotationIssued;
  readonly requestedBinding: PricingQuotationBinding;
}

export const PricingQuotationScopeMismatchReasonSchema = Schema.Literals([
  'AUTHORITY_MISMATCH',
  'CANDIDATE_MISMATCH',
  'COMMERCIAL_SCOPE_MISMATCH',
  'CURRENCY_MISMATCH',
  'MONETARY_BOUNDARY_MISMATCH',
  'OCCURRENCE_STRUCTURE_MISMATCH',
  'QUANTITY_MISMATCH',
  'SELECTION_MISMATCH',
  'TENANT_MISMATCH',
]);
export type PricingQuotationScopeMismatchReason = typeof PricingQuotationScopeMismatchReasonSchema.Type;

export const PricingQuotationScopeUnverifiableReasonSchema = Schema.Literals([
  'INVALID_QUOTATION',
  'INVALID_REQUESTED_BINDING',
]);
export type PricingQuotationScopeUnverifiableReason = typeof PricingQuotationScopeUnverifiableReasonSchema.Type;

export type PricingQuotationScopeVerificationOutcome =
  | {
      readonly binding: PricingQuotationBinding;
      readonly kind: 'QUOTATION_SCOPE_APPLICABLE';
      readonly quotation: PricingQuotationIssued;
    }
  | {
      readonly kind: 'QUOTATION_SCOPE_MISMATCH';
      readonly reason: PricingQuotationScopeMismatchReason;
    }
  | {
      readonly kind: 'QUOTATION_SCOPE_UNVERIFIABLE';
      readonly reason: PricingQuotationScopeUnverifiableReason;
    };

export interface PricingQuotationScopeVerificationService {
  /**
   * Compares one issued immutable binding with one requested backend purchase binding. This is
   * deliberately not an access-control, validity, Tax, Storefront, or evidence-transition gate.
   */
  readonly verify: (
    request: PricingQuotationScopeVerificationRequest,
  ) => Effect.Effect<PricingQuotationScopeVerificationOutcome>;
}

export class PricingQuotationScopeVerification extends Context.Service<
  PricingQuotationScopeVerification,
  PricingQuotationScopeVerificationService
>()('@app/pricing/services/quotation-scope-verification.service/PricingQuotationScopeVerification') {}

const sameAuthority = Schema.toEquivalence(PricingQuotationAuthorityBindingSchema);
const sameCommercialScope = Schema.toEquivalence(PricingCommercialScopeSchema);
const sameLine = Schema.toEquivalence(PricingQuotationLineBindingSchema);
const sameQuantity = Schema.toEquivalence(PricingQuantitySchema);
const sameSelection = Schema.toEquivalence(PricingCatalogSelectionSchema);

const mismatched = (reason: PricingQuotationScopeMismatchReason): PricingQuotationScopeVerificationOutcome => ({
  kind: 'QUOTATION_SCOPE_MISMATCH',
  reason,
});

const scopeMismatch = (
  issued: PricingQuotationBinding,
  requested: PricingQuotationBinding,
): PricingQuotationScopeMismatchReason | undefined => {
  if (issued.candidateRef !== requested.candidateRef) {
    return 'CANDIDATE_MISMATCH';
  }
  if (issued.tenantId !== requested.tenantId) {
    return 'TENANT_MISMATCH';
  }
  if (!sameCommercialScope(issued.commercialScope, requested.commercialScope)) {
    return 'COMMERCIAL_SCOPE_MISMATCH';
  }
  if (issued.currencyCode !== requested.currencyCode) {
    return 'CURRENCY_MISMATCH';
  }
  if (issued.monetaryBoundary !== requested.monetaryBoundary) {
    return 'MONETARY_BOUNDARY_MISMATCH';
  }
  if (!sameAuthority(issued.subject, requested.subject)) {
    return 'AUTHORITY_MISMATCH';
  }
  if (
    issued.lines.length !== requested.lines.length ||
    issued.lines.some((line, index) => line.occurrenceId !== requested.lines[index]?.occurrenceId)
  ) {
    return 'OCCURRENCE_STRUCTURE_MISMATCH';
  }
  for (let index = 0; index < issued.lines.length; index += 1) {
    const issuedLine = issued.lines[index];
    const requestedLine = requested.lines[index];
    if (issuedLine === undefined || requestedLine === undefined) {
      return 'OCCURRENCE_STRUCTURE_MISMATCH';
    }
    if (!sameSelection(issuedLine.selection, requestedLine.selection)) {
      return 'SELECTION_MISMATCH';
    }
    if (!sameQuantity(issuedLine.quantity, requestedLine.quantity)) {
      return 'QUANTITY_MISMATCH';
    }
    if (!sameLine(issuedLine, requestedLine)) {
      return 'OCCURRENCE_STRUCTURE_MISMATCH';
    }
  }
  return undefined;
};

/**
 * Exact immutable quotation-scope verification. Equality is structural over the canonical owner
 * contract, so equal amounts, reusable source identifiers, or presentation origin cannot stand in
 * for the original occurrence partition, Catalog meaning, quantity, commercial scope, or actor.
 */
export const makePricingQuotationScopeVerificationService = (): PricingQuotationScopeVerificationService => ({
  verify: Effect.fn('PricingQuotationScopeVerification.verify')((input) =>
    Effect.sync(() => {
      const quotationOption = Schema.decodeOption(PricingQuotationIssuedSchema)(input.quotation);
      if (Option.isNone(quotationOption)) {
        return {
          kind: 'QUOTATION_SCOPE_UNVERIFIABLE' as const,
          reason: 'INVALID_QUOTATION' as const,
        };
      }

      // Default schema decoding discards non-Pricing presentation and Tax properties. They are not
      // monetary selectors, while the canonical binding itself remains exact and closed by shape.
      const requestedBindingOption = Schema.decodeOption(PricingQuotationBindingSchema)(input.requestedBinding);
      if (Option.isNone(requestedBindingOption)) {
        return {
          kind: 'QUOTATION_SCOPE_UNVERIFIABLE' as const,
          reason: 'INVALID_REQUESTED_BINDING' as const,
        };
      }

      const quotation = quotationOption.value;
      const requestedBinding = requestedBindingOption.value;
      const mismatch = scopeMismatch(quotation.binding, requestedBinding);
      if (mismatch !== undefined) {
        return mismatched(mismatch);
      }

      return {
        binding: quotation.binding,
        kind: 'QUOTATION_SCOPE_APPLICABLE' as const,
        quotation,
      };
    }),
  ),
});
