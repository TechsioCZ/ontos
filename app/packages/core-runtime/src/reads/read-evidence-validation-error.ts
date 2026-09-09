import { Schema } from 'effect';

export class ReadEvidenceValidationError extends Schema.TaggedError<ReadEvidenceValidationError>()(
  'ReadEvidenceValidationError',
  { code: Schema.Literal('read_evidence_invalid'), reason: Schema.String },
) {}
