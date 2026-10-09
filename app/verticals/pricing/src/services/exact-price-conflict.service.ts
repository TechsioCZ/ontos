import type {
  ExactPriceConflictDiagnostic,
  ExactPriceLookupRequest,
  ExactPriceLookupResult,
  ExactPriceOwnerLookupResult,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import {
  ExactPriceConflictDiagnosticSchema,
  ExactPriceLookupRequestSchema,
  ExactPriceLookupResultSchema,
  redactExactPriceConflictDiagnostic,
} from '@app/pricing-contracts/domain/exact-price-lookup';
import { Option, Schema } from 'effect';

export interface ExactPriceConflictClassification {
  readonly lookup: ExactPriceLookupResult;
  readonly ownerDiagnostic?: ExactPriceConflictDiagnostic;
}

export interface ExactPriceConflictRuntime {
  readonly classify: (
    request: ExactPriceLookupRequest,
    result: ExactPriceOwnerLookupResult | ExactPriceLookupResult,
  ) => ExactPriceConflictClassification;
}

const exactRequestEquivalence = Schema.toEquivalence(ExactPriceLookupRequestSchema);

export const classifyExactPriceOwnerLookup = (
  request: ExactPriceLookupRequest,
  result: ExactPriceOwnerLookupResult | ExactPriceLookupResult,
): ExactPriceConflictClassification => {
  if (Schema.is(ExactPriceConflictDiagnosticSchema)(result)) {
    return exactRequestEquivalence(result.request, request)
      ? {
          lookup: redactExactPriceConflictDiagnostic(result),
          ownerDiagnostic: result,
        }
      : {
          lookup: { _tag: 'UNVERIFIABLE', reason: 'EXACT_KEY_BINDING_UNVERIFIABLE', request },
        };
  }
  const decoded = Schema.decodeOption(ExactPriceLookupResultSchema, { onExcessProperty: 'error' })(result);
  return Option.isSome(decoded)
    ? { lookup: decoded.value }
    : { lookup: { _tag: 'UNVERIFIABLE', reason: 'SET_COMPLETENESS_UNVERIFIABLE', request } };
};

/**
 * Owner-local collision boundary. Authorized claimant evidence stays available to owner diagnostics,
 * while the exact-price resolver receives only the deliberately redacted lookup projection.
 */
export const makeExactPriceConflictRuntime = (): ExactPriceConflictRuntime => ({
  classify: classifyExactPriceOwnerLookup,
});
