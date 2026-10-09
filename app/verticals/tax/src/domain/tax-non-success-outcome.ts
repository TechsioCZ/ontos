import { Match, Schema } from 'effect';
import type {
  TaxDependencyUnavailable,
  TaxInputStale,
  TaxStateIndeterminate,
} from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';

export {
  TaxCaseUnsupportedSchema,
  TaxDependencyUnavailableSchema,
  TaxInputStaleSchema,
  TaxNonSuccessOutcomeSchema,
  TaxRuleConflictSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
  UnsupportedTaxRegimeSchema,
} from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';
export type {
  TaxCaseUnsupported,
  TaxNonSuccessOutcome,
  TaxRuleConflict,
  TaxRuleMissing,
  TaxRuleOverlap,
  TaxStateIndeterminate,
  TaxUnsupportedRequirement,
} from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';

/**
 * Why a required material input or fact cannot be established as Current: known stale, unavailable, or
 * unknown/unresolved/conflicting/unverifiable (#938 F13-F15, F20-F32).
 */
const TaxNotEstablishedStateSchema = Schema.Literals([
  'STALE',
  'UNAVAILABLE',
  'UNKNOWN',
  'UNRESOLVED',
  'CONFLICTING',
  'UNVERIFIABLE',
]);

export type TaxNotEstablishedState = typeof TaxNotEstablishedStateSchema.Type;

export type TaxNotEstablishedOutcome = TaxInputStale | TaxDependencyUnavailable | TaxStateIndeterminate;

/**
 * Typed non-success of a required input that cannot be established; it is never a known-negative, a zero or a
 * fallback (#938 F13-F15, F20-F32).
 */
export const taxNotEstablishedOutcome = (state: TaxNotEstablishedState): TaxNotEstablishedOutcome =>
  Match.value(state).pipe(
    Match.when('STALE', (): TaxNotEstablishedOutcome => ({ _tag: 'TAX_INPUT_STALE' })),
    Match.when('UNAVAILABLE', (): TaxNotEstablishedOutcome => ({ _tag: 'TAX_DEPENDENCY_UNAVAILABLE' })),
    Match.orElse((): TaxNotEstablishedOutcome => ({ _tag: 'TAX_STATE_INDETERMINATE' })),
  );
