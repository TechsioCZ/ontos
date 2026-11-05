import { Schema } from 'effect';

/**
 * A compare-and-set lost: the proposal already moved, so the caller re-reads it instead of
 * overwriting a decision. A second execution of one mandate ends here, never in a second run.
 */
export class ApprovalStorageConflictError extends Schema.TaggedError<ApprovalStorageConflictError>()(
  'ApprovalStorageConflictError',
  {
    code: Schema.Literal('approval_storage_conflict'),
    reason: Schema.String,
  },
) {}
