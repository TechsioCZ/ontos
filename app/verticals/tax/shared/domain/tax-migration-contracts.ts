import { Schema } from 'effect';

const InstantSchema = Schema.DateTimeUtcFromString;
const ReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const References = Schema.Array(ReferenceSchema);

/** Canonical target meaning text of one fact: the governed Action content re-encoded in schema field order. */
export const TaxMigrationTargetMeaningKeySchema = Schema.String.pipe(Schema.brand('TaxMigrationTargetMeaningKey'));

/**
 * Only fixtures explicitly labelled NON_PRODUCTION are evaluated by the TAX migration contract: no real legacy data,
 * no cutover; P6 owns orchestration and production-scope evidence (#960 A, E, F32; #907 F271-F272).
 */
export const TaxMigrationDatasetLabelSchema = Schema.Literal('NON_PRODUCTION');

/** Launch-critical Tax-owned fact/rule families with an explicit semantic mapping (#960 F2, F4, F8). */
export const TaxMigrationFamilySchema = Schema.Literals(['TAX_RULE', 'SELLER_VAT_REGIME_DECLARATION']);
export type TaxMigrationFamily = typeof TaxMigrationFamilySchema.Type;

/** The real source, dataset and record context of one legacy record; never derived (#960 F11). */
export const TaxMigrationProvenanceSchema = Schema.Struct({
  datasetLabel: TaxMigrationDatasetLabelSchema,
  datasetRef: ReferenceSchema,
  sourceRecordRef: ReferenceSchema,
  sourceSystemRef: ReferenceSchema,
});
export type TaxMigrationProvenance = typeof TaxMigrationProvenanceSchema.Type;

/** Identity of one source record: the same record ref in two source systems is two records (#960 F11). */
export const TaxMigrationSourceRecordSchema = Schema.Struct({
  sourceRecordRef: ReferenceSchema,
  sourceSystemRef: ReferenceSchema,
});
export type TaxMigrationSourceRecord = typeof TaxMigrationSourceRecordSchema.Type;
const SourceRecords = Schema.Array(TaxMigrationSourceRecordSchema);

/**
 * The semantic mapping of one legacy record. A legacy field or table name never decides meaning (#960 F1, F13): the
 * mapping states the target owner and, for a Tax-owned record, the canonical target meaning in the exact shape of
 * the governed TAX Action that creates it. `UNESTABLISHED` keeps a record whose meaning or authority cannot be
 * established (F34); Historical Accepted Order/Billing values stay with their historical owner (F7, F10, F12).
 */
