import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { ShellGovernedReadDefinitions } from '../../api/modules/shell-governed-read-definitions.ts';
// @rstest-environment node
import { ContextAccess, ReadRuntime, TenantModuleStateService, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { ContextAccessDecision, ContextAccessService, TenantModuleStateRecord } from '@app/core-runtime';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Effect, Layer, Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { connectionPrincipalContext } from '../../api/mcp/connection.ts';
import { toGrantRow } from '../../api/oauth-connections/grant-store.ts';
import { CapturedShellCompositionCatalog } from '../../api/modules/captured-shell-catalog.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import {
  createShellGovernedReadsLayer,
  createShellGovernedReadDefinitionsLayer,
  ShellGovernedReads,
} from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import {
  makeShellSearch,
  resolveShellOAuthSearchResourceTypes,
  ShellResourceServicesFactory,
} from '../../api/modules/shell-resources.ts';
import { ShellSystemSearch } from '../../api/modules/shell-system-search.ts';
import { ShellSearchResponseSchema } from '../../shared/browser-api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { connectionDescription } from './mcp/fixture-vertical.ts';
import { retainedGrant } from './oauth-connections/grant-registry-fixture.ts';

const alpha = 'admission.alpha';
const beta = 'admission.beta';
const alphaType = `${alpha}.record`;
const betaType = `${beta}.record`;
const peopleType = 'core.identity.person';
const correlationId = 'governed-oauth-business-search';
const neverCalled = () => Effect.die('Refused OAuth search reached a private provider or unexpected operation');

