import { Schema } from 'effect';

export class CrmRevisionConflict extends Schema.TaggedError<CrmRevisionConflict>()('CrmRevisionConflict', {
  code: Schema.Literal('crm_revision_conflict'),
  reason: Schema.String,
}) {}
