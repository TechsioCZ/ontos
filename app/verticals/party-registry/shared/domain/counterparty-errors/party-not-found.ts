import { Schema } from 'effect';

import { CounterpartyUuidSchema } from '../counterparty-contract.ts';

export class CounterpartyPartyNotFound extends Schema.TaggedError<CounterpartyPartyNotFound>()(
  'CounterpartyPartyNotFound',
  {
    code: Schema.Literal('counterparty_party_not_found'),
    partyId: CounterpartyUuidSchema,
    reason: Schema.String,
  }
) {}
