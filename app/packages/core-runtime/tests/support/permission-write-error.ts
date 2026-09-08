import { Schema } from 'effect';

export class TestWriteError extends Schema.TaggedError<TestWriteError>()(
  'TestWriteError',
  {
    reason: Schema.String,
  }
) {}
