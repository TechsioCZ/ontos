import { ContextAccess, ReadRuntime } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Data, Effect, Layer, Predicate, Schema } from 'effect' with { rstest: 'importActual' };
import { Reactivity } from 'effect/unstable/reactivity';
import { expect, it, rs } from 'effect-rstest';

import { OAuthGrantRegistryLive } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { CoreDatabase } from '../../../../../packages/core-runtime/src/db/client.ts';
import { coreRelations } from '../../../../../packages/core-runtime/src/db/schema.ts';
import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import { scriptedPgClientLayer } from '../../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../../packages/core-runtime/tests/support/sql-connection.ts';
import type { AgentPlatformCaller } from '../../../api/agent-platform/caller.ts';
import { listCompanyAgentIds, principalNames } from '../../../api/agent-platform/proposal-store.ts';
import { loadAgentActivity } from '../../../api/agent-platform/service-queue.ts';
import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { AuthDatabase } from '../../../api/auth/db/client.ts';
import { GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { CompanyDirectory } from '../../../api/oauth-connections-admin/company-directory.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';

rs.mock('../../../api/agent-platform/caller.ts', () => ({
  AgentPlatformForbidden: Data.TaggedError('AgentPlatformForbidden'),
  callerModuleAccess: (selected: AgentPlatformCaller) =>
    Effect.succeed({
      access: new Set(['fixture.notes']),
      write: new Set(selected.principal.principalId === 'no-approval-rights' ? [] : ['fixture.notes']),
    }),
}));
rs.mock('../../../api/agent-platform/module-review.ts', () => ({
  reviewInModule: (selected: AgentPlatformCaller['principal']) =>
    Effect.succeed(
      selected.authContextRef === 'private-unavailable'
        ? { privateRecords: true, state: 'unavailable' as const }
        : {
            item: () => {
              // Activity probes review no proposal items.
            },
            privateRecords: true,
            seesAllRecords: selected.authContextRef === 'private-all',
            state: 'ok' as const,
          },
    ),
}));
rs.mock('../../../api/auth/demo-accounts.ts', () => ({
  demoAccountCapability: () => Effect.succeed({ canManage: false }),
}));

const principal: AgentPlatformCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:activity-identity-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const caller: AgentPlatformCaller = { legalName: 'Company', principal };
const fixture = (selected: AgentPlatformCaller, privateRecords = false) =>
  Effect.gen(function* activityFixture() {
    const contract = makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' });
    const composition = yield* makeCompositionSnapshot([
      {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            mcp: {
              approvalReview: { path: '/reads/agent-review', privateRecords },
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
    const driver = scriptedPgClientLayer(
      Effect.succeed(testSqlConnection(() => Effect.die('Unexpected OAuth owner SQL'))),
    ).pipe(Layer.provideMerge(Reactivity.layer));
    const executor = yield* makeWithDefaults({ relations: coreRelations }).pipe(Effect.provide(driver));
    const registry = OAuthGrantRegistryLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, { executor })));
    const principals: unknown[] = [];
    const transports: unknown[] = [];
    const readKeys: string[] = [];
    const inputs: unknown[] = [];
    const reads: ReadRuntimeService = {
      runRead: (input) =>
        Effect.gen(function* captureReadIdentity() {
          principals.push(input.principal);
          transports.push(input.transport);
          readKeys.push(input.registration.descriptor.readKey);
          inputs.push(input.input);
          yield* Effect.yieldNow;
          // Decode against the actual native registration, not an obsolete Shell profile lookup.
          return yield* Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)({
            access: [],
            agentIds: [],
            audit: [],
            names: [],
            proposalOnlyAgentIds: [],
            proposals: [],
          }).pipe(Effect.orDie);
        }),
    };
    const run = loadAgentActivity(selected, {}).pipe(
      Effect.provideService(ReadRuntime, reads),
      Effect.provideService(AuthDatabase, {
        get adapter(): AuthDatabase['Service']['adapter'] {
          throw new Error('Unexpected authentication adapter IO');
        },
        get executor(): AuthDatabase['Service']['executor'] {
          throw new Error('Unexpected authentication database IO');
        },
      }),
      Effect.provide(
        Layer.mergeAll(
          registry,
          makeInstalledModuleCatalogLayer(Effect.succeed(composition)),
          Layer.mock(ContextAccess, {}),
          Layer.mock(ActionAuthority, {}),
          Layer.mock(ActiveApplicationCompositionService, {}),
          Layer.mock(GatewayIssuer, {}),
          Layer.mock(CompanyDirectory, {}),
        ),
      ),
    );
    return { inputs, principals, readKeys, reads, run, transports };
  });

it.effect(
  'passes the exact ingress principal and transport to native activity without duplicate profile or actor reads',
  () =>
    Effect.gen(function* originalActivityIdentity() {
      const test = yield* fixture(caller);
      const transport = { correlationId: 'original-read-identity' };
      yield* test.run.pipe(Effect.provideService(AgentReadRequestIdentity, transport));
      expect(test.transports).toHaveLength(1);
      expect(test.transports.every((value) => value === transport)).toBe(true);
      expect(test.principals.every((value) => value === principal)).toBe(true);
      expect(test.readKeys).toEqual(['core.identity.agent-activity']);
      expect(test.inputs).toEqual([{ request: {}, visibleModules: ['fixture.notes'] }]);
    }),
);

it.effect('keeps concurrent activity request identities and selected-company carriers isolated', () =>
  Effect.gen(function* isolatedActivityRequests() {
    const other: AgentPlatformCaller = {
      ...caller,
      principal: { ...principal, legalEntityId: '00000000-0000-4000-8000-000000000006' },
    };
    const first = yield* fixture(caller);
    const second = yield* fixture(other);
    const firstIdentity = { correlationId: 'first-read-identity' };
    const secondIdentity = { correlationId: 'second-read-identity' };
    yield* Effect.all(
      [
        first.run.pipe(Effect.provideService(AgentReadRequestIdentity, firstIdentity)),
        second.run.pipe(Effect.provideService(AgentReadRequestIdentity, secondIdentity)),
      ],
      { concurrency: 2 },
    );
    expect(first.transports).toHaveLength(1);
    expect(second.transports).toHaveLength(1);
    expect(first.transports.every((value) => value === firstIdentity)).toBe(true);
    expect(second.transports.every((value) => value === secondIdentity)).toBe(true);
    expect(second.principals.every((value) => value === other.principal)).toBe(true);
  }),
);

it.effect('keeps the exact principal and correlation carrier on native actor name and agent-ID reads', () =>
  Effect.gen(function* actorReadIdentity() {
    const test = yield* fixture(caller);
    const transport = { correlationId: 'actor-identity' };
    yield* Effect.all([principalNames(principal, transport), listCompanyAgentIds(principal, transport)]).pipe(
      Effect.provideService(ReadRuntime, test.reads),
    );
    expect(test.readKeys).toEqual(['core.identity.agent-activity-actors', 'core.identity.agent-activity-actors']);
    expect(test.principals).toHaveLength(2);
    expect(test.principals.every((value) => value === principal)).toBe(true);
    expect(test.transports.every((value) => value === transport)).toBe(true);
    expect(test.inputs).toEqual([{}, {}]);
  }),
);

for (const visibility of ['private-unavailable', 'private-restricted', 'private-all']) {
  it.effect(`narrows native activity by the module's ${visibility} review`, () =>
    Effect.gen(function* privateActivity() {
      const selected = { ...caller, principal: { ...principal, authContextRef: visibility } };
      const test = yield* fixture(selected, true);
      const transport = { correlationId: visibility };
      yield* test.run.pipe(Effect.provideService(AgentReadRequestIdentity, transport));
      expect(test.inputs[0]).toEqual({
        request: {},
        visibleModules: visibility === 'private-all' ? ['fixture.notes'] : [],
      });
      expect(test.readKeys).toEqual(['core.identity.agent-activity']);
      expect(test.principals.every((value) => value === selected.principal)).toBe(true);
      expect(test.transports.every((value) => value === transport)).toBe(true);
    }),
  );
}

it.effect('refuses activity without module approval rights before any native read', () =>
  Effect.gen(function* deniedActivity() {
    const test = yield* fixture({ ...caller, principal: { ...principal, principalId: 'no-approval-rights' } });
    const failure = yield* test.run.pipe(
      Effect.provideService(AgentReadRequestIdentity, { correlationId: 'denied-activity' }),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'AgentPlatformForbidden')).toBe(true);
    expect(test.readKeys).toEqual([]);
  }),
);
