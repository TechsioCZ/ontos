// Adapted generated Action contract error.
import { Schema } from 'effect';

export class AgreementsRejected extends Schema.TaggedError<AgreementsRejected>()('AgreementsRejected', {
  code: Schema.Literal('agreements_rejected'),
  reason: Schema.String,
}) {}