const contract = (moduleId: string, resourceType: string) => ({
  deployment: { appId: moduleId.replace('.', '-'), buildMarker: 'oauth-host-admission' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: 'Admission fixture',
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
      resourceTypes: [
        {
          capabilities: {
            graphVisible: false,
            linkable: true,
            mediaAttachable: false,
            searchable: true,
            timelineVisible: false,
          },
          description: 'Current owner record',
          key: resourceType,
          label: resourceType,
          owningModuleId: moduleId,
        },
      ],
      search: [
        { accessFiltering: 'resource_permission', key: `${moduleId}.search`, owningModuleId: moduleId, resourceType },
      ],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [
          {
            accessDeclaration: {
              key: `${moduleId}.records.read`,
              kind: 'read',
              modes: ['run'],
              placement: { group: 'records', level: 'basic' },
              risk: 'routine',
              selectors: [],
            },
            contributionKey: `${moduleId}.search.contribution`,
            entrypoint: {
              access: 'read',
              authorization: { kind: 'protected' },
              entrypointKey: `${moduleId}.search`,
              moduleKey: moduleId,
              role: 'search',
              scope: 'tenant',
            },
            searchKey: `${moduleId}.search`,
          },
        ],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

interface HostControls {
  deniedModules: readonly string[];
  malformedModuleDecisions: boolean;
  recordAllowed: boolean;
  states: readonly TenantModuleStateRecord[];
}
type SearchRequest = Parameters<ShellGovernedReadsService['search']>[0];
interface HostCalls {
  assertions: string[];
  providers: string[];
  selectors: (readonly string[] | undefined)[];
  system: number;
}
const hit = (moduleId: string) =>
  Schema.decodeUnknownSync(ShellSearchResponseSchema.fields.results.value.members[0])({
    kind: 'resource',
    ref: {
      moduleId,
      resourceId: `${moduleId}-current-owner-record`,
      resourceType: `${moduleId}.record`,
      tenantId: retainedGrant.tenantId,
    },
    relevance: { score: 850, version: '1' },
    selectedLegalEntityId: retainedGrant.legalEntityId,
    title: `${moduleId} Kotel`,
  });

/** Real Core lifecycle with scripted SQL/permissions, not a live credential, PostgreSQL, SpiceDB or issuer proof. */
const fixture = Effect.fn('OAuthHostAdmission.fixture')(function* fixture(
  modules: readonly string[] | 'all' = [alpha],
  ownerAuthorization: ContextAccessDecision = 'allowed',
) {
  const catalog = yield* makeInstalledModuleCatalogLoader(
    makeCompositionSnapshot([contract(alpha, alphaType), contract(beta, betaType)]),
  );
  const description = connectionDescription({
    acting: { displayName: 'Jana Testerová', kind: 'human', principalId: retainedGrant.actingPrincipalId },
    client: {
      clientId: retainedGrant.clientId,
      host: retainedGrant.clientHost,
      kind: retainedGrant.clientKind,
      logoUri: null,
      name: retainedGrant.clientName,
    },
    compositionRevision: catalog.composition.revision,
    grantId: retainedGrant.grantId,
    legalEntityId: retainedGrant.legalEntityId,
    modules: (modules === 'all' ? [alpha, beta] : modules).map((moduleId) => ({
      label: moduleId,
      moduleId,
      read: true,
      write: false,
    })),
    profileId: retainedGrant.profileId,
    tenantId: retainedGrant.tenantId,
    writePolicy: 'read_only',
  });
  const bridge = connectionPrincipalContext({ description, grant: toGrantRow(retainedGrant) });
  // `all` is a supported existing verified-principal wire shape. It is a fixture input to the real Core resolver,
  // never a production principal rewrite, signed credential, or business/system authority added by the host.
  const principal =
    modules === 'all'
      ? yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          ...bridge,
          connection: { ...bridge.connection, modules: 'all' },
        })
      : bridge;
  const controls: HostControls = {
    deniedModules: [],
    malformedModuleDecisions: false,
    recordAllowed: true,
    states: [
      { moduleKey: alpha, state: 'active' },
      { moduleKey: beta, state: 'active' },
    ],
  };
  const calls: HostCalls = { assertions: [], providers: [], selectors: [], system: 0 };
  let harness = yield* makeReadTestHarness({
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: neverCalled,
    operationTime: new Date('2026-11-03T15:00:00Z'),
    ownerAuthorizationDecision: ownerAuthorization,
    permissionDecision: 'allowed',
    scope: { ...principal, correlationId },
  });
  const nativeAccess = yield* ContextAccess.pipe(Effect.provide(harness.layer));
  const access: ContextAccessService = {
    ...nativeAccess,
    modules: ({ moduleIds }) =>
      Effect.succeed(
        (controls.malformedModuleDecisions ? moduleIds.slice(1) : moduleIds).map((key) => ({
          decision: controls.deniedModules.includes(key) ? 'denied' : 'allowed',
          key,
        })),
      ),
    resources: ({ resources }) =>
      Effect.succeed(
        resources.map((ref) => ({
          decision: controls.recordAllowed ? 'allowed' : 'denied',
          key: `${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`,
        })),
      ),
  };
  const moduleStates = {
    getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
      Effect.succeed(controls.states.filter(({ moduleKey }) => moduleIds.includes(moduleKey))),
    listActiveTenantModules: neverCalled,
    listTenantModuleStates: neverCalled,
  };
  const factory = {
    createResourceDetail: (yield* ShellResourceServicesFactory).createResourceDetail,
    createSearch: (...args: Parameters<typeof makeShellSearch>) => {
      const actual = makeShellSearch(...args);
      return {
        search: (context: Parameters<typeof actual.search>[0], request: Parameters<typeof actual.search>[1]) => {
          calls.selectors.push(Schema.is(Schema.String)(request) ? undefined : request.resourceTypes);
          return actual.search(context, request);
        },
      };
    },
  };
  const issuer = {
    issueAssertion: ({
      appId,
      compositionRevision,
      context,
    }: Parameters<Parameters<typeof createShellGovernedReadDefinitionsLayer>[1]['issueAssertion']>[0]) => {
      calls.assertions.push(appId);
      expect(compositionRevision).toBe(catalog.composition.revision);
      expect(context).toEqual({ ...principal, correlationId });
      return Effect.succeed('issuer-port-fixture');
    },
  };
  const gateways = {
    resource: { detail: neverCalled, timeline: neverCalled },
    search: {
      search: ({ appId }: { readonly appId: string }) => {
        calls.providers.push(appId);
        const { kind: _kind, ...wire } = hit(appId === 'admission-alpha' ? alpha : beta);
        return Effect.succeed(controls.recordAllowed ? [wire] : []);
      },
    },
  };
  const gate = makeTestAccessDecision({
    get answers() {
      return Object.fromEntries(
        [alpha, beta].map((moduleId) => [
          `${moduleId}.records.read`,
          { outcome: controls.deniedModules.includes(moduleId) ? ('DENIED' as const) : ('ALLOWED' as const) },
        ]),
      );
    },
  });
  const hostGate = {
    ...gate,
    decideMany: (questions: Parameters<typeof gate.decideMany>[0]) =>
      gate.decideMany(controls.malformedModuleDecisions ? questions.slice(1) : questions),
  };
  const definitionsLayer = createShellGovernedReadDefinitionsLayer(gateways, issuer, () => moduleStates).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ReadRuntime, harness.runtime),
        Layer.succeed(AccessDecisionGate, hostGate),
        Layer.succeed(ContextAccess, access),
        Layer.succeed(TenantModuleStateService, moduleStates),
        ShellCompositionFactoryLive,
        Layer.succeed(ShellResourceServicesFactory, factory),
        Layer.succeed(ShellSystemSearch, {
          search: () => {
            calls.system += 1;
            return Effect.succeed({ partial: false, results: [] });
          },
        }),
      ),
    ),
  );
  const registrations = yield* ShellGovernedReadDefinitions.pipe(Effect.provide(definitionsLayer));
  harness = yield* makeReadTestHarness({
    access: 'allowed',
    applicationComposition: { load: makeCompositionSnapshot(catalog.contracts) },
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: () => Effect.die('Unexpected Shell owner SQL'),
    expectedDeployment: catalog.composition.shell.deployment,
    operationTime: new Date('2026-11-03T15:00:00Z'),
    ownerAuthorizationDecision: ownerAuthorization,
    scope: { ...principal, correlationId },
    shellSystemReads: registrations,
  });
  const layer = createShellGovernedReadsLayer(registrations).pipe(
    Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
  );
  const reads = yield* ShellGovernedReads.pipe(Effect.provide(layer));
  const run = (overrides: Partial<SearchRequest> = {}) =>
    reads
      .search({
        compositionRevision: catalog.composition.revision,
        correlationId,
        principal,
        query: 'Kotel',
        ...overrides,
      })
      .pipe(
        Effect.provideService(CapturedShellCompositionCatalog, catalog),
        Effect.provide(staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId])),
      );
  const direct = makeShellSearch(
    { access: hostGate, catalog: Effect.succeed(catalog), ...issuer, moduleStates },
    gateways.search,
  );
  return { calls, catalog, controls, direct, harness, hit, principal, run };
});
const emptyPresentation = (catalog: Effect.Success<ReturnType<typeof fixture>>['catalog']) => ({
  business: { compositionRevision: catalog.composition.revision, entries: [], schemaVersion: '1' },
  pages: [],
});
const withRuntime = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.scoped, Effect.provide(ShellCryptoLive));
const expectNoDispatch = (calls: Effect.Success<ReturnType<typeof fixture>>['calls']) => {
  expect(calls.assertions).toEqual([]);
  expect(calls.providers).toEqual([]);
  expect(calls.system).toBe(0);
};

