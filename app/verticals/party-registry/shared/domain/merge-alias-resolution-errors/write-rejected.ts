import { Schema } from 'effect';

import { PartyRefSchema } from '../../resources/party.ts';

export class PartyAliasWriteRejected extends Schema.TaggedError<PartyAliasWriteRejected>()(
  'PartyAliasWriteRejected',
  {
    aliasPartyRef: PartyRefSchema,
    canonicalPartyRef: PartyRefSchema,
    code: Schema.Literal('party_alias_write_rejected'),
    reason: Schema.String,
  }
) {}
