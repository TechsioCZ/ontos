import { Schema } from 'effect';

export class MerchandiseReferenceIneligible extends Schema.TaggedError<MerchandiseReferenceIneligible>()(
  'MerchandiseReferenceIneligible',
  {
    code: Schema.Literal('merchandise_reference_ineligible'),
    reason: Schema.String,
  },
) {}
