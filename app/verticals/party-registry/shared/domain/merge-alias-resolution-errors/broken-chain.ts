import { Schema } from 'effect';

import { PartyIdJsonSchema, TenantIdJsonSchema } from './shared.ts';

export class PartyAliasResolutionBrokenChain extends Schema.TaggedError<PartyAliasResolutionBrokenChain>()(
  'PartyAliasResolutionBrokenChain',
  {
    code: Schema.Literal('party_alias_resolution_broken_chain'),
    missingPartyId: PartyIdJsonSchema,
    reason: Schema.String,
    tenantId: TenantIdJsonSchema,
  },
) {}
