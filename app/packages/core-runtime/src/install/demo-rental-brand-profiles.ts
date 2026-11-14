/** Fixed synthetic identities. Rebranding changes labels, never subjects, principals or credentials. */
export const rentalDemoBrandProfiles = [
  {
    authUserId: 'siampark-management',
    displayName: 'Vedení Nájempark',
    email: 'management@najempark.demo',
    legacyDisplayName: 'Vedení Siampark',
    legacyEmail: 'management@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000021',
  },
  {
    authUserId: 'siampark-operations',
    displayName: 'Provoz Nájempark',
    email: 'operations@najempark.demo',
    legacyDisplayName: 'Provoz Siampark',
    legacyEmail: 'operations@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000022',
  },
  {
    authUserId: 'siampark-finance',
    displayName: 'Účetní Nájempark',
    email: 'finance@najempark.demo',
    legacyDisplayName: 'Účetní Siampark',
    legacyEmail: 'finance@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000023',
  },
  {
    authUserId: 'siampark-external',
    displayName: 'Externí obchodník',
    email: 'external@najempark.demo',
    legacyDisplayName: 'Externí obchodník',
    legacyEmail: 'external@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000024',
  },
] as const;
