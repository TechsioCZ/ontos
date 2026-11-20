import { Schema } from 'effect';

/**
 * Why an authorized human's confirmation cannot be recorded as evidence. A refusal is typed and final for that confirmation:
 * the Action only RECORDS what a human confirmed about an owner Action performed separately, it never performs anything.
 */
export const OwnerExecutionEvidenceRefusalSchema = Schema.Literals([
  'EVIDENCE_REF_ALREADY_RECORDED_WITH_OTHER_CONTENT',
  'HANDOFF_FINGERPRINT_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
  'NO_HANDOFF_RECORDED_FOR_THIS_MEASURE',
  'RESULT_NAMES_CONTENT_OUTSIDE_THE_APPROVED_TARGETS',
  'SCOPE_DOES_NOT_MATCH_THE_RECORDED_HANDOFF',
]);

const rejectedFields = {
  code: Schema.Literal('owner_execution_evidence_rejected'),
  reason: Schema.String,
  refusal: OwnerExecutionEvidenceRefusalSchema,
};
const rejectedContract = Schema.TaggedStruct('OwnerExecutionEvidenceRejected', rejectedFields);
export const OwnerExecutionEvidenceRejected = Schema.TaggedError<typeof rejectedContract.Type>()(
  'OwnerExecutionEvidenceRejected',
  rejectedFields,
);

const unavailableFields = {
  cause: Schema.optionalKey(Schema.Unknown),
  code: Schema.Literal('owner_execution_evidence_store_unavailable'),
  reason: Schema.String,
};
const unavailableContract = Schema.TaggedStruct('OwnerExecutionEvidenceStoreUnavailable', unavailableFields);
export const OwnerExecutionEvidenceStoreUnavailable = Schema.TaggedError<typeof unavailableContract.Type>()(
  'OwnerExecutionEvidenceStoreUnavailable',
  unavailableFields,
);

export const OwnerExecutionEvidenceErrorSchema = Schema.Union([
  OwnerExecutionEvidenceRejected,
  OwnerExecutionEvidenceStoreUnavailable,
]);
