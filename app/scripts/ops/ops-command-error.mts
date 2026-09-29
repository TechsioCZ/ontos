import { Schema } from 'effect';

/** An external CLI the stage operations drive (`zcli`, `gh`, Wrangler) could not run or exited non-zero. */
export class OpsCommandError extends Schema.TaggedError<OpsCommandError>()('OpsCommandError', {
  cause: Schema.optional(Schema.Defect()),
  command: Schema.String,
  message: Schema.String,
}) {}
