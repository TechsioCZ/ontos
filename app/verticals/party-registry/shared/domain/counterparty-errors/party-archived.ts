import { Schema } from 'effect';

import { CounterpartyUuidSchema } from '../counterparty-contract.ts';

export class CounterpartyPartyArchived extends Schema.TaggedError<CounterpartyPartyArchived>()(
  'CounterpartyPartyArchived',
  {
    code: Schema.Literal('counterparty_party_archived'),
    partyId: CounterpartyUuidSchema,
    reason: Schema.String,
  }
) {}
