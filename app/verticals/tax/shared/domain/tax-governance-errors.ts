import { Schema } from 'effect';

const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const AuditResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('TaxGovernanceAuditResourceId'),
  Schema.decodeTo(Schema.String),
);

/**
 * Why a governed TAX mutation was rejected without changing canonical state (#949 F20, #955).
 * `MEANING_CHANGED`: a revision would silently reinterpret the stable Tax Rule meaning (#929 F1-F3).
 * `SUBMISSION_INTENT_CHANGED`: a final Order Tax already exists for the submission with another frozen intent
 * (#944 F11).
 */
export const TaxGovernanceConflictKindSchema = Schema.Literals([
  'IDEMPOTENCY_REUSED',
  'STABLE_CODE',
  'STALE_BASIS',
  'LIFECYCLE',
  'MEANING_CHANGED',
  'AUTHORITY_CONFLICT',
  'SUBMISSION_INTENT_CHANGED',
]);
export type TaxGovernanceConflictKind = typeof TaxGovernanceConflictKindSchema.Type;

const PersistenceUnavailableFields = {
  code: Schema.Literal('tax_governance_persistence_unavailable'),
  reason,
};
const PersistenceUnavailableSchema = Schema.TaggedStruct(
  'TaxGovernancePersistenceUnavailable',
  PersistenceUnavailableFields,
);
export const TaxGovernancePersistenceUnavailable = Schema.TaggedError<typeof PersistenceUnavailableSchema.Type>()(
  'TaxGovernancePersistenceUnavailable',
  PersistenceUnavailableFields,
);

const NotFoundFields = {
  code: Schema.Literal('tax_governance_not_found'),
  reason,
};
const NotFoundSchema = Schema.TaggedStruct('TaxGovernanceNotFound', NotFoundFields);
export const TaxGovernanceNotFound = Schema.TaggedError<typeof NotFoundSchema.Type>()(
  'TaxGovernanceNotFound',
  NotFoundFields,
);

const ConflictFields = {
  code: Schema.Literal('tax_governance_conflict'),
  conflict: TaxGovernanceConflictKindSchema,
  reason,
};
const ConflictSchema = Schema.TaggedStruct('TaxGovernanceConflict', ConflictFields);
export const TaxGovernanceConflict = Schema.TaggedError<typeof ConflictSchema.Type>()(
  'TaxGovernanceConflict',
  ConflictFields,
);

const StaleBasisFields = {
  code: Schema.Literal('tax_governance_stale_basis'),
  reason,
};
const StaleBasisSchema = Schema.TaggedStruct('TaxGovernanceStaleBasis', StaleBasisFields);
export const TaxGovernanceStaleBasis = Schema.TaggedError<typeof StaleBasisSchema.Type>()(
  'TaxGovernanceStaleBasis',
  StaleBasisFields,
);

/**
 * Safe business audit evidence; never credentials, tokens or raw provider payload (#950 F49-F54). It names the
 * business reason, the expected-current evidence the Action was guarded by, and the resulting revision or lifecycle
 * fact identity (#950 F45-F47).
 */
export const TaxGovernanceAuditEvidenceSchema = Schema.Struct({
  action: Schema.String.check(Schema.isMinLength(1)),
  changed: Schema.Boolean,
  expectedBasisFingerprint: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  meaningFingerprint: Schema.String.check(Schema.isMinLength(1)),
  operation: Schema.String.check(Schema.isMinLength(1)),
  reason,
  resourceId: AuditResourceIdSchema,
  resourceType: Schema.String.check(Schema.isMinLength(1)),
  /** Source conflict recorded by the same invocation, if any (#958 F11, #959 F6, F10, F28). */
  resultingConflictId: Schema.optionalKey(AuditResourceIdSchema),
  resultingEndFactId: Schema.optionalKey(AuditResourceIdSchema),
  resultingRevisionId: Schema.optionalKey(AuditResourceIdSchema),
});
