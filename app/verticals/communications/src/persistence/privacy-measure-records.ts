import { Schema } from 'effect';

/**
 * The documents the Privacy Measure routines answer with (migration `enforce-privacy-measure-evidence`). The owner decodes
 * each with its own Schema at the call site and never trusts a routine row as typed.
 */
const InvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CommunicationsConfirmationInvocationId'),
);
const Sha256HexSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const StoredEvidenceSchema = Schema.Struct({
  confirmationInvocationId: InvocationIdSchema,
  evidenceRef: Schema.String,
  phase: Schema.Literals(['COMPLETED', 'IN_PROGRESS', 'RECEIVED']),
  recordedAt: Schema.DateTimeUtcFromString,
  results: Schema.Array(
    Schema.Struct({
      contentRef: Schema.String,
      reconcilesEvidenceRef: Schema.optionalKey(Schema.String),
      result: Schema.Literals([
        'ANONYMIZED',
        'FAILED_AFTER_POSSIBLE_MUTATION',
        'FAILED_BEFORE_ANY_MUTATION',
        'NOT_EXECUTED',
        'RECTIFIED',
        'REMOVED',
        'RESTRICTED',
      ]),
    }),
  ),
  scopeDigest: Sha256HexSchema,
});

export const StoredHandoffSchema = Schema.Struct({
  handoffFingerprint: Sha256HexSchema,
  measureId: Schema.NonEmptyString.pipe(Schema.brand('CommunicationsPrivacyMeasureId')),
  /** The Core-verified Privacy dispatch invocation the handoff was delivered under (a correlation id). */
  originatorInvocationId: Schema.String.check(Schema.isUUID()).pipe(
    Schema.brand('CommunicationsPrivacyDispatchInvocationId'),
  ),
  receivedAt: Schema.DateTimeUtcFromString,
  scopeDigest: Sha256HexSchema,
  sourceDecisionRef: Schema.String,
  sourceDecisionRevision: Schema.Int,
  targetContentRefs: Schema.Array(Schema.String),
  taskId: Schema.NonEmptyString.pipe(Schema.brand('CommunicationsPrivacyTaskId')),
});

export const HandoffDocumentSchema = Schema.Struct({
  evidence: Schema.Array(StoredEvidenceSchema),
  record: Schema.OptionFromNullOr(StoredHandoffSchema),
});

export const RecordHandoffAnswerSchema = Schema.Struct({
  outcome: Schema.Literals(['CONFLICT', 'EXISTS', 'RECORDED']),
  record: StoredHandoffSchema,
});

export const RecordEvidenceAnswerSchema = Schema.Struct({
  evidence: Schema.optionalKey(StoredEvidenceSchema),
  outcome: Schema.Literals(['CONFLICT', 'EXISTS', 'NO_HANDOFF', 'RECORDED', 'SCOPE_MISMATCH', 'TARGET_MISMATCH']),
});
