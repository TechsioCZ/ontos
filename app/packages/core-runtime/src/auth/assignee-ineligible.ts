import { Schema } from 'effect';

export class AssigneeIneligible extends Schema.TaggedError<AssigneeIneligible>()('AssigneeIneligible', {
  reason: Schema.String,
}) {}
