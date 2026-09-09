import { Schema } from 'effect';

import { PartyIdJsonSchema, TenantIdJsonSchema } from './shared.ts';

export class PartyAliasResolutionCycle extends Schema.TaggedError<PartyAliasResolutionCycle>()(
  'PartyAliasResolutionCycle',
  {
    code: Schema.Literal('party_alias_resolution_cycle'),
    partyId: PartyIdJsonSchema,
    reason: Schema.String,
    tenantId: TenantIdJsonSchema,
  },
) {}
