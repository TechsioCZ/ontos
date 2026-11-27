import { Schema } from 'effect';

/**
 * A save of a draft form that left the server without the draft: the form's submit fails with how it ended, so
 * effect-form records only a committed save as the last submit.
 */
export class SaveRefused extends Schema.TaggedError<SaveRefused>()('SaveRefused', {
  outcome: Schema.Literals(['proposed', 'conflict', 'failed', 'reload-required']),
}) {}
