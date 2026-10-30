import { Schema } from 'effect';

export class ProjectPrefixConflict extends Schema.TaggedError<ProjectPrefixConflict>()('ProjectPrefixConflict', {
  code: Schema.Literal('project_prefix_conflict'),
  reason: Schema.String,
}) {}
