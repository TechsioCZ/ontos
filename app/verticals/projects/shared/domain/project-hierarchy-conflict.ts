import { Schema } from 'effect';

export class ProjectHierarchyConflict extends Schema.TaggedError<ProjectHierarchyConflict>()(
  'ProjectHierarchyConflict',
  { code: Schema.Literal('project_hierarchy_conflict'), reason: Schema.String },
) {}
