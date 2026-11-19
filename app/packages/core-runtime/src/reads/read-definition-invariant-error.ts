import { Schema } from 'effect';

/** A read definition that breaks one of `defineRead`'s rules, thrown at module load. */
export class ReadDefinitionInvariantError extends Schema.TaggedError<ReadDefinitionInvariantError>()(
  'ReadDefinitionInvariantError',
  {
    message: Schema.String,
  },
) {}
