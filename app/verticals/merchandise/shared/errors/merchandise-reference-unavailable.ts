import { Schema } from 'effect';

export class MerchandiseReferenceUnavailable extends Schema.TaggedError<MerchandiseReferenceUnavailable>()(
  'MerchandiseReferenceUnavailable',
  {
    code: Schema.Literal('merchandise_reference_unavailable'),
    reason: Schema.String,
  },
) {}
