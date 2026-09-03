import { Schema } from 'effect';

export class ProjectsDatabaseConnectionError extends Schema.TaggedError<ProjectsDatabaseConnectionError>()(
  'ProjectsDatabaseConnectionError',
  { reason: Schema.String },
) {}
