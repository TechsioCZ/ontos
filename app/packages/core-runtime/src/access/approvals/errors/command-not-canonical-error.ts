import { Schema } from 'effect';

/** A command cannot be frozen when it is not representable as JSON. */
export class CommandNotCanonicalError extends Schema.TaggedError<CommandNotCanonicalError>()(
  'CommandNotCanonicalError',
  {
    code: Schema.Literal('command_not_canonical'),
    reason: Schema.String,
  },
) {}