export const TaxMigrationMappingSchema = Schema.Union([
  Schema.TaggedStruct('FOREIGN_OWNER', { targetOwner: ReferenceSchema }),
  Schema.TaggedStruct('HISTORICAL_ACCEPTED_VALUE', { historicalOwner: ReferenceSchema }),
  Schema.TaggedStruct('TAX_OWNED', {
    family: TaxMigrationFamilySchema,
    targetMeaning: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.TaggedStruct('UNESTABLISHED', { legacyFieldNames: References }),
]);
export type TaxMigrationMapping = typeof TaxMigrationMappingSchema.Type;

export const TaxMigrationCandidateSchema = Schema.Struct({
  mapping: TaxMigrationMappingSchema,
  provenance: TaxMigrationProvenanceSchema,
});
export type TaxMigrationCandidate = typeof TaxMigrationCandidateSchema.Type;

/** Family a Tax-owned source record was mapped to; None for records owned elsewhere or of unknown meaning. */
const SourceFamilySchema = Schema.OptionFromNullOr(TaxMigrationFamilySchema);

export const TaxMigrationMappedAcceptedSchema = Schema.TaggedStruct('MAPPED_ACCEPTED', {
  family: TaxMigrationFamilySchema,
  provenance: TaxMigrationProvenanceSchema,
  targetMeaningKey: TaxMigrationTargetMeaningKeySchema,
});
export const TaxMigrationRejectedUnmappedSchema = Schema.TaggedStruct('REJECTED_UNMAPPED', {
  provenance: TaxMigrationProvenanceSchema,
  reason: Schema.Literals([
    'DUPLICATE_SOURCE_RECORD',
    'FOREIGN_OWNER',
    'HISTORICAL_ACCEPTED_VALUE',
    'UNSUPPORTED_BREADTH',
  ]),
  sourceFamily: SourceFamilySchema,
  targetOwner: ReferenceSchema,
});
export const TaxMigrationConflictingSchema = Schema.TaggedStruct('CONFLICTING', {
  counterparts: Schema.Array(TaxMigrationProvenanceSchema),
  provenance: TaxMigrationProvenanceSchema,
  sourceFamily: SourceFamilySchema,
});
export const TaxMigrationIncompleteSchema = Schema.TaggedStruct('INCOMPLETE', {
  missing: Schema.Array(Schema.String),
  provenance: TaxMigrationProvenanceSchema,
  sourceFamily: SourceFamilySchema,
});
export const TaxMigrationReviewRequiredSchema = Schema.TaggedStruct('REVIEW_REQUIRED', {
  provenance: TaxMigrationProvenanceSchema,
  reason: Schema.Literals(['MEANING_NOT_ESTABLISHED', 'PROVENANCE_MISMATCH', 'TARGET_MEANING_INVALID']),
  sourceFamily: SourceFamilySchema,
});

/** Exactly the five reconciliation outcomes of #960 F16. */
export const TaxMigrationOutcomeSchema = Schema.Union([
  TaxMigrationMappedAcceptedSchema,
  TaxMigrationRejectedUnmappedSchema,
  TaxMigrationConflictingSchema,
  TaxMigrationIncompleteSchema,
  TaxMigrationReviewRequiredSchema,
]);
export type TaxMigrationOutcome = typeof TaxMigrationOutcomeSchema.Type;

/**
 * Owner-declared complete source set for one family: the business claim that makes completeness verifiable
 * (#960 F17). Without it completeness is UNVERIFIABLE, never assumed from the rows that happened to arrive.
 */
export const TaxMigrationCompletenessClaimSchema = Schema.Struct({
  declaredBy: ReferenceSchema,
  expectedSourceRecords: SourceRecords,
  family: TaxMigrationFamilySchema,
});
export type TaxMigrationCompletenessClaim = typeof TaxMigrationCompletenessClaimSchema.Type;

export const TaxMigrationCompleteSchema = Schema.TaggedStruct('COMPLETE', {
  family: TaxMigrationFamilySchema,
  rowCount: Schema.Finite,
});
export const TaxMigrationNotCompleteSchema = Schema.TaggedStruct('NOT_COMPLETE', {
  family: TaxMigrationFamilySchema,
  missingSourceRecords: SourceRecords,
  openSourceRecords: SourceRecords,
  rowCount: Schema.Finite,
  unexpectedSourceRecords: SourceRecords,
});
export const TaxMigrationUnverifiableSchema = Schema.TaggedStruct('UNVERIFIABLE', {
  family: TaxMigrationFamilySchema,
  rowCount: Schema.Finite,
});
/** Row counts are informational only and never decide completeness (#960 F14). */
export const TaxMigrationCompletenessSchema = Schema.Union([
  TaxMigrationCompleteSchema,
  TaxMigrationNotCompleteSchema,
  TaxMigrationUnverifiableSchema,
]);
export type TaxMigrationCompleteness = typeof TaxMigrationCompletenessSchema.Type;

/** Canonical meaning the TAX target holds for a migrated source record, read through TAX's own contracts. */
export const TaxMigrationTargetFactSchema = Schema.Struct({
  source: TaxMigrationSourceRecordSchema,
  targetMeaningKey: TaxMigrationTargetMeaningKeySchema,
});
export type TaxMigrationTargetFact = typeof TaxMigrationTargetFactSchema.Type;

export const TaxMigrationTargetDifferenceSchema = Schema.Struct({
  difference: Schema.Literals(['MEANING_DIFFERS', 'MISSING_IN_TARGET', 'TARGET_CONFLICT', 'UNEXPECTED_IN_TARGET']),
  source: TaxMigrationSourceRecordSchema,
});
export type TaxMigrationTargetDifference = typeof TaxMigrationTargetDifferenceSchema.Type;

/**
 * One explicit cutover instant per Selling Legal Entity and family (#907 Unit 10 D2, F18): step 9's authority
 * handoff is retired in favor of the Seller VAT Regime Declaration timeline, which has no System-of-Record
 * authority boundary to negotiate. `CUTOVER_DECLARED` is P6's own declaration that legacy writes have stopped
 * for this family and seller; it is never inferred from TAX's own data.
 */
export const TaxMigrationCutoverDeclaredSchema = Schema.TaggedStruct('CUTOVER_DECLARED', { at: InstantSchema });
export const TaxMigrationCutoverNotDeclaredSchema = Schema.TaggedStruct('CUTOVER_NOT_DECLARED', {});
export const TaxMigrationCutoverSchema = Schema.Union([
  TaxMigrationCutoverDeclaredSchema,
  TaxMigrationCutoverNotDeclaredSchema,
]);
export type TaxMigrationCutover = typeof TaxMigrationCutoverSchema.Type;

export const TaxShadowSameSchema = Schema.TaggedStruct('SAME', { probeRef: ReferenceSchema });
export const TaxShadowDifferentSchema = Schema.TaggedStruct('DIFFERENT', {
  legacyValue: Schema.String,
  ontosValue: Schema.String,
  probeRef: ReferenceSchema,
});
export const TaxShadowNotComparableSchema = Schema.TaggedStruct('NOT_COMPARABLE', {
  probeRef: ReferenceSchema,
  reason: Schema.String,
});
/** Shadow differences are Reconciliation evidence only; the shadow side is never authority (#960 F19-F20). */
export const TaxShadowDifferenceSchema = Schema.Union([
  TaxShadowSameSchema,
  TaxShadowDifferentSchema,
  TaxShadowNotComparableSchema,
]);
export type TaxShadowDifference = typeof TaxShadowDifferenceSchema.Type;

export const TaxMigrationFamilyEvidenceSchema = Schema.Struct({
  completeness: TaxMigrationCompletenessSchema,
  cutover: TaxMigrationCutoverSchema,
  family: TaxMigrationFamilySchema,
  outcomes: Schema.Array(TaxMigrationOutcomeSchema),
  shadowDifferences: Schema.Array(TaxShadowDifferenceSchema),
  targetDifferences: Schema.Array(TaxMigrationTargetDifferenceSchema),
});
export type TaxMigrationFamilyEvidence = typeof TaxMigrationFamilyEvidenceSchema.Type;

export const TaxMigrationReadinessBlockerSchema = Schema.Struct({
  blocker: Schema.Literals([
    'COMPLETENESS_NOT_VERIFIED',
    'CUTOVER_NOT_DECLARED',
    'OPEN_OUTCOME',
    'SHADOW_DIFFERENCE',
    'TARGET_MEANING_DIFFERENCE',
  ]),
  family: TaxMigrationFamilySchema,
});
export type TaxMigrationReadinessBlocker = typeof TaxMigrationReadinessBlockerSchema.Type;

export const TaxMigrationReadySchema = Schema.TaggedStruct('READY', {});
export const TaxMigrationNotReadySchema = Schema.TaggedStruct('NOT_READY', {
  blockers: Schema.Array(TaxMigrationReadinessBlockerSchema),
});

/**
 * TAX readiness evidence handed to P6. It is Tax-specific only and never claims the global cutover complete
 * (#960 F32); the dataset is NON_PRODUCTION by construction.
 */
/** The exact fact scope of the evidence: authority stays per fact family and Selling Legal Entity (#960 C, F21). */
export const TaxMigrationScopeSchema = Schema.Struct({
  sellingLegalEntityRef: ReferenceSchema,
  tenantRef: ReferenceSchema,
});
export type TaxMigrationScope = typeof TaxMigrationScopeSchema.Type;

export const TaxMigrationReadinessEvidenceSchema = Schema.Struct({
  datasetLabel: TaxMigrationDatasetLabelSchema,
  families: Schema.Array(TaxMigrationFamilyEvidenceSchema),
  globalCutoverClaim: Schema.Literal('NONE'),
  scope: TaxMigrationScopeSchema,
  verdict: Schema.Union([TaxMigrationReadySchema, TaxMigrationNotReadySchema]),
});
export type TaxMigrationReadinessEvidence = typeof TaxMigrationReadinessEvidenceSchema.Type;
