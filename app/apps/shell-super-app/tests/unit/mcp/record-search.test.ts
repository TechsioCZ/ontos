import { subjectInspectionFixture } from '../oauth-connections-admin/subject-inspection.fixture.ts';
// @rstest-environment node
import {
  ContextAccess,
  ActionRuntime,
  ActiveApplicationCompositionService,
  AgentProposalCommandPreparation,
  AgentProposalQueueModuleReview,
  OAuthAuthenticationAudit,
  OAuthConnectionCompanies,
  OAuthGrantRegistry,
  OAuthGrantModulesSchema,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadRuntime,
  TenantModuleStateService,
  TenantModuleStateReadUnavailableError,
} from '@app/core-runtime';
import type { ContextAccessService, OAuthGrantRecord, ReadCoreError, TenantModuleStateRecord } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { GateInput } from '@app/core-runtime/access/enforcement';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Crypto, Effect, Layer, Option, Schema } from 'effect';
import type { Scope } from 'effect';
import { HttpRouter, HttpServerRequest } from 'effect/http';
import { describe, expect, it, rs } from 'effect-rstest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/client';

import { AgentReadRequestIdentity } from '../../../api/auth/agent-request-identity.ts';
import { OAuthCredentials } from '../../../api/auth/db/oauth-credentials.ts';
import { ShellCryptoLive, GatewayIssuer } from '../../../api/auth/gateway-issuer.ts';
import { AuthenticationService } from '../../../api/auth/service.ts';
import { mcpRecordSearchResourceTypes } from '../../../api/mcp/catalog.ts';
import { McpRecordSearch, searchMcpRecords, searchMcpRecordsTool } from '../../../api/mcp/record-search.ts';
import { McpEndpointTransportLive } from '../../../api/mcp/transport.ts';
import { mcpRequestIdentityMiddleware } from '../../../api/mcp/request-identity.ts';
import { OAuthAccessTokens } from '../../../api/mcp/connection.ts';
import { planTools, TYPED_TOOL_CAP } from '../../../api/mcp/tool-plan.ts';
import { buildConnectionTools } from '../../../api/mcp/tools.ts';
import type { McpBackend, ToolSpec } from '../../../api/mcp/types.ts';
import { CapturedShellCompositionCatalog } from '../../../api/modules/captured-shell-catalog.ts';
import {
  InstalledModuleCatalogUnavailableError,
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../../../api/modules/installed-module-catalog.ts';
import {
  ShellGovernedReads,
  createShellGovernedReadDefinitionsLayer,
  createShellGovernedReadsLayer,
} from '../../../api/modules/shell-governed-reads.ts';
import { ShellCompositionFactoryLive } from '../../../api/modules/shell-composition.ts';
import { ShellGovernedReadDefinitions } from '../../../api/modules/shell-governed-read-definitions.ts';
import type { ShellGovernedReadsService } from '../../../api/modules/shell-governed-reads.ts';
import { makeShellSearch, ShellResourceServicesFactoryLive } from '../../../api/modules/shell-resources.ts';
import { ConnectionUnauthorized } from '../../../api/oauth-connections/errors.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import { ShellSearchResponseSchema } from '../../../shared/browser-api.ts';
import type { ShellSearchResponse } from '../../../shared/browser-api.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { grantRegistryFixture, retainedGrant } from '../oauth-connections/grant-registry-fixture.ts';
import { connectionDescription, fixtureCatalog, FIXTURE_MODULE_ID } from './fixture-vertical.ts';

rs.mock('../../../api/oauth-connections/server-config.ts', () => ({
  get loadOAuthServerConfig() {
    return Effect.succeed({ issuer: 'https://ontos.test/oauth', resource: 'https://ontos.test/mcp' });
  },
}));

const alphaModule = 'fixture.notes';
const alphaType = 'fixture.notes.record';
const betaModule = 'fixture.other';
const betaType = 'fixture.other.record';
const peopleType = 'core.identity.person';
const correlationId = 'record-search-request';
const grant: OAuthGrantRecord = {
  ...retainedGrant,
  modules: Schema.decodeUnknownSync(OAuthGrantModulesSchema)([{ access: 'read', moduleId: alphaModule }]),
  writePolicy: 'read_only',
};
const neverCalled = () => Effect.die('Unexpected operation in MCP record-search test');

// Public deployment metadata only; no private vertical implementation/schema is imported.
const contract = (moduleId: string, appId: string, resourceTypes: readonly string[]) => ({
  deployment: { appId, buildMarker: 'record-search-test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: `${moduleId} records.`,
      displayName: moduleId,
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [],
      events: [],
      reports: [],
      resourceTypes: resourceTypes.map((key) => ({
        capabilities: {
          graphVisible: false,
          linkable: true,
          mediaAttachable: false,
          searchable: true,
          timelineVisible: false,
        },
        description: `${key} record.`,
        key,
        label: key,
        owningModuleId: moduleId,
      })),
      search: resourceTypes.map((resourceType, index) => ({
        accessFiltering: 'resource_permission',
        key: `${moduleId}.search${index}`,
        owningModuleId: moduleId,
        resourceType,
      })),
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: resourceTypes.map((_type, index) => ({
          accessDeclaration: {
            key: `${moduleId}.search${index}.read`,
            kind: 'read',
            modes: ['run'],
            placement: { group: 'search', level: 'basic' },
            risk: 'routine',
            selectors: [],
          },
          contributionKey: `${moduleId}.search${index}.contribution`,
          entrypoint: {
            access: 'read',
            authorization: { kind: 'protected' },
            entrypointKey: `${moduleId}.search${index}`,
            moduleKey: moduleId,
            role: 'search',
            scope: 'tenant',
          },
          searchKey: `${moduleId}.search${index}`,
        })),
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

const approvedComposition = (types: readonly string[] = [alphaType]) =>
  makeCompositionSnapshot([
    contract(alphaModule, 'fixture-notes', types),
    contract(betaModule, 'fixture-other', [betaType]),
  ]);

type SearchRequest = Parameters<ShellGovernedReadsService['search']>[0];
interface Controls {
  authorityUnavailable: boolean;
  currentGrant: OAuthGrantRecord | null;
  deniedModules: readonly string[];
  gateDecisions?: (typeof AccessDecisionGate)['Service']['decideMany'];
  grantReads: number;
  installed: Effect.Effect<ShellInstalledCatalog, InstalledModuleCatalogUnavailableError>;
  onGrantRead?: (count: number) => void;
  search: ShellGovernedReadsService['search'];
  searches: SearchRequest[];
  states: readonly TenantModuleStateRecord[];
  tokenChecks: string[];
  tokenValid: boolean;
}

const setup = Effect.fn('recordSearchTest.setup')(function* setup(
  types: readonly string[] = [alphaType],
  requestCorrelationId: string = correlationId,
) {
  const snapshot = yield* approvedComposition(types);
  const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  expect(installed.contracts.flatMap(({ manifest }) => manifest.publicSurface.shellContributions.search)).toHaveLength(
    types.length + 1,
  );
  const description = connectionDescription({
    acting: { displayName: 'Jana Testerová', kind: 'human', principalId: grant.actingPrincipalId },
    client: {
      clientId: grant.clientId,
      host: grant.clientHost,
      kind: grant.clientKind,
      logoUri: null,
      name: grant.clientName,
    },
    compositionRevision: installed.composition.revision,
    grantId: grant.grantId,
    legalEntityId: grant.legalEntityId,
    modules: [{ label: alphaModule, moduleId: alphaModule, read: true, write: false }],
    profileId: grant.profileId,
    tenantId: grant.tenantId,
    writePolicy: 'read_only',
  });
  const controls: Controls = {
    authorityUnavailable: false,
    currentGrant: grant,
    deniedModules: [],
    grantReads: 0,
    installed: Effect.succeed(installed),
    search: () => Effect.succeed({ partial: false, results: [] }),
    searches: [],
    states: [
      { moduleKey: alphaModule, state: 'active' },
      { moduleKey: betaModule, state: 'active' },
    ],
    tokenChecks: [],
    tokenValid: true,
  };
  const access: ContextAccessService = {
    legalEntities: ({ legalEntityIds }) => Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed', key }))),
    modules: () => Effect.die('Legacy module authority must not be consulted'),
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((ref) => ({ decision: 'allowed', key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}` })),
      ),
    tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed', key }))),
  };
  const crypto = yield* Effect.service(Crypto.Crypto).pipe(Effect.provide(ShellCryptoLive));
  const backend: McpBackend = {
    callModule: neverCalled,
    listProposals: neverCalled(),
    searchRecords: (input) => searchMcpRecordsTool(description, input),
    submitProposals: neverCalled,
  };
  const catalog = { ...fixtureCatalog(), compositionRevision: installed.composition.revision };
  const tools = buildConnectionTools({
    backend,
    catalog,
    crypto,
    description,
    prmUrl: 'https://ontos.test/metadata',
    publicOrigin: 'https://ontos.test',
  });
  const gateFor = (question: GateInput) =>
    makeTestAccessDecision({
      defaultAnswer: {
        outcome: controls.deniedModules.some(
          (moduleId) => question.carrier.accessDeclaration?.key.startsWith(`${moduleId}.`) === true,
        )
          ? 'DENIED'
          : 'ALLOWED',
      },
    });
  const gate = {
    ...makeTestAccessDecision(),
    decide: (question: GateInput) => gateFor(question).decide(question),
    decideMany: (questions: readonly GateInput[]) =>
      controls.gateDecisions === undefined
        ? Effect.forEach((question: GateInput) => gateFor(question).decide(question))(questions)
        : controls.gateDecisions(questions),
    list: (question: GateInput) => gateFor(question).list(question),
  };
  const inspection = subjectInspectionFixture({
    get capabilities() {
      const declarations = installed.contracts
        .filter(({ manifest }) => !controls.deniedModules.includes(manifest.module.id))
        .flatMap(({ manifest }) =>
          manifest.publicSurface.shellContributions.search.flatMap(({ accessDeclaration }) =>
            accessDeclaration === undefined ? [] : [accessDeclaration],
          ),
        );
      return declarations.map(({ key, modes }) => ({ key, modes: modes.filter((mode) => mode !== 'approve') }));
    },
    snapshot,
    subjects: [{ legalEntityId: grant.legalEntityId, principalId: grant.userPrincipalId, tenantId: grant.tenantId }],
  });
  const authority = Layer.mergeAll(
    inspection.layer,
    Layer.succeed(CapturedShellCompositionCatalog, installed),
    // Credential-verifier port only: no token issuance or forged signed credential. All live connection checks and
    // connectionPrincipalContext run unmocked against the retained-grant/graph service fixtures below.
    Layer.succeed(OAuthAccessTokens, {
      verify: (token) =>
        Effect.suspend(() => {
          controls.tokenChecks.push(token);
          return controls.tokenValid
            ? Effect.succeed({ grantId: grant.grantId, sub: grant.userId })
            : Effect.fail(new ConnectionUnauthorized({ code: 'token_invalid' }));
        }),
    }),
    Layer.mock(AuthenticationService, {}),
    Layer.succeed(
      OAuthGrantRegistry,
      grantRegistryFixture({
        findGrant: () =>
          Effect.sync(() => {
            controls.grantReads += 1;
            controls.onGrantRead?.(controls.grantReads);
            return Option.fromNullOr(controls.currentGrant);
          }),
        loadBindingStatus: () => Effect.succeed(Option.some('active')),
        loadPrincipals: () =>
          Effect.succeed(
            new Map([[grant.actingPrincipalId, { displayName: 'Jana Testerová', kind: 'human', status: 'active' }]]),
          ),
        touchGrantLastUsed: () => Effect.succeed(false),
      }),
    ),
    Layer.mock(OAuthCredentials, {
      loadUserAccount: () =>
        Effect.succeed(Option.some({ banned: false, emailVerified: true, name: 'Jana Testerová' })),
    }),
    Layer.succeed(ContextAccess, access),
    Layer.succeed(AccessDecisionGate, gate),
    Layer.mock(ActionAuthority, { checkActionAuthorities: () => Effect.succeed([]) }),
    Layer.mock(OAuthConnectionCompanies, {
      names: () => Effect.succeed(new Map([[grant.legalEntityId, 'Testovací firma']])),
    }),
    Layer.mock(OAuthFlow, {}),
    Layer.mock(OAuthAuthenticationAudit, {}),
    Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.suspend(() => controls.installed) }),
    Layer.mock(TenantModuleStateService, {
      getTenantModuleStates: (tenantId) => {
        expect(tenantId).toBe(grant.tenantId);
        return controls.authorityUnavailable
          ? Effect.fail(
              new TenantModuleStateReadUnavailableError({
                code: 'tenant_module_state_read_unavailable',
                reason: 'Unavailable state fixture',
              }),
            )
          : Effect.succeed(controls.states);
      },
    }),
    Layer.mock(ShellGovernedReads, {
      search: (request) =>
        Effect.gen(function* observeSearch() {
          controls.searches.push(request);
          expect((yield* CapturedShellCompositionCatalog)?.composition.revision).toBe(installed.composition.revision);
          return yield* controls.search(request);
        }),
    }),
  );
  const services = Layer.mergeAll(
    authority,
    Layer.succeed(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request('https://ontos.test/mcp', {
          headers: { authorization: 'Bearer verified-test-credential', 'x-correlation-id': requestCorrelationId },
        }),
      ),
    ),
    Layer.succeed(AgentReadRequestIdentity, { correlationId }),
  );
  // Standalone adapter fixture; the SDK tests below instead use the real transport's request-local backend binding.
  const layer = Layer.effect(
    McpRecordSearch,
    Effect.gen(function* bindTestSearch() {
      const context = yield* Effect.context<Effect.Services<ReturnType<typeof searchMcpRecords>>>();
      return { search: (listed, input) => searchMcpRecords(listed, input).pipe(Effect.provideContext(context)) };
    }),
  ).pipe(Layer.provideMerge(services));
  const search = yield* Effect.fromNullishOr(tools.find(({ name }) => name === 'ontos_search'));
  return { access, authority, catalog, controls, description, gate, installed, layer, search, snapshot, tools };
});

const hit = (resourceId: string, title = 'Kotel K-200') =>
  Schema.decodeUnknownSync(ShellSearchResponseSchema.fields.results.value.members[0])({
    kind: 'resource',
    ref: { moduleId: alphaModule, resourceId, resourceType: alphaType, tenantId: grant.tenantId },
    relevance: { score: 900, version: '1' },
    selectedLegalEntityId: grant.legalEntityId,
    title,
  });
const DEFAULT_SEARCH = { query: 'kotel' };
const invoke = (tool: ToolSpec, args: Schema.JsonObject = DEFAULT_SEARCH) => tool.handler(args);

interface NativeCounts {
  assertions: number;
  evidence: number;
  forbidden?: boolean;
  providers: number;
}
const runNativeSearch = Effect.fn('McpRecordSearchTest.nativeSearch')(
  function* runNativeSearch(
    request: SearchRequest,
    fixture: Pick<Effect.Success<ReturnType<typeof setup>>, 'access' | 'controls' | 'gate' | 'installed' | 'snapshot'>,
    counts: NativeCounts,
  ): Effect.fn.Return<ShellSearchResponse, ReadCoreError, Crypto.Crypto | Scope.Scope> {
    const states = {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(fixture.controls.states.filter(({ moduleKey }) => moduleIds.includes(moduleKey))),
      listActiveTenantModules: neverCalled,
      listTenantModuleStates: neverCalled,
    };
    const definitionsLayer = createShellGovernedReadDefinitionsLayer(
      {
        resource: { detail: neverCalled, timeline: neverCalled },
        search: {
          search: () => {
            counts.providers += 1;
            if (counts.forbidden === true) {
              return Effect.fail(
                new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'PRIVATE-OWNER-REFUSAL' }),
              );
            }
            const { kind: _kind, ...wire } = hit('native-current-record');
            return Effect.succeed([wire]);
          },
        },
      },
      {
        issueAssertion: ({ context }) => {
          counts.assertions += 1;
          expect(context).toEqual({ ...request.principal, correlationId: request.correlationId });
          return Effect.succeed('native-issuer-port-fixture');
        },
      },
      () => states,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AccessDecisionGate, fixture.gate),
          Layer.succeed(ContextAccess, fixture.access),
          Layer.succeed(TenantModuleStateService, states),
          ShellCompositionFactoryLive,
          ShellResourceServicesFactoryLive,
        ),
      ),
    );
    const registrations = yield* ShellGovernedReadDefinitions.pipe(Effect.provide(definitionsLayer));
    const harness = yield* makeReadTestHarness({
      access: 'allowed',
      applicationComposition: { load: Effect.succeed(fixture.snapshot) },
      compositionRevision: request.compositionRevision,
      executeOwnerQuery: neverCalled,
      expectedDeployment: fixture.installed.composition.shell.deployment,
      operationTime: new Date('2026-11-03T12:00:00Z'),
      ownerAuthorizationDecision: 'allowed',
      scope: { ...request.principal, correlationId: request.correlationId },
      shellSystemReads: registrations,
    });
    const shellLayer = createShellGovernedReadsLayer(registrations).pipe(
      Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
    );
    const actual = yield* ShellGovernedReads.pipe(Effect.provide(shellLayer), Effect.orDie);
    const result = yield* actual
      .search(request)
      .pipe(
        Effect.provide(
          staffAuthenticationNamespaceRegistryLayer([fixture.installed.composition.shell.deployment.appId]).pipe(
            Layer.orDie,
          ),
        ),
      );
    counts.evidence += harness.snapshot().evidenceWrites;
    expect(harness.snapshot().ownerQueries).toEqual([]);
    return result;
  },
  Effect.scoped,
  Effect.provide(ShellCryptoLive),
);

const acquireSdkServer = (authority: Effect.Success<ReturnType<typeof setup>>['authority']) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const server = HttpRouter.toWebHandler(
        McpEndpointTransportLive.pipe(
          Layer.provide(mcpRequestIdentityMiddleware.layer.pipe(Layer.provide(ShellCryptoLive))),
          // Keep the genuine authority services in the web-handler context. Unused write/proposal ports are explicit
          // defecting test doubles, never an empty context asserted to be trusted authority.
          Layer.provideMerge(
            Layer.mergeAll(
              authority,
              ShellCryptoLive,
              Layer.mock(ActionRuntime, {}),
              Layer.mock(ReadRuntime, {}),
              Layer.mock(ActiveApplicationCompositionService, {}),
              Layer.mock(AgentProposalCommandPreparation, {}),
              Layer.mock(AgentProposalQueueModuleReview, {}),
              Layer.mock(GatewayIssuer, {}),
            ),
          ),
        ),
        { disableLogger: true },
      );
      return server;
    }),
    (server) => Effect.promise(() => server.dispose()),
  );
const sdkRequest = (args: Schema.JsonObject, id = 1, requestCorrelationId: string = correlationId) =>
  new Request('https://ontos.test/mcp', {
    body: JSON.stringify({
      id,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: 'record-search-fixture', version: '1.0.0' },
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
        },
        arguments: args,
        name: 'ontos_search',
      },
    }),
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer verified-test-credential',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': 'ontos_search',
      'mcp-protocol-version': '2026-07-28',
      'x-correlation-id': requestCorrelationId,
    },
    method: 'POST',
  });

// Adapter, real SDK ingress, live-grant/bridge and real Shell/Core runtime tests with credential/storage/issuer
// service fixtures. These do not claim live OAuth cryptography, private owner SQL or real SpiceDB integration.
describe('MCP governed record search', () => {
  it.live(
    'real verified SDK ingress binds search request-locally and rechecks authority and correlation on every HTTP call',
    () =>
      Effect.gen(function* sdkBinding() {
        const f = yield* setup();
        const counts: NativeCounts = { assertions: 0, evidence: 0, providers: 0 };
        f.controls.search = (request) => runNativeSearch(request, f, counts);
        const server = yield* acquireSdkServer(f.authority);
        for (const id of [1, 2]) {
          const response = yield* Effect.promise(() =>
            server.handler(sdkRequest({ query: '  Kotel  ' }, id, `sdk-record-request-${id}`)),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            result: { structuredContent: { partial: false, results: [hit('native-current-record')] } },
          });
        }
        expect(f.controls.searches.map(({ correlationId: actual }) => actual)).toEqual([
          'sdk-record-request-1',
          'sdk-record-request-2',
        ]);
        expect(f.controls.searches.map(({ resourceTypes }) => resourceTypes)).toEqual([[alphaType], [alphaType]]);
        expect(f.controls.tokenChecks).toHaveLength(4);
        expect(f.controls.grantReads).toBe(4);
        expect(counts).toEqual({ assertions: 2, evidence: 2, providers: 2 });
      }).pipe(Effect.scoped),
  );

  it.live(
    'an owner entrypoint refusal stays a sanitized MCP403 tool error with one attempt, not empty results or503',
    () =>
      Effect.gen(function* sdkOwnerRefusal() {
        const f = yield* setup();
        const counts: NativeCounts = { assertions: 0, evidence: 0, forbidden: true, providers: 0 };
        f.controls.search = (request) => runNativeSearch(request, f, counts);
        const server = yield* acquireSdkServer(f.authority);
        const response = yield* Effect.promise(() => server.handler(sdkRequest({ query: 'Kotel' })));
        // MCP tools retain the protocol's HTTP200 envelope; the genuine permission status is machine-readable403.
        expect(response.status).toBe(200);
        const body = yield* Effect.promise(() => response.json());
        expect(body).toMatchObject({
          result: { _meta: { 'ontos/code': 'read_permission_denied', 'ontos/status': 403 }, isError: true },
        });
        expect(JSON.stringify(body)).not.toContain('PRIVATE-OWNER');
        expect(counts.assertions).toBe(1);
        expect(counts.providers).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.live(
    'SDK caller scope/unknown/system selectors never reach governed dispatch and current revocation applies to the next request',
    () =>
      Effect.gen(function* sdkRefusal() {
        const f = yield* setup();
        const server = yield* acquireSdkServer(f.authority);
        for (const args of [
          { principal: {}, query: 'Kotel' },
          { legalEntityId: grant.legalEntityId, query: 'Kotel' },
          { query: 'Kotel', resourceTypes: [peopleType] },
          { query: 'Kotel', resourceTypes: [betaType] },
        ]) {
          const response = yield* Effect.promise(() =>
            server.handler(sdkRequest(Schema.decodeUnknownSync(Schema.JsonObject)(args))),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({ result: { isError: true } });
        }
        expect(f.controls.searches).toEqual([]);
        f.controls.currentGrant = { ...grant, status: 'revoked' };
        const revoked = yield* Effect.promise(() => server.handler(sdkRequest({ query: 'Kotel' })));
        expect(revoked.status).toBe(401);
        expect(f.controls.searches).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    'SDK mid-call company/client/composition changes and grant revocation/narrowing cannot reuse the outer admission',
    () =>
      Effect.gen(function* changedSdkAuthority() {
        for (const change of ['company', 'client', 'composition', 'revoked', 'narrowed'] as const) {
          const f = yield* setup();
          f.controls.onGrantRead = (count) => {
            if (count !== 2) {
              return;
            }
            if (change === 'company') {
              f.controls.currentGrant = { ...grant, legalEntityId: '00000000-0000-4000-8000-000000000099' };
            } else if (change === 'client') {
              f.controls.currentGrant = { ...grant, clientId: 'https://another.test/client' };
            } else if (change === 'composition') {
              f.controls.installed = Effect.succeed({
                ...f.installed,
                composition: { ...f.installed.composition, revision: 'a'.repeat(64) },
              });
            } else if (change === 'revoked') {
              f.controls.currentGrant = { ...grant, status: 'revoked' };
            } else {
              f.controls.currentGrant = { ...grant, modules: [] };
            }
          };
          const server = yield* acquireSdkServer(f.authority);
          const response = yield* Effect.promise(() => server.handler(sdkRequest({ query: 'Kotel' })));
          expect(response.status).toBe(200);
          const value = yield* Effect.promise(() => response.json());
          expect(value).toMatchObject(
            change === 'narrowed'
              ? { result: { structuredContent: { partial: false, results: [] } } }
              : { result: { isError: true } },
          );
          expect(f.controls.searches).toEqual([]);
        }
      }).pipe(Effect.scoped),
  );

  it.effect(
    'returns actual business records with the exact verified OAuth principal and an explicit grant-filtered selector',
    () =>
      Effect.gen(function* authorizedRecords() {
        const { controls, description, layer, search } = yield* setup();
        const result: ShellSearchResponse = { partial: false, results: [hit('product-9025')] };
        controls.search = () => Effect.succeed(result);
        const answer = yield* invoke(search, { includeArchived: true, query: 'Kotel', role: 'CUSTOMER' }).pipe(
          Effect.provide(layer),
        );
        expect(answer.isError).not.toBe(true);
        expect(answer.structuredContent).toEqual(result);
        expect(controls.searches).toHaveLength(1);
        expect(controls.searches[0]).toMatchObject({
          compositionRevision: description.compositionRevision,
          correlationId,
          includeArchived: true,
          principal: {
            authBindingId: grant.authBindingId,
            authContextRef: `oauth-grant:${grant.grantId}`,
            authMethod: 'oauth_connection',
            connection: { grantId: grant.grantId, modules: [{ access: 'read', moduleId: alphaModule }] },
            legalEntityId: grant.legalEntityId,
            principalId: grant.actingPrincipalId,
            tenantId: grant.tenantId,
          },
          query: 'Kotel',
          resourceTypes: [alphaType],
          role: 'CUSTOMER',
        });
        expect(controls.tokenChecks).toEqual(['verified-test-credential']);
        expect(controls.grantReads).toBe(1);
        expect(answer.structuredContent).not.toHaveProperty('total');
        expect(answer.structuredContent).not.toHaveProperty('url');
      }),
  );

  it.effect('never admits Core/system people from a business grant, even a caller-requested selector', () =>
    Effect.gen(function* noPeopleFromBusiness() {
      const { controls, layer, search } = yield* setup();
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).not.toBe(true);
      expect(controls.searches[0]?.resourceTypes).toEqual([alphaType]);
      const denied = yield* invoke(search, { query: 'Jana', resourceTypes: [alphaType, peopleType] }).pipe(
        Effect.provide(layer),
      );
      expect(denied).toMatchObject({ _meta: { 'ontos/code': 'record_search_forbidden' }, isError: true });
      expect(controls.searches).toHaveLength(1);
    }),
  );

  it.effect('omitted selector means every allowed type; explicit subset/duplicates only narrow it', () =>
    Effect.gen(function* allAllowed() {
      const extra = `${alphaModule}.document`;
      const { controls, layer, search } = yield* setup([alphaType, extra]);
      yield* invoke(search).pipe(Effect.provide(layer));
      yield* invoke(search, { query: 'kotel', resourceTypes: [extra, extra] }).pipe(Effect.provide(layer));
      expect(controls.searches.map(({ resourceTypes }) => resourceTypes)).toEqual([[extra, alphaType], [extra]]);
      const before = controls.searches.length;
      expect(
        (yield* invoke(search, { query: 'kotel', resourceTypes: [] }).pipe(Effect.provide(layer))).structuredContent,
      ).toEqual({ partial: false, results: [] });
      expect(controls.searches).toHaveLength(before);
    }),
  );

  it.effect('unknown, ungranted and mixed selectors fail before dispatch', () =>
    Effect.gen(function* refusedSelectors() {
      const { controls, layer, search } = yield* setup();
      for (const resourceTypes of [['unknown.record'], [betaType], [alphaType, betaType]]) {
        expect((yield* invoke(search, { query: 'kotel', resourceTypes }).pipe(Effect.provide(layer))).isError).toBe(
          true,
        );
      }
      expect(controls.searches).toEqual([]);
    }),
  );

  it.effect('empty, missing and unresolved grants never dispatch and never turn into unrestricted search', () =>
    Effect.gen(function* emptyAuthority() {
      const { controls, layer, search } = yield* setup();
      for (const modules of [[], [{ access: 'read' as const, moduleId: 'not.composed' }]]) {
        controls.currentGrant = { ...grant, modules: Schema.decodeUnknownSync(OAuthGrantModulesSchema)(modules) };
        expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
          partial: false,
          results: [],
        });
      }
      controls.currentGrant = null;
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      expect(controls.searches).toEqual([]);
    }),
  );

  it.effect('live module denial and unavailable permission evidence never dispatch', () =>
    Effect.gen(function* deniedGraph() {
      const f = yield* setup();
      const { controls, layer, search } = f;
      const counts: NativeCounts = { assertions: 0, evidence: 0, providers: 0 };
      controls.search = (request) => runNativeSearch(request, f, counts);
      controls.deniedModules = [alphaModule];
      expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
        partial: false,
        results: [],
      });
      controls.deniedModules = [];
      controls.gateDecisions = (questions) => makeTestAccessDecision({ unavailable: true }).decideMany(questions);
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      expect(counts.providers).toBe(0);
    }),
  );

  it.effect('truncated, excess and unavailable gate responses fail closed rather than silently narrowing', () =>
    Effect.gen(function* incompleteGate() {
      const f = yield* setup();
      const { controls, layer, search } = f;
      const counts: NativeCounts = { assertions: 0, evidence: 0, providers: 0 };
      controls.search = (request) => runNativeSearch(request, f, counts);
      controls.gateDecisions = (questions) =>
        makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } }).decideMany(questions.slice(1));
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      controls.gateDecisions = (questions) =>
        makeTestAccessDecision({ defaultAnswer: { outcome: 'ALLOWED' } }).decideMany([...questions, ...questions]);
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      controls.deniedModules = [];
      controls.gateDecisions = (questions) => makeTestAccessDecision({ unavailable: true }).decideMany(questions);
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      expect(counts.providers).toBe(0);
    }),
  );

  it.effect('current revocation and credential rejection are observed on the very next call, without a cache', () =>
    Effect.gen(function* freshAuthority() {
      const { controls, layer, search } = yield* setup();
      yield* invoke(search).pipe(Effect.provide(layer));
      controls.currentGrant = { ...grant, status: 'revoked' };
      const revoked = yield* invoke(search).pipe(Effect.provide(layer));
      expect(revoked).toMatchObject({ isError: true });
      expect(revoked._meta).toHaveProperty('mcp/www_authenticate');
      controls.currentGrant = grant;
      controls.tokenValid = false;
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      expect(controls.searches).toHaveLength(1);
      expect(controls.tokenChecks).toHaveLength(3);
      expect(controls.grantReads).toBe(2);
    }),
  );

  it.effect('new grant narrowing and tenant module state changes apply before the next dispatch', () =>
    Effect.gen(function* narrowedAuthority() {
      const { controls, layer, search } = yield* setup();
      yield* invoke(search).pipe(Effect.provide(layer));
      controls.currentGrant = { ...grant, modules: [] };
      expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
        partial: false,
        results: [],
      });
      controls.currentGrant = grant;
      for (const states of [[], [{ moduleKey: alphaModule, state: 'inactive' as const }]]) {
        controls.states = states;
        expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
          partial: false,
          results: [],
        });
      }
      expect(controls.searches).toHaveLength(1);
    }),
  );

  it.effect('cross-tenant/company/principal/client authority and changed composition fail closed', () =>
    Effect.gen(function* wrongContext() {
      const { controls, installed, layer, search } = yield* setup();
      for (const changes of [
        { tenantId: '00000000-0000-4000-8000-000000000099' },
        { legalEntityId: '00000000-0000-4000-8000-000000000099' },
        { actingPrincipalId: '00000000-0000-4000-8000-000000000099' },
        { clientId: 'https://another.test/client' },
      ]) {
        controls.currentGrant = { ...grant, ...changes };
        expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      }
      controls.currentGrant = grant;
      controls.installed = Effect.succeed({
        ...installed,
        composition: { ...installed.composition, revision: 'a'.repeat(64) },
      });
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      controls.installed = Effect.fail(new InstalledModuleCatalogUnavailableError({ reason: 'Unavailable fixture' }));
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      expect(controls.searches).toEqual([]);
    }),
  );

  it.effect('malformed authority, absent request services and transport identity mismatch fail honestly', () =>
    Effect.gen(function* malformedAuthority() {
      const { controls, layer, search } = yield* setup();
      // The actual verified-context constructor sees this malformed stored binding; no Schema-coerced replacement.
      controls.currentGrant = { ...grant, authBindingId: 'not-a-binding-uuid' };
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      controls.currentGrant = grant;
      expect((yield* invoke(search)).isError).toBe(true);
      const mismatched = yield* setup([alphaType], 'not-this-request');
      expect((yield* invoke(mismatched.search).pipe(Effect.provide(mismatched.layer))).isError).toBe(true);
      expect(mismatched.controls.searches).toEqual([]);
      expect(controls.searches).toEqual([]);
    }),
  );

  it.effect('unavailable or contradictory tenant state evidence never dispatches', () =>
    Effect.gen(function* unresolvedStates() {
      const { controls, layer, search } = yield* setup();
      controls.authorityUnavailable = true;
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      controls.authorityUnavailable = false;
      for (const states of [
        [
          { moduleKey: alphaModule, state: 'active' as const },
          { moduleKey: alphaModule, state: 'active' as const },
        ],
        [{ moduleKey: 'not.composed', state: 'active' as const }],
      ]) {
        controls.states = states;
        expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
      }
      expect(controls.searches).toEqual([]);
    }),
  );

  it.effect('uses the normalized query200 contract and forbids caller-supplied scope or pagination', () =>
    Effect.gen(function* queryContract() {
      const { controls, layer, search } = yield* setup();
      yield* invoke(search, { query: '  KOTEL  ' }).pipe(Effect.provide(layer));
      yield* invoke(search, { query: `  ${'k'.repeat(200)}  ` }).pipe(Effect.provide(layer));
      expect(controls.searches.map(({ query }) => query)).toEqual(['KOTEL', 'k'.repeat(200)]);
      for (const args of [
        { query: '' },
        { query: '   ' },
        { query: '\u0301' },
        { query: 'k'.repeat(201) },
        { principal: {}, query: 'kotel' },
        { query: 'kotel', tenantId: grant.tenantId },
        { legalEntityId: grant.legalEntityId, query: 'kotel' },
        { compositionRevision: 'f'.repeat(64), query: 'kotel' },
        { limit: 500, query: 'kotel' },
        { offset: 0, query: 'kotel' },
      ]) {
        expect(
          (yield* invoke(search, Schema.decodeUnknownSync(Schema.JsonObject)(args)).pipe(Effect.provide(layer)))
            .isError,
        ).toBe(true);
      }
      expect(controls.searches).toHaveLength(2);
    }),
  );

  it.effect('does not use capped records snapshots or truncate/postfilter authorized full results', () =>
    Effect.gen(function* fullResults() {
      const { controls, layer, search } = yield* setup();
      const results = Array.from({ length: 701 }, (_unused, index) => hit(`record-${index}`, `Záznam ${index}`));
      controls.search = () => Effect.succeed({ partial: false, results });
      const answer = yield* invoke(search).pipe(Effect.provide(layer));
      expect(answer.structuredContent).toEqual({ partial: false, results });
      expect(controls.searches[0]).not.toHaveProperty('limit');
      expect(controls.searches[0]).not.toHaveProperty('offset');
      // backend.callModule is a defect above: reaching a /reads/records snapshot fails this test immediately.
    }),
  );

  it.effect(
    'the real Shell orchestrator dispatches only the granted type and retains current-owner authorization/relevance',
    () =>
      Effect.gen(function* ownerSearch() {
        const { controls, gate, installed, layer, search } = yield* setup();
        const owners: string[] = [];
        const presentation = {
          business: { compositionRevision: installed.composition.revision, entries: [], schemaVersion: '1' },
          pages: [],
        };
        let resourceAllowed = true;
        const orchestrator = makeShellSearch(
          {
            access: gate,
            catalog: Effect.succeed(installed),
            issueAssertion: () => Effect.succeed('assertion-port-fixture'),
            moduleStates: {
              getTenantModuleStates: (_tenantId, moduleIds) =>
                Effect.succeed(controls.states.filter(({ moduleKey }) => moduleIds.includes(moduleKey))),
            },
          },
          {
            search: (request) => {
              owners.push(request.appId);
              const { kind: _kind, ...wire } = hit('current-record');
              return Effect.succeed(resourceAllowed ? [wire] : []);
            },
          },
        );
        controls.search = (request) =>
          orchestrator
            .search({ ...request.principal, correlationId: request.correlationId }, request)
            .pipe(
              Effect.mapError(
                () =>
                  new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Owner search unavailable' }),
              ),
            );
        expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
          partial: false,
          presentation,
          results: [hit('current-record')],
        });
        resourceAllowed = false;
        expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
          partial: false,
          presentation,
          results: [],
        });
        expect(owners).toEqual(['fixture-notes', 'fixture-notes']);
      }),
  );

  it.effect('preserves truthful empty/partial responses and refuses governed-read failures without fake results', () =>
    Effect.gen(function* truthfulResponse() {
      const { controls, layer, search } = yield* setup();
      controls.search = () => Effect.succeed({ partial: true, results: [hit('partial-record')] });
      expect((yield* invoke(search).pipe(Effect.provide(layer))).structuredContent).toEqual({
        partial: true,
        results: [hit('partial-record')],
      });
      controls.search = () =>
        Effect.fail(new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Unavailable fixture' }));
      expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
    }),
  );

  it.effect('the real Core ReadRuntime authorizes admitted business search without changing the OAuth principal', () =>
    Effect.gen(function* nativeCoreSearch() {
      const f = yield* setup();
      const counts: NativeCounts = { assertions: 0, evidence: 0, providers: 0 };
      f.controls.search = (request) => runNativeSearch(request, f, counts);
      const answer = yield* invoke(f.search).pipe(Effect.provide(f.layer));
      expect(answer.isError).not.toBe(true);
      expect(answer.structuredContent).toEqual({
        partial: false,
        presentation: {
          business: { compositionRevision: f.installed.composition.revision, entries: [], schemaVersion: '1' },
          pages: [],
        },
        results: [hit('native-current-record')],
      });
      expect(counts).toEqual({ assertions: 1, evidence: 1, providers: 1 });
    }),
  );

  // Both requests revalidate all 65 declarations. This real admission case exceeded 5s on CI;
  // give it a bounded budget without reducing the resource inventory or changing project defaults.
  it.effect(
    'does not truncate resource admission to typed-tool or selector caps',
    () =>
      Effect.gen(function* completeAdmission() {
        const types = Array.from({ length: 65 }, (_unused, index) => `${alphaModule}.type${index}`);
        const { controls, description, installed, layer, search } = yield* setup(types);
        expect(mcpRecordSearchResourceTypes(installed, description, controls.states)).toHaveLength(65);
        expect((yield* invoke(search).pipe(Effect.provide(layer))).isError).toBe(true);
        expect(controls.searches).toEqual([]);
        const selected = types.slice(64);
        expect(
          (yield* invoke(search, { query: 'kotel', resourceTypes: selected }).pipe(Effect.provide(layer))).isError,
        ).not.toBe(true);
        expect(controls.searches[0]?.resourceTypes).toEqual(selected);
      }),
    { timeout: 30_000 },
  );

  it.effect('capability-description search and the typed cap remain separate; read-only writes stay absent', () =>
    Effect.gen(function* unchangedCapabilities() {
      const { catalog, controls, description, search, tools } = yield* setup();
      const capabilities = yield* Effect.fromNullishOr(tools.find(({ name }) => name === 'ontos_capabilities'));
      const result = yield* capabilities.handler({ query: 'poznámka' });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        modules: [{ moduleId: FIXTURE_MODULE_ID, reads: [{ id: `${FIXTURE_MODULE_ID}/read/records` }] }],
      });
      expect(controls.searches).toEqual([]);
      expect(controls.tokenChecks).toEqual([]);
      expect(tools.map(({ name }) => name)).not.toContain('ontos_execute');
      expect(tools.map(({ name }) => name)).not.toContain('ontos_propose');
      expect(search.annotations).toEqual({ openWorldHint: false, readOnlyHint: true });
      const source = yield* Effect.fromNullishOr(catalog.modules.at(0));
      const read = yield* Effect.fromNullishOr(source.tools.at(0));
      const overCap = {
        ...catalog,
        modules: [
          {
            ...source,
            tools: Array.from({ length: TYPED_TOOL_CAP + 1 }, (_unused, index) => ({
              ...read,
              id: `read-${index}`,
              name: `read_${index}`,
            })),
          },
        ],
      };
      const plan = planTools(overCap, description);
      expect(plan).toMatchObject({ typed: [], typedCandidates: TYPED_TOOL_CAP + 1, typedOverCap: true });
      expect(plan.generic).toContain('ontos_search');
      expect(planTools(catalog, { ...description, writePolicy: 'approval' }).generic).toContain('ontos_execute');
      expect(planTools(catalog, { ...description, writePolicy: 'direct' }).generic).toContain('ontos_propose');
    }),
  );
});
