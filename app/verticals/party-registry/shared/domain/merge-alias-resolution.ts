/* eslint-disable max-classes-per-file -- One closed alias-resolution error contract is shared by every Party-owned fact service. */
import { Schema } from 'effect';
import { PartyRefSchema } from '../resources/party.ts';

const PartyIdSchema = Schema.String.check(Schema.isMinLength(1));
const TenantIdSchema = Schema.String.check(Schema.isUUID());

export class PartyAliasResolutionCycle extends Schema.TaggedError<PartyAliasResolutionCycle>()(
  'PartyAliasResolutionCycle',
  {
    code: Schema.Literal('party_alias_resolution_cycle'),
    partyId: PartyIdSchema,
    reason: Schema.String,
    tenantId: TenantIdSchema,
  },
) {}

export class PartyAliasResolutionCrossTenant extends Schema.TaggedError<PartyAliasResolutionCrossTenant>()(
  'PartyAliasResolutionCrossTenant',
  {
    aliasPartyId: PartyIdSchema,
    code: Schema.Literal('party_alias_resolution_cross_tenant'),
    reason: Schema.String,
    tenantId: TenantIdSchema,
  },
) {}

export class PartyAliasResolutionBrokenChain extends Schema.TaggedError<PartyAliasResolutionBrokenChain>()(
  'PartyAliasResolutionBrokenChain',
  {
    code: Schema.Literal('party_alias_resolution_broken_chain'),
    missingPartyId: PartyIdSchema,
    reason: Schema.String,
    tenantId: TenantIdSchema,
  },
) {}

export class PartyAliasResolutionUnavailable extends Schema.TaggedError<PartyAliasResolutionUnavailable>()(
  'PartyAliasResolutionUnavailable',
  {
    code: Schema.Literal('party_alias_resolution_unavailable'),
    reason: Schema.String,
  },
) {}

export class PartyAliasWriteRejected extends Schema.TaggedError<PartyAliasWriteRejected>()(
  'PartyAliasWriteRejected',
  {
    aliasPartyRef: PartyRefSchema,
    canonicalPartyRef: PartyRefSchema,
    code: Schema.Literal('party_alias_write_rejected'),
    reason: Schema.String,
  },
) {}

export type PartyAliasResolutionError =
  | PartyAliasResolutionBrokenChain
  | PartyAliasResolutionCrossTenant
  | PartyAliasResolutionCycle
  | PartyAliasResolutionUnavailable;
