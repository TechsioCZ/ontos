import { Schema } from 'effect';

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()('ProjectNotFound', {
  code: Schema.Literal('project_not_found'),
  reason: Schema.String,
}) {}
