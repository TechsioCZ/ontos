import { Schema } from 'effect';

export class CounterpartyCanonicalizationOwnerUnavailable extends Schema.TaggedError<CounterpartyCanonicalizationOwnerUnavailable>()(
  'CounterpartyCanonicalizationOwnerUnavailable',
  {
    ownerModuleId: Schema.Literal('party.registry'),
    reason: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    retryable: Schema.Literal(true),
  },
) {}
