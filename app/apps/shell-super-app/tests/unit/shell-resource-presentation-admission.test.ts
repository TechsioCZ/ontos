// @rstest-environment node
import {
  ContextAccess,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadRuntime,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ContextAccessService } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Effect, Layer, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { CapturedShellCompositionCatalog } from '../../api/modules/captured-shell-catalog.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import { ShellGovernedReadDefinitions } from '../../api/modules/shell-governed-read-definitions.ts';
import {
  createShellGovernedReadDefinitionsLayer,
  createShellGovernedReadsLayer,
  ShellGovernedReads,
} from '../../api/modules/shell-governed-reads.ts';
import { ShellResourceServicesFactoryLive } from '../../api/modules/shell-resources.ts';
import { ResourceRefSchema } from '../../shared/browser-api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const ownerModuleId = 'sample.records';
const resourceType = 'sample.records.record';
const detailKey = 'sample.records.detail.read';
const searchKey = 'sample.records.search';
const searchAccessKey = 'sample.records.search.read';
const pageKey = 'sample.records.page';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const correlationId = 'resource-presentation-admission';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:resource-presentation',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
});
const ref = Schema.decodeUnknownSync(ResourceRefSchema)({
  moduleId: ownerModuleId,
  resourceId: 'record-1',
  resourceType,
});
const neverCalled = () => Effect.die('Presentation admission reached a provider or legacy ContextAccess');
const legacyAccess: ContextAccessService = {
  legalEntities: neverCalled,
  modules: neverCalled,
  resources: neverCalled,
  tenants: neverCalled,
};
const declaration = (key: string, selectorBearing = false) => ({
  key,
  kind: 'read' as const,
  modes: ['run'] as const,
  placement: { group: 'records', level: 'basic' as const },
  risk: 'routine' as const,
  selectors: selectorBearing ? (['all'] as const) : [],
});
const entrypoint = (role: 'api' | 'page' | 'search', key: string) => ({
  access: 'read',
  authorization: { kind: 'protected' },
  entrypointKey: key,
  moduleKey: ownerModuleId,
  role,
  scope: 'tenant',
});
const contract = (selectorBearing: boolean) => ({
  deployment: { appId: 'sample-records', buildMarker: 'resource-presentation-test' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active'],
    },
    module: {
      description: 'Resource presentation admission fixture.',
      displayName: 'Records',
      id: ownerModuleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [{ key: 'sample.records.api', operationKeys: ['detail'] }],
      components: [{ expose: './Record', key: 'sample.records.component', mfBoundaryId: 'sampleRecords' }],
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
          description: 'Record',
          key: resourceType,
          label: 'Record',
          owningModuleId: ownerModuleId,
        },
      ],
      search: [
        {
          accessFiltering: 'resource_permission',
          key: searchKey,
          legalEntityScope: 'required',
          owningModuleId: ownerModuleId,
          resourceType,
        },
      ],
      shellContributions: {
        mediaAttachments: [],
        navigation: [],
        pages: [
          {
            accessDeclaration: declaration('sample.records.page.read'),
            componentKey: 'sample.records.component',
            contributionKey: pageKey,
            entrypoint: entrypoint('page', pageKey),
            expose: './Record',
            routePath: '/sample/records/:recordId',
          },
        ],
        publicComponents: [],
        reports: [],
        resourceDetails: [
          {
            accessDeclaration: declaration(detailKey),
            apiKey: 'sample.records.api',
            contributionKey: 'sample.records.detail',
            entrypoint: entrypoint('api', 'sample.records.detail'),
            resourceType,
          },
        ],
        search: [
          {
            accessDeclaration: declaration(searchAccessKey, selectorBearing),
            contributionKey: 'sample.records.search.contribution',
            entrypoint: entrypoint('search', searchKey),
            presentation: {
              family: { icon: 'icon-[mdi--folder]', key: 'work', label: { cs: 'Práce', en: 'Work' }, order: 1 },
              group: { icon: 'icon-[mdi--file]', key: 'record', label: { cs: 'Záznamy', en: 'Records' }, order: 1 },
              record: {
                pageKey,
                selector: { idEncoding: 'native', idFormat: 'opaque', kind: 'path', parameterName: 'recordId' },
              },
              scope: 'company',
            },
            searchKey,
          },
        ],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

/** Actual Shell registration and Core Read lifecycle, with only authority and transport I/O scripted. */
const runResource = Effect.fn('ResourcePresentationTest.run')(
  function* runResource(selectorBearing: boolean, answer: TestGateAnswer, detailAllowed = true) {
    const snapshot = yield* makeCompositionSnapshot([contract(selectorBearing)]);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const access = makeTestAccessDecision({
      answers: {
        [detailKey]: { outcome: detailAllowed === true ? 'ALLOWED' : 'DENIED' },
        [searchAccessKey]: answer,
      },
    });
    const calls = { assertions: 0, detail: 0 };
    const states = {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(moduleIds.map((moduleKey) => ({ moduleKey, state: 'active' as const }))),
      listActiveTenantModules: neverCalled,
      listTenantModuleStates: neverCalled,
    };
    const definitionsLayer = createShellGovernedReadDefinitionsLayer(
      {
        resource: {
          detail: () => {
            calls.detail += 1;
            return Effect.succeed({ fields: [], title: 'Private record detail' });
          },
          timeline: neverCalled,
        },
        search: { search: neverCalled },
      },
      {
        issueAssertion: () => {
          calls.assertions += 1;
          return Effect.succeed('Bearer resource-detail-fixture');
        },
      },
      () => states,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AccessDecisionGate, access),
          Layer.succeed(ContextAccess, legacyAccess),
          Layer.succeed(TenantModuleStateService, states),
          ShellCompositionFactoryLive,
          ShellResourceServicesFactoryLive,
        ),
      ),
    );
    const registrations = yield* ShellGovernedReadDefinitions.pipe(Effect.provide(definitionsLayer));
    const harness = yield* makeReadTestHarness({
      access: 'allowed',
      applicationComposition: { load: Effect.succeed(snapshot) },
      compositionRevision: catalog.composition.revision,
      executeOwnerQuery: neverCalled,
      expectedDeployment: catalog.composition.shell.deployment,
      operationTime: new Date('2026-11-07T04:00:00Z'),
      ownerAuthorizationDecision: 'allowed',
      scope: { ...principal, correlationId },
      shellSystemReads: registrations,
    });
    const reads = yield* ShellGovernedReads.pipe(
      Effect.provide(
        createShellGovernedReadsLayer(registrations).pipe(Layer.provide(Layer.succeed(ReadRuntime, harness.runtime))),
      ),
    );
    const result = yield* reads
      .resourceDetail({ correlationId, principal, ref })
      .pipe(
        Effect.provideService(CapturedShellCompositionCatalog, catalog),
        Effect.provide(
          staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId]).pipe(Layer.orDie),
        ),
        Effect.result,
      );
    return { access, calls, lifecycle: harness.snapshot(), result };
  },
  Effect.scoped,
  Effect.provide(ShellCryptoLive),
);

