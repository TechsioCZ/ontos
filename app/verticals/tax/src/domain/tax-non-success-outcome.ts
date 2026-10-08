import { Match, Schema } from 'effect';

const unsupportedTaxRegimes = [
  'OSS',
  'REVERSE_CHARGE',
  'EXPORT',
  'INTRA_EU_SPECIAL_REGIME',
  'FOREIGN_VAT_REGIME',
] as const;

/** Special or international regimes outside Launch Tax Coverage (#918 F17-F21, #907 F9-F12). */
export const UnsupportedTaxRegimeSchema = Schema.Literals(unsupportedTaxRegimes);

/** Exact Launch requirement outside activated Launch Tax Coverage (#918 F17-F23, F31-F39; #939 F29). */
export const TaxUnsupportedRequirementSchema = Schema.Literals([
  'NON_CZK_CURRENCY',
  ...unsupportedTaxRegimes,
  'NON_CZECH_DOMESTIC_TAX_PLACE',
  'ZERO_RATE_TREATMENT',
  'EXEMPTION_TREATMENT',
  'NOT_APPLICABLE_TREATMENT',
  'SET_MULTI_SUPPLY_DECOMPOSITION',
]);
export type TaxUnsupportedRequirement = typeof TaxUnsupportedRequirementSchema.Type;

/** Exact tax scenario is not part of activated Launch scope (#938 F3-F6). */
export const TaxCaseUnsupportedSchema = Schema.TaggedStruct('TAX_CASE_UNSUPPORTED', {
  unsupportedRequirement: TaxUnsupportedRequirementSchema,
});
export type TaxCaseUnsupported = typeof TaxCaseUnsupportedSchema.Type;

/** Known-negative required Launch prerequisite of an otherwise supported case (#938 F7-F12, #918 F13-F16). */
export const TaxPrerequisiteNotMetSchema = Schema.TaggedStruct('TAX_PREREQUISITE_NOT_MET', {
  unmetPrerequisite: Schema.Literal('SELLING_LEGAL_ENTITY_CURRENT_CZ_VAT_REGISTRATION'),
});
export type TaxPrerequisiteNotMet = typeof TaxPrerequisiteNotMetSchema.Type;

/** Supported case with a complete authoritative empty applicable rule set (#938 F16). */
export const TaxRuleMissingSchema = Schema.TaggedStruct('TAX_RULE_MISSING', {});
export type TaxRuleMissing = typeof TaxRuleMissingSchema.Type;
/** Illegal overlap of applicable rule revisions (#938 F17). */
export const TaxRuleOverlapSchema = Schema.TaggedStruct('TAX_RULE_OVERLAP', {});
export type TaxRuleOverlap = typeof TaxRuleOverlapSchema.Type;
/** Incompatible applicable rule meanings without explicit composition (#938 F18). */
export const TaxRuleConflictSchema = Schema.TaggedStruct('TAX_RULE_CONFLICT', {});
export type TaxRuleConflict = typeof TaxRuleConflictSchema.Type;
/** Required material evidence is known outside its usable Current validity (#938 F20-F21). */
export const TaxInputStaleSchema = Schema.TaggedStruct('TAX_INPUT_STALE', {});
export type TaxInputStale = typeof TaxInputStaleSchema.Type;
/** Required authority/dependency cannot safely be used (#938 F22-F26). */
export const TaxDependencyUnavailableSchema = Schema.TaggedStruct('TAX_DEPENDENCY_UNAVAILABLE', {});
export type TaxDependencyUnavailable = typeof TaxDependencyUnavailableSchema.Type;
/** Complete authoritative truth cannot safely be concluded (#938 F27-F32). */
export const TaxStateIndeterminateSchema = Schema.TaggedStruct('TAX_STATE_INDETERMINATE', {});
export type TaxStateIndeterminate = typeof TaxStateIndeterminateSchema.Type;

/**
 * Closed set of typed non-success Tax Outcomes; none of them carries a Tax amount (#938 F2, #939 F14-F25). Each
 * distinct code lets the consumer tell which remedy applies (#938 F33-F39, H).
 */
export const TaxNonSuccessOutcomeSchema = Schema.Union([
  TaxCaseUnsupportedSchema,
  TaxPrerequisiteNotMetSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxRuleConflictSchema,
  TaxInputStaleSchema,
  TaxDependencyUnavailableSchema,
  TaxStateIndeterminateSchema,
]);
export type TaxNonSuccessOutcome = typeof TaxNonSuccessOutcomeSchema.Type;

/**
 * Why a required material input or fact cannot be established as Current: known stale, unavailable, or
 * unknown/unresolved/conflicting/unverifiable (#938 F13-F15, F20-F32).
 */
export const TaxNotEstablishedStateSchema = Schema.Literals([
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
