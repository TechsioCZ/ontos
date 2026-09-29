import { Schema } from 'effect';

/** A stage operation precondition, verification item or input file did not hold. */
export class StageOperationError extends Schema.TaggedError<StageOperationError>()('StageOperationError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}
