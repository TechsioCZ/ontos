import type { PartyOfficialIdentifierRef } from '../../shared/resources/party-official-identifier.ts';

/** Owner-private convenience constructor; the published ResourceRef contract remains schema-only. */
export const makePartyOfficialIdentifierRef = (
  tenantId: string,
  resourceId: string,
): PartyOfficialIdentifierRef => ({
  moduleId: 'party.registry',
  resourceId,
  resourceType: 'party.registry.party-official-identifier',
  tenantId,
});
