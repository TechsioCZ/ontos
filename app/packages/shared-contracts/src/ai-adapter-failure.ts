import { Schema } from 'effect';

/** Internal adapter failure; the public message is safe to display, while cause keeps the original failure. */
export class AiAdapterFailure extends Schema.TaggedError<AiAdapterFailure>()('AiAdapterFailure', {
  cause: Schema.Unknown,
  message: Schema.String,
}) {}
