import { Schema } from 'effect';

/** Persistence is unavailable; callers retry the same operation. */
export class ApprovalStorageUnavailableError extends Schema.TaggedError<ApprovalStorageUnavailableError>()(
  'ApprovalStorageUnavailableError',
  {
    code: Schema.Literal('approval_storage_unavailable'),
    reason: Schema.String,
  },
) {}
