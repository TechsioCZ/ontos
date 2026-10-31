import { ContextAccess, OAuthGrantRegistry, ReadRuntime } from '@app/core-runtime';
import type { OAuthGrantRecord, ReadRuntimeService } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { Data, Effect, Layer, Option, Schema } from 'effect' with { rstest: 'importActual' };
import { expect, it, rs } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import type { AgentPlatformCaller } from '../../../api/agent-platform/caller.ts';
import { loadAgentActivity } from '../../../api/agent-platform/service-queue.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { CompanyDirectory } from '../../../api/oauth-connections-admin/company-directory.ts';
import type { CompanyDirectorySnapshot } from '../../../api/oauth-connections-admin/ports.ts';
import type { GrantListFilter } from '../../../api/oauth-connections/types.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';

rs.mock('../../../api/agent-platform/caller.ts', () => ({
  AgentPlatformForbidden: Data.TaggedError('AgentPlatformForbidden'),
  callerModuleAccess: () => Effect.succeed({ access: new Set(['fixture.notes']), write: new Set(['fixture.notes']) }),
}));
rs.mock('../../../api/auth/demo-accounts.ts', () => ({
  demoAccountCapability: () => Effect.succeed({ canManage: true }),
}));

const tenantId = '00000000-0000-4000-8000-000000000001';
const legalEntityId = '00000000-0000-4000-8000-000000000002';
const agentId = '00000000-0000-4000-8000-000000000009';
const principal: AgentPlatformCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:activity-grants-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId,
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId,
};

const grant = (grantId: string, status: OAuthGrantRecord['status']): OAuthGrantRecord => ({
  actingKind: 'agent',
  actingPrincipalId: agentId,
  authBindingId: null,
  clientHost: 'claude.ai',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
  clientKind: 'cimd',
  clientLogoUri: null,
  clientName: 'Claude Code',
  consentedAt: null,
  consentId: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  grantId,
  lastUsedAt: null,
  legalEntityId,
  modules: 'all',
  profileId: 'profile-1',
  revokedAt: null,
  revokedByPrincipalId: null,
  revokeReason: status === 'active' ? null : 'superseded',
  sessionId: null,
  status,
  tenantId,
  userId: 'user-1',
  userPrincipalId: principal.principalId,
  writePolicy: 'direct',
});
// Every reconnect of the same client leaves the previous grant behind as revoked or superseded history.
const stored = [
  grant('grant-active', 'active'),
  ...Array.from({ length: 30 }, (_, index) => grant(`grant-revoked-${index}`, 'revoked')),
  grant('grant-superseded', 'superseded'),
];

const directory: CompanyDirectorySnapshot = {
  agents: [
    {
      description: null,
      displayName: 'Claude Code',
      hasProfile: true,
      modules: [],
      operatorCommand: null,
      operatorPrincipalIds: [],
      ownerPrincipalId: null,
      principalId: agentId,
      status: 'active',
      writePolicy: 'direct',
    },
  ],
  members: [],
  people: [],
};

const fixture = Effect.gen(function* activityGrantsFixture() {
  const contract = makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' });
  const composition = yield* makeCompositionSnapshot([
    {
      ...contract,
      manifest: {
        ...contract.manifest,
        publicSurface: {
          ...contract.manifest.publicSurface,
          mcp: {
            approvals: true,
            description: { cs: 'Poznámky', en: 'Notes' },
            keywords: 'notes',
            label: { cs: 'Poznámky', en: 'Notes' },
            toolCatalog: { path: '/.well-known/ontos-module-mcp-tools.json', sha256: '0'.repeat(64), toolCount: 1 },
          },
        },
      },
    },
  ]);
  const filters: GrantListFilter[] = [];
  const reads: ReadRuntimeService = {
    // The registration's result schema is the decoded type, so rows carry Dates and Options.
    runRead: (input) =>
      Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)({
        access: [],
        audit: [
          {
            actionInvocationId: Option.none(),
            actionKey: Option.none(),
            auditEventId: '00000000-0000-4000-8000-0000000000a1',
            displayName: 'Claude Code',
            occurredAt: new Date('2026-10-30T10:00:00.000Z'),
            outcome: 'succeeded',
            outcomeCode: 'applied',
            principalId: agentId,
            targetModuleKey: Option.some('fixture.notes'),
            targetResourceId: Option.none(),
            targetResourceType: Option.none(),
          },
        ],
        names: [{ displayName: 'Claude Code', principalId: agentId }],
        proposalOnlyAgentIds: [],
        proposals: [],
      }).pipe(Effect.orDie),
  };
  const run = loadAgentActivity({ legalName: 'Company', principal }, {}).pipe(
    Effect.provideService(ReadRuntime, reads),
    Effect.provideService(AgentReadRequestIdentity, { correlationId: 'activity-grants' }),
    Effect.provide(
      Layer.mergeAll(
        makeInstalledModuleCatalogLayer(Effect.succeed(composition)),
        Layer.mock(OAuthGrantRegistry, {
          // Same contract as the store: no statuses means every status except draft.
          listGrants: (filter) =>
            Effect.sync(() => {
              filters.push(filter);
              const statuses = filter.statuses ?? [];
              return stored.filter((row) =>
                statuses.length === 0 ? row.status !== 'draft' : statuses.includes(row.status),
              );
            }),
        }),
        Layer.mock(CompanyDirectory, {
          snapshot: Effect.succeed(directory),
        }),
        Layer.mock(ContextAccess, {}),
        Layer.mock(ActionAuthority, {}),
        Layer.mock(ActiveApplicationCompositionService, {}),
        Layer.mock(GatewayIssuer, {}),
      ),
    ),
  );
  return { filters, run };
});

it.effect('links each activity row to the agent grant in force, not to its revoked and superseded history', () =>
  Effect.gen(function* activityGrantLinks() {
    const test = yield* fixture;
    const response = yield* test.run;
    expect(test.filters).toEqual([{ legalEntityId, statuses: ['active'], tenantId }]);
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0]?.grants).toEqual([
      { label: 'Claude Code · přímý zápis', path: '/sprava/pripojene-aplikace?grant=grant-active' },
    ]);
    expect(response.entries[0]?.agentPath).toBe(`/sprava/lide-a-role?agent=${agentId}`);
  }),
);
