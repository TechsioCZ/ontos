import { Schema } from 'effect';

export class ActionAuthorizationLifecycleError extends Schema.TaggedError<ActionAuthorizationLifecycleError>()(
  'ActionAuthorizationLifecycleError',
  { cause: Schema.optionalKey(Schema.Defect()), reason: Schema.String },
) {}
