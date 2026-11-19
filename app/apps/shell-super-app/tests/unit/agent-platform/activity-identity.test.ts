// @rstest-environment node
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import {
  buildApplicationCompositionCatalog,
  OntosModuleIdSchema,
  ReadRuntime,
  TenantModuleStateService,
} from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import {
  ActiveApplicationCompositionService,
  makeActiveApplicationCompositionService,
} from '@app/core-runtime/modules/active-application-composition';
import { NodeCrypto, NodeHttpServer } from '@effect/platform-node';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { DateTime, Effect, Layer, Predicate, Schema } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { NetAddress } from 'effect/net';
import { AgentReviewRequestSchema, AgentReviewResponseSchema } from '@app/shared-contracts/agent-review';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { OAuthGrantRegistryLive } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-live.ts';
import { CoreDatabase } from '../../../../../packages/core-runtime/src/db/client.ts';
import {
  declaredActionAuthorities,
  makeActionAuthorityService,
} from '../../../../../packages/core-runtime/src/permissions/action-authority.ts';
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
import { makeCompositionSnapshot, sealComposition } from '../../fixtures/application-composition.ts';

const principal: AgentPlatformCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:activity-identity-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const caller: AgentPlatformCaller = {
  legalName: 'Company',
  principal,
  scope: { ...principal, correlationId: 'activity-test' },
};
const fixture = (selected: AgentPlatformCaller, privateRecords = false) =>
  Effect.gen(function* activityFixture() {
    const contract = makeModuleContractFixture({ appId: 'notes', moduleId: 'fixture.notes' });
    const server = yield* NodeHttpServer.make(() => process.getBuiltinModule('http').createServer(), {
      host: '127.0.0.1',
      port: 0,
    });
    yield* server.serve(
      Effect.gen(function* reviewRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        expect(request.method).toBe('POST');
        expect(request.url).toBe('/notes-api/reads/agent-review');
        const payload = yield* request.json;
        expect(yield* Schema.decodeUnknownEffect(AgentReviewRequestSchema)(payload)).toEqual({ items: [] });
        if (selected.principal.authContextRef === 'private-unavailable') {
          return HttpServerResponse.jsonUnsafe({ detail: 'Review unavailable' }, { status: 503 });
        }
        const response = yield* Schema.encodeEffect(AgentReviewResponseSchema)({
          items: [],
          seesAllRecords: selected.principal.authContextRef === 'private-all',
        });
        return HttpServerResponse.jsonUnsafe(response);
      }).pipe(Effect.orDie),
    );
    const { address } = server;
    if (!NetAddress.isInetAddress(address)) {
      return yield* Effect.die('The review server did not bind to TCP');
    }
    const published = yield* makeCompositionSnapshot([
      {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            actions: [
              {
                accessDeclaration: {
                  key: 'fixture.notes.command.run',
                  kind: 'action',
                  modes: ['run'],
                  placement: { group: 'actions', level: 'extended' },
                  risk: 'routine',
                  selectors: [],
                },
                actionKey: 'fixture.notes.apply-command',
                auditProfile: 'standard',
                entrypoint: {
                  access: 'write',
                  authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
                  entrypointKey: 'fixture.notes.apply-command',
                  moduleKey: 'fixture.notes',
                  role: 'action',
                  scope: 'tenant',
                },
                idempotency: 'required',
                legalEntityScope: 'required',
                owningModuleId: 'fixture.notes',
                schemaVersion: '1',
              },
            ],
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
    const composition = {
      ...published,
      composition: sealComposition({
        ...published.composition,
        modules: published.composition.modules.map((module) => ({
          ...module,
          backend: { baseUrl: `http://127.0.0.1:${address.port}/`, transport: 'node-http' as const },
        })),
      }),
    };
    const catalog = yield* buildApplicationCompositionCatalog(composition.composition);
    const gate = makeTestAccessDecision({
      answers: {
        'fixture.notes.command.run': {
          outcome: selected.principal.principalId === 'no-approval-rights' ? 'DENIED' : 'ALLOWED',
        },
      },
    });
    const authority = makeActionAuthorityService({
      declared: declaredActionAuthorities(catalog),
      gate,
      now: yield* DateTime.nowAsDate,
    });
    const moduleKey = OntosModuleIdSchema.make('fixture.notes');
    const activeModules = [{ moduleKey, state: 'active' as const }];
    const driver = scriptedPgClientLayer(
      Effect.succeed(testSqlConnection(() => Effect.die('Unexpected OAuth owner SQL'))),
    ).pipe(Layer.provideMerge(Reactivity.layer));
    const executor = yield* makeWithDefaults({ relations: coreRelations }).pipe(Effect.provide(driver));
    const registry = OAuthGrantRegistryLive.pipe(
      Layer.provide(Layer.succeed(CoreDatabase, { executor })),
      Layer.provide(NodeCrypto.layer),
    );
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
          Layer.succeed(AccessDecisionGate, gate),
          Layer.succeed(TenantModuleStateService, {
            getTenantModuleStates: (_tenantId, keys) =>
              Effect.succeed(activeModules.filter(({ moduleKey: key }) => keys.includes(key))),
            listActiveTenantModules: () => Effect.succeed(activeModules),
            listTenantModuleStates: () => Effect.succeed(activeModules),
          }),
          Layer.succeed(ActionAuthority, authority),
          Layer.succeed(
            ActiveApplicationCompositionService,
            makeActiveApplicationCompositionService(Effect.succeed(composition)),
          ),
          Layer.succeed(GatewayIssuer, {
            issue: () =>
              Effect.succeed({
                apiBaseUrl: '/module-api/notes/notes-build/notes-api',
                compositionRevision: composition.composition.revision,
                expiresAt: 0,
                token: 'activity-review-token',
              }),
            issueDocument: () => Effect.die('Activity does not issue document assertions'),
          }),
          Layer.succeed(CompanyDirectory, {
            confirmArchived: () => Effect.die('Activity does not archive agents'),
            replaceOperators: () => Effect.die('Activity does not edit operators'),
            snapshot: Effect.die('Activity without people administration does not load the directory'),
          }),
        ),
      ),
    );
    return { inputs, principals, readKeys, reads, run, transports };
  });

it.live(
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
    }).pipe(Effect.scoped),
);

it.live('keeps concurrent activity request identities and selected-company carriers isolated', () =>
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
  }).pipe(Effect.scoped),
);

it.live('keeps the exact principal and correlation carrier on native actor name and agent-ID reads', () =>
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
  }).pipe(Effect.scoped),
);

for (const visibility of ['private-unavailable', 'private-restricted', 'private-all']) {
  it.live(`narrows native activity by the module's ${visibility} review`, () =>
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
    }).pipe(Effect.scoped),
  );
}

it.live('refuses activity without module approval rights before any native read', () =>
  Effect.gen(function* deniedActivity() {
    const test = yield* fixture({ ...caller, principal: { ...principal, principalId: 'no-approval-rights' } });
    const failure = yield* test.run.pipe(
      Effect.provideService(AgentReadRequestIdentity, { correlationId: 'denied-activity' }),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'AgentPlatformForbidden')).toBe(true);
    expect(test.readKeys).toEqual([]);
  }).pipe(Effect.scoped),
);
