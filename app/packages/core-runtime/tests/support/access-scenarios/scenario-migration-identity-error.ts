import { Schema } from 'effect';

export class ScenarioMigrationIdentityError extends Schema.TaggedError<ScenarioMigrationIdentityError>()(
  'ScenarioMigrationIdentityError',
  { migration: Schema.String, reason: Schema.String },
) {}
