// Adapted generated Action contract error.
import { Schema } from 'effect';

export class AgreementsNotFound extends Schema.TaggedError<AgreementsNotFound>()('AgreementsNotFound', {
  code: Schema.Literal('agreements_not_found'),
  reason: Schema.String,
}) {}
