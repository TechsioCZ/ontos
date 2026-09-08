import { Schema } from 'effect';

export class DuplicateCandidateConflict extends Schema.TaggedError<DuplicateCandidateConflict>()(
  'DuplicateCandidateConflict',
  {
    code: Schema.Literal('duplicate_candidate_conflict'),
    reason: Schema.String,
  }
) {}
