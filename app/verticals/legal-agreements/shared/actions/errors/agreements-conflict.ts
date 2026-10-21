// Adapted generated Action contract error.
import { Schema } from 'effect';

export class AgreementsConflict extends Schema.TaggedError<AgreementsConflict>()('AgreementsConflict', {
  code: Schema.Literal('agreements_conflict'),
  reason: Schema.String,
}) {}
