import { Schema } from 'effect';

export class PartyRegistryReferenceUnavailable extends Schema.TaggedError<PartyRegistryReferenceUnavailable>()(
  'PartyRegistryReferenceUnavailable',
  {
    code: Schema.Literal('party_registry_reference_unavailable'),
    reason: Schema.String,
  },
) {}
