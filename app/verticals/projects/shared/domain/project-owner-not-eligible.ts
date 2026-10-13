import { Schema } from 'effect';

export class ProjectOwnerNotEligible extends Schema.TaggedError<ProjectOwnerNotEligible>()('ProjectOwnerNotEligible', {
  code: Schema.Literal('project_owner_not_eligible'),
  reason: Schema.String,
}) {}
