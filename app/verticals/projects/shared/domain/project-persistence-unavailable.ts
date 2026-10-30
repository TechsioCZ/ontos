import { Schema } from 'effect';

export class ProjectPersistenceUnavailable extends Schema.TaggedError<ProjectPersistenceUnavailable>()(
  'ProjectPersistenceUnavailable',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literal('project_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
