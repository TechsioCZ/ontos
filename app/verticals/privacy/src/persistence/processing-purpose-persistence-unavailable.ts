import { Schema } from 'effect';

export class ProcessingPurposePersistenceUnavailable extends Schema.TaggedError<ProcessingPurposePersistenceUnavailable>()(
  'ProcessingPurposePersistenceUnavailable',
  {
    code: Schema.Literal('privacy_processing_purpose_persistence_unavailable'),
    reason: Schema.String,
  },
) {}

export type ProcessingPurposePersistenceUnavailableError = ProcessingPurposePersistenceUnavailable;
