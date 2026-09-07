import { Schema } from 'effect';
import { CounterpartyUuidSchema } from '../counterparty-contract.ts';

export class CounterpartyNotFound extends Schema.TaggedError<CounterpartyNotFound>()(
  'CounterpartyNotFound',
  {
    code: Schema.Literal('counterparty_not_found'),
    counterpartyId: CounterpartyUuidSchema,
    reason: Schema.String,
  },
) {}