for (const selectorBearing of [false, true]) {
  const mode = selectorBearing ? 'selector-bearing LIST' : 'scope-wide decision';
  it.effect(`admits resource presentation through the published ${mode} carrier`, () =>
    Effect.gen(function* admittedPresentation() {
      const { access, calls, lifecycle, result } = yield* runResource(selectorBearing, { outcome: 'ALLOWED' });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success.presentation?.business.entries).toMatchObject([
          { ownerModuleId, resourceType, searchKey },
        ]);
        expect(result.success.presentation?.pages).toEqual([
          { ownerModuleId, pageKey, routePath: '/sample/records/:recordId' },
        ]);
      }
      const decisions = access.askedDecisions.filter(
        ({ carrier }) => carrier.accessDeclaration?.key === searchAccessKey,
      );
      expect(decisions).toHaveLength(selectorBearing ? 0 : 1);
      expect(access.askedLists).toHaveLength(selectorBearing ? 1 : 0);
      const question = selectorBearing ? access.askedLists[0] : decisions[0];
      expect(question?.carrier.accessDeclaration?.selectors).toEqual(selectorBearing ? ['all'] : []);
      expect(question?.legalEntityScope).toBe('required');
      expect(question?.scope).toMatchObject({ ...principal, correlationId });
      expect(calls).toEqual({ assertions: 1, detail: 1 });
      expect(lifecycle.ownerQueries).toEqual([]);
      expect(lifecycle.evidenceWrites).toBeGreaterThan(0);
      expect(lifecycle.statements.some((statement) => statement.toLowerCase() === 'commit')).toBe(true);
    }),
  );

  it.effect(`omits denied ${mode} presentation without dispatching its search provider`, () =>
    Effect.gen(function* deniedPresentation() {
      const { calls, result } = yield* runResource(selectorBearing, { outcome: 'DENIED' });
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success).toMatchObject({ detail: { fields: [], title: 'Private record detail' } });
        expect(result.success.presentation?.business.entries).toEqual([]);
        expect(result.success.presentation?.pages).toEqual([]);
      }
      expect(calls).toEqual({ assertions: 1, detail: 1 });
    }),
  );

  it.effect(`fails unavailable ${mode} presentation in the typed channel without disclosing the detail`, () =>
    Effect.gen(function* unavailablePresentation() {
      const { calls, result } = yield* runResource(selectorBearing, { outcome: 'UNAVAILABLE' });
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(Schema.is(ReadHandlerUnavailable)(result.failure)).toBe(true);
        expect(JSON.stringify(result.failure)).not.toContain('Private record detail');
      }
      // Detail resolution precedes presentation admission; no additional search provider/assertion may run.
      expect(calls).toEqual({ assertions: 1, detail: 1 });
    }),
  );
}

it.effect('denies the detail before any provider, assertion or presentation admission', () =>
  Effect.gen(function* deniedDetail() {
    const { access, calls, result } = yield* runResource(true, { outcome: 'ALLOWED' }, false);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.is(ReadPermissionDenied)(result.failure)).toBe(true);
    }
    expect(calls).toEqual({ assertions: 0, detail: 0 });
    expect(access.askedLists).toEqual([]);
    expect(access.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([detailKey]);
  }),
);
