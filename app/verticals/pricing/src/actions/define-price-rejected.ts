import { Schema } from 'effect';

export class DefinePriceRejected extends Schema.TaggedError<DefinePriceRejected>()('DefinePriceRejected', {
  code: Schema.Literals([
    'define_price_catalog_selection_invalid',
    'define_price_commercial_context_invalid',
    'define_price_effective_time_invalid',
    'define_price_scope_mismatch',
  ]),
  reason: Schema.String,
}) {}
