import { Schema } from 'effect';

/**
 * A shared layer or scenario setup refused before any assertion could run. `expect` inside a layer
 * build is not attributable to a test, so the suites that share an isolated database, its migrations
 * and its privilege grants fail with this instead, and the reason names the step that refused.
 */
export class NativeSetupFailed extends Schema.TaggedError<NativeSetupFailed>()('NativeSetupFailed', {
  reason: Schema.String,
}) {}
