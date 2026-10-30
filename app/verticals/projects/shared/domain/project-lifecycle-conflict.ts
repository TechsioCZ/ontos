import { Schema } from 'effect';

export class ProjectLifecycleConflict extends Schema.TaggedError<ProjectLifecycleConflict>()(
  'ProjectLifecycleConflict',
  { code: Schema.Literal('project_lifecycle_conflict'), reason: Schema.String },
) {}
