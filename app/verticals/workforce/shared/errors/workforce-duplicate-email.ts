import { Schema } from 'effect';

/** Another Employee already uses this e-mail address (compared case-insensitively). */
export class WorkforceDuplicateEmail extends Schema.TaggedError<WorkforceDuplicateEmail>()('WorkforceDuplicateEmail', {
  code: Schema.Literal('workforce_duplicate_email'),
  reason: Schema.String,
}) {}
