import { Schema } from 'effect';

export class CrmLifecycleConflict extends Schema.TaggedError<CrmLifecycleConflict>()('CrmLifecycleConflict', {
  code: Schema.Literal('crm_lifecycle_conflict'),
  reason: Schema.String,
}) {}
