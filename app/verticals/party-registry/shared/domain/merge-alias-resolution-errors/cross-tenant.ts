import { Schema } from 'effect';

import { PartyIdJsonSchema, TenantIdJsonSchema } from './shared.ts';

export class PartyAliasResolutionCrossTenant extends Schema.TaggedError<PartyAliasResolutionCrossTenant>()(
  'PartyAliasResolutionCrossTenant',
  {
    aliasPartyId: PartyIdJsonSchema,
    code: Schema.Literal('party_alias_resolution_cross_tenant'),
    reason: Schema.String,
    tenantId: TenantIdJsonSchema,
  }
) {}
