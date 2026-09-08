import { Schema } from 'effect';

export class ReadEvidencePersistenceError extends Schema.TaggedError<ReadEvidencePersistenceError>()(
  'ReadEvidencePersistenceError',
  {
    code: Schema.Literal('read_evidence_persistence_failed'),
    reason: Schema.String,
  }
) {}