describe('host OAuth business-provider admission', () => {
  it.effect(
    'real ReadRuntime routes business-only OAuth search with explicit admitted selectors, unchanged identity and authorized full records',
    () =>
      withRuntime(
        Effect.gen(function* authorized() {
          const f = yield* fixture();
          expect(yield* f.run()).toEqual({
            partial: false,
            presentation: emptyPresentation(f.catalog),
            results: [f.hit(alpha)],
          });
          expect(f.calls.selectors).toEqual([[alphaType]]);
          expect(f.calls.assertions).toEqual(['admission-alpha']);
          expect(f.calls.providers).toEqual(['admission-alpha']);
          expect(f.calls.system).toBe(0);
          expect(f.harness.snapshot().evidenceWrites).toBe(1);
        }),
      ),
  );

  it.effect('verified connection.modules=all remains business-only in the governed system branch', () =>
    withRuntime(
      Effect.gen(function* allBusiness() {
        const f = yield* fixture('all');
        expect((yield* f.run()).results).toEqual([f.hit(alpha), f.hit(beta)]);
        expect(f.calls.selectors).toEqual([[alphaType, betaType]]);
        expect(f.calls.system).toBe(0);
      }),
    ),
  );

  it.effect(
    'unknown, ungranted, mixed and explicit system-People selectors refuse before any issuer/provider/system dispatch',
    () =>
      withRuntime(
        Effect.gen(function* refusedSelectors() {
          for (const resourceTypes of [
            [betaType],
            ['unknown.record'],
            [alphaType, betaType],
            [peopleType],
            [alphaType, peopleType],
          ]) {
            const f = yield* fixture();
            expect(Result.isFailure(yield* f.run({ resourceTypes }).pipe(Effect.result))).toBe(true);
            expectNoDispatch(f.calls);
          }
          const all = yield* fixture('all');
          expect(Result.isFailure(yield* all.run({ resourceTypes: [peopleType] }).pipe(Effect.result))).toBe(true);
          expectNoDispatch(all.calls);
        }),
      ),
  );

  it.effect('absent connection, empty grants and malformed authority are refused by the actual Core lifecycle', () =>
    withRuntime(
      Effect.gen(function* invalidAuthority() {
        const empty = yield* fixture([]);
        expect(Result.isFailure(yield* empty.run().pipe(Effect.result))).toBe(true);
        expectNoDispatch(empty.calls);
        const f = yield* fixture();
        const { connection: _connection, ...missing } = f.principal;
        for (const principal of [missing, { ...f.principal, authBindingId: 'malformed-binding' }]) {
          expect(Result.isFailure(yield* f.run({ principal }).pipe(Effect.result))).toBe(true);
        }
        expectNoDispatch(f.calls);
      }),
    ),
  );

  it.effect(
    'unresolved grants, missing/inactive committed states and an explicit empty selector never become an unrestricted fallback',
    () =>
      withRuntime(
        Effect.gen(function* emptyAdmission() {
          const unresolved = yield* fixture(['not.composed']);
          expect(yield* unresolved.run()).toEqual({ partial: false, results: [] });
          expectNoDispatch(unresolved.calls);
          for (const states of [[], [{ moduleKey: alpha, state: 'inactive' as const }]]) {
            const f = yield* fixture();
            f.controls.states = states;
            expect(yield* f.run()).toEqual({ partial: false, results: [] });
            expectNoDispatch(f.calls);
          }
          const f = yield* fixture();
          // An explicit empty selector returns the granted, admitted inventory with no owner dispatch, never a fallback.
          expect(yield* f.run({ resourceTypes: [] })).toEqual({
            partial: false,
            presentation: emptyPresentation(f.catalog),
            results: [],
          });
          expectNoDispatch(f.calls);
        }),
      ),
  );

  it.effect(
    'canonical module revocation and indeterminate permission evidence still stop assertions before owner dispatch',
    () =>
      withRuntime(
        Effect.gen(function* canonicalGates() {
          const denied = yield* fixture();
          denied.controls.deniedModules = [alpha];
          expect(yield* denied.run()).toEqual({
            partial: false,
            presentation: emptyPresentation(denied.catalog),
            results: [],
          });
          expectNoDispatch(denied.calls);
          const uncertain = yield* fixture();
          uncertain.controls.malformedModuleDecisions = true;
          expect(Result.isFailure(yield* uncertain.run().pipe(Effect.result))).toBe(true);
          expectNoDispatch(uncertain.calls);
        }),
      ),
  );

  it.effect('wrong tenant/principal or composition cannot dispatch through the actual scope and captured release', () =>
    withRuntime(
      Effect.gen(function* contextMismatch() {
        const f = yield* fixture();
        for (const principal of [
          { ...f.principal, tenantId: '00000000-0000-4000-8000-000000000099' },
          { ...f.principal, principalId: '00000000-0000-4000-8000-000000000099' },
        ]) {
          expect(Result.isFailure(yield* f.run({ principal }).pipe(Effect.result))).toBe(true);
        }
        expect(Result.isFailure(yield* f.run({ compositionRevision: 'a'.repeat(64) }).pipe(Effect.result))).toBe(true);
        expectNoDispatch(f.calls);
      }),
    ),
  );

  it.effect('Core owner-local authorization remains mandatory after exact routing admission', () =>
    withRuntime(
      Effect.gen(function* ownerDenial() {
        const f = yield* fixture([alpha], 'denied');
        expect(Result.isFailure(yield* f.run().pipe(Effect.result))).toBe(true);
        expectNoDispatch(f.calls);
      }),
    ),
  );

  it.effect('current owner authorization is retained after host routing admission', () =>
    withRuntime(
      Effect.gen(function* currentOwner() {
        const f = yield* fixture();
        f.controls.recordAllowed = false;
        expect(yield* f.run()).toEqual({ partial: false, presentation: emptyPresentation(f.catalog), results: [] });
        expect(f.calls.providers).toEqual(['admission-alpha']);
        expect(f.calls.system).toBe(0);
      }),
    ),
  );

  it.effect(
    'the direct host orchestrator enforces OAuth grants independently of the MCP adapter and governed wrapper',
    () =>
      withRuntime(
        Effect.gen(function* directHost() {
          const f = yield* fixture();
          const context = { ...f.principal, correlationId };
          expect(yield* f.direct.search(context, { query: 'Kotel' })).toEqual({
            partial: false,
            presentation: emptyPresentation(f.catalog),
            results: [f.hit(alpha)],
          });
          expect(f.calls.providers).toEqual(['admission-alpha']);
          const refused = yield* fixture();
          for (const resourceTypes of [[betaType], [peopleType], ['unknown.record']]) {
            expect(
              Result.isFailure(
                yield* refused.direct
                  .search({ ...refused.principal, correlationId }, { query: 'Kotel', resourceTypes })
                  .pipe(Effect.result),
              ),
            ).toBe(true);
          }
          expectNoDispatch(refused.calls);
        }),
      ),
  );

  it.effect('host admission never truncates a broad business grant to the selector or typed-tool budget', () =>
    withRuntime(
      Effect.gen(function* completeHostAdmission() {
        const owners = Array.from({ length: 65 }, (_unused, index) => ({
          moduleId: `budget.owner${index}`,
          resourceType: `budget.owner${index}.record`,
        }));
        const catalog = yield* makeInstalledModuleCatalogLoader(
          makeCompositionSnapshot(owners.map(({ moduleId, resourceType }) => contract(moduleId, resourceType))),
        );
        const states = owners.map(({ moduleId: moduleKey }) => ({ moduleKey, state: 'active' as const }));
        const f = yield* fixture('all');
        const scope = { ...f.principal, correlationId };
        expect(
          Result.isFailure(
            yield* resolveShellOAuthSearchResourceTypes(scope, { query: 'record' }, catalog, states).pipe(
              Effect.result,
            ),
          ),
        ).toBe(true);
        const last = yield* Effect.fromNullishOr(owners.at(-1));
        expect(
          yield* resolveShellOAuthSearchResourceTypes(
            scope,
            { query: 'record', resourceTypes: [last.resourceType] },
            catalog,
            states,
          ),
        ).toEqual([last.resourceType]);
        expectNoDispatch(f.calls);
      }),
    ),
  );

  it.effect(
    'admission sees committed states and rejects malformed/truncated ownership inputs without issuing assertions',
    () =>
      withRuntime(
        Effect.gen(function* committedAdmission() {
          const f = yield* fixture();
          const duplicate = [
            { moduleKey: alpha, state: 'active' as const },
            { moduleKey: alpha, state: 'active' as const },
          ];
          expect(
            Result.isFailure(
              yield* resolveShellOAuthSearchResourceTypes(
                { ...f.principal, correlationId },
                { query: 'Kotel' },
                f.catalog,
                duplicate,
              ).pipe(Effect.result),
            ),
          ).toBe(true);
          expectNoDispatch(f.calls);
        }),
      ),
  );
});
