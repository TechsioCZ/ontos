import { Effect, Option } from 'effect';

import type { OAuthGrantRecord } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-contract.ts';
import type { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';

const unexpected = () => Effect.die('Unexpected native registry operation');
export const grantRegistryFixture = (
  overrides: Partial<(typeof OAuthGrantRegistry)['Service']> = {},
): (typeof OAuthGrantRegistry)['Service'] => ({
  approveDraftGrant: unexpected,
  findGrant: () => Effect.succeed(Option.none()),
  findPreviousProfileId: unexpected,
  findSessionGrant: () => Effect.succeed(Option.none()),
  insertDraftGrant: unexpected,
  listAgentPrincipals: unexpected,
  listGrants: unexpected,
  loadBindingStatus: unexpected,
  loadPrincipals: unexpected,
  owners: unexpected,
  setGrantBindingStatus: unexpected,
  setGrantStatus: unexpected,
  touchGrantLastUsed: unexpected,
  updateGrantAccess: unexpected,
  ...overrides,
});

export const retainedGrant: OAuthGrantRecord = {
  actingKind: 'human',
  actingPrincipalId: '00000000-0000-4000-8000-000000000004',
  authBindingId: '00000000-0000-4000-8000-000000000006',
  clientHost: 'client.example',
  clientId: 'https://client.example/metadata',
  clientKind: 'cimd',
  clientLogoUri: null,
  clientName: 'Connector',
  consentedAt: new Date('2026-10-25T10:00:00Z'),
  consentId: 'real-consent',
  createdAt: new Date('2026-10-25T10:00:00Z'),
  grantId: '00000000-0000-4000-8000-000000000001',
  lastUsedAt: null,
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  modules: 'all',
  profileId: '00000000-0000-4000-8000-000000000005',
  revokedAt: null,
  revokedByPrincipalId: null,
  revokeReason: null,
  sessionId: 's',
  status: 'active',
  tenantId: '00000000-0000-4000-8000-000000000003',
  userId: 'u',
  userPrincipalId: '00000000-0000-4000-8000-000000000004',
  writePolicy: 'direct',
};
