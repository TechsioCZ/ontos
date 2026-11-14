import { Schema } from 'effect';

export class MerchandiseRevisionConflict extends Schema.TaggedError<MerchandiseRevisionConflict>()(
  'MerchandiseRevisionConflict',
  {
    code: Schema.Literal('merchandise_revision_conflict'),
    reason: Schema.String,
  },
) {}
