import { Schema } from 'effect';

/** Unreadable subject facts, missing agent credential context or indeterminate inspection. */
export class SubjectInspectionUnavailable extends Schema.TaggedError<SubjectInspectionUnavailable>()(
  'SubjectInspectionUnavailable',
  { cause: Schema.optionalKey(Schema.Unknown), reason: Schema.String },
) {}
