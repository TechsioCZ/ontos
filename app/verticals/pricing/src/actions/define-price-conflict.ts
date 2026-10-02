import { Schema } from 'effect';

export class DefinePriceConflict extends Schema.TaggedError<DefinePriceConflict>()('DefinePriceConflict', {
  code: Schema.Literal('define_price_conflict'),
  reason: Schema.Literals([
    'EXACT_KEY_ALREADY_BOUND',
    'IDEMPOTENCY_CONFLICT',
    'PRICE_RESOURCE_ALREADY_BOUND',
    'UNVERIFIABLE_CURRENTNESS',
  ]),
}) {}
