import { makeShellTestAccessGate } from '../support/access-decision-double.ts';
import { ShellResourceServicesFactoryLive } from '../../api/modules/shell-resources.ts';
import { ShellGovernedReadDefinitions } from '../../api/modules/shell-governed-read-definitions.ts';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
// @rstest-environment node
import {
  ContextAccess,
  LegalEntityContext,
  ReadHandlerNotFound,
  ReadPermissionDenied,
  ReadRuntime,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ContextAccessDecision, ContextAccessService, TenantModuleStateRecord } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';
import { Effect, Exit, Layer, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { describe, expect, it, rs } from 'effect-rstest';

import { ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { AuthenticationService } from '../../api/auth/service.ts';
import type { ShellContextResult } from '../../api/auth/service.ts';
import { resolveModuleTargetHandler } from '../../api/index.ts';
import { CapturedShellCompositionCatalog } from '../../api/modules/captured-shell-catalog.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import {
  createShellGovernedReadsLayer,
  createShellGovernedReadDefinitionsLayer,
  ShellGovernedReads,
} from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ResolvedModuleTargetSchema, ResolveModuleTargetPayloadSchema } from '../../shared/browser-api.ts';
import type { ResolveModuleTargetPayload } from '../../shared/browser-api.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import { makeContextAccessDouble } from '../support/context-access-double.ts';
import { makeAuthenticationServiceDouble } from '../support/impersonation-service-doubles.ts';
import { tenantModuleTargetTestCarrier } from '../support/tenant-module-target-carrier.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const moduleId = 'property.registry';
const optedInPageKey = `${moduleId}.page.dashboard`;
const requiredPageKey = `${moduleId}.page.required`;
const correlationId = 'tenant-module-target';
const neverCalled = () => Effect.die('A refused tenant target reached a private provider or unexpected operation');

const tenantPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'session:tenant-target',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
  authMethod: 'session',
  principalId,
  tenantId,
});
const companyPrincipal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  ...tenantPrincipal,
  authContextRef: 'session:company-target',
  legalEntityId,
});
const tenantIdentity = {
  displayName: 'Tenant user',
  email: 'tenant@example.test',
  principalId,
  tenantId,
};
const tenantSession: ShellContextResult = {
  availableLegalEntities: [{ legalEntityId, legalName: 'Property company' }],
  identity: tenantIdentity,
  principal: tenantPrincipal,
  setCookieHeaders: [],
  state: 'tenant_authenticated',
};
const companySession: ShellContextResult = {
  availableLegalEntities: [{ legalEntityId, legalName: 'Property company' }],
  identity: { ...tenantIdentity, legalEntityId, legalName: 'Property company' },
  principal: companyPrincipal,
  setCookieHeaders: [],
  state: 'authenticated',
};
const request = { headers: { cookie: 'session=tenant-target', 'x-correlation-id': correlationId } };

const pageAccess = (key: string) => ({
  key,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'pages', level: 'basic' },
  risk: 'routine',
  selectors: [],
});
const pageEntrypoint = (pageKey: string) => ({
  access: 'read' as const,
  authorization: { kind: 'protected' as const },
  entrypointKey: pageKey,
  moduleKey: moduleId,
  role: 'page' as const,
  scope: 'tenant' as const,
});

/** One owner module with an explicitly opted-in page and a page that keeps the company requirement. */
const contract = () => ({
  deployment: { appId: 'property-registry', buildMarker: 'tenant-target' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: 'Property capability.',
      displayName: 'Property',
      id: moduleId,
      implementedAs: 'ultramodern_microvertical',
      kind: 'business_module',
    },
    publicSurface: {
      actions: [],
      api: [],
      components: [
        { expose: './Dashboard', key: `${moduleId}.dashboard`, mfBoundaryId: 'verticalPropertyRegistry' },
        { expose: './Required', key: `${moduleId}.required`, mfBoundaryId: 'verticalPropertyRegistry' },
      ],
      events: [],
      reports: [],
      resourceTypes: [],
      search: [],
      shellContributions: {
        mediaAttachments: [],
        // A real module's landing selector resolves through its first navigation entry, so the fixture declares one
        // (mirroring production manifests) instead of an empty navigation that would make `{ moduleId }` a not-found.
        navigation: [
          {
            accessDeclaration: pageAccess(`${optedInPageKey}.read`),
            contributionKey: `${moduleId}.navigation.dashboard`,
            entrypoint: pageEntrypoint(optedInPageKey),
            groupKey: 'shell.navigation.modules',
            icon: 'icon-[mdi--view-dashboard-outline]',
            label: { cs: 'Přehled', en: 'Dashboard' },
            order: 10,
            pageKey: optedInPageKey,
          },
        ],
        pages: [
          {
            accessDeclaration: pageAccess(`${optedInPageKey}.read`),
            componentKey: `${moduleId}.dashboard`,
            contributionKey: optedInPageKey,
            entrypoint: pageEntrypoint(optedInPageKey),
            expose: './Dashboard',
            legalEntityScope: 'optional' as const,
            routePath: '/property-dashboard',
          },
          {
            accessDeclaration: pageAccess(`${requiredPageKey}.read`),
            componentKey: `${moduleId}.required`,
            contributionKey: requiredPageKey,
            entrypoint: pageEntrypoint(requiredPageKey),
            expose: './Required',
            routePath: '/property-required',
          },
        ],
        publicComponents: [],
        reports: [],
        resourceDetails: [],
        search: [],
        timelines: [],
      },
    },
  },
  runtime: { outboxSubscriptions: [] },
  schemaVersion: '2',
});

interface Controls {
  modulePermission: ContextAccessDecision;
  states: readonly TenantModuleStateRecord[];
}
interface Calls {
  companyModules: string[];
  contextPermissions: { readonly moduleId: string; readonly permission: string }[];
  legalEntities: string[];
  tenantAccess: string[];
}

/** A plain-string target selector, decoded to the branded payload at the read boundary. */
interface TargetSelectorInput {
  readonly canonicalPath?: string;
  readonly compositionRevision?: string;
  readonly entrypointKey?: string;
  readonly moduleId?: string;
}
const targetPayload = (input: TargetSelectorInput): ResolveModuleTargetPayload =>
  Schema.decodeUnknownSync(ResolveModuleTargetPayloadSchema)(input);

/** A resolved browser target decoded through the canonical schema, so its identifiers are the branded types. */
const resolvedTarget = (compositionRevision: string, componentKey: string, entrypointKey: string) =>
  Schema.decodeUnknownSync(ResolvedModuleTargetSchema)({
    appId: 'property-registry',
    componentKey,
    compositionRevision,
    entrypointKey,
    federation: {
      expose: './Dashboard',
      manifest: { sha256: 'a'.repeat(64), url: 'https://assets.example.test/property/mf-manifest.json' },
      remoteName: 'verticalPropertyRegistry',
    },
    moduleId,
    routeParameters: {},
    writable: true,
  });

/** Real Core Read lifecycle with scripted SQL/permissions; only SpiceDB and the owner transport are doubled. */
const fixture = Effect.fn('TenantModuleTarget.fixture')(function* fixture(controls: Controls) {
  const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract()]));
  let harness = yield* makeReadTestHarness({
    compositionRevision: catalog.composition.revision,
    executeOwnerQuery: neverCalled,
    operationTime: new Date('2026-11-03T15:00:00Z'),
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope: { ...tenantPrincipal, correlationId },
  });
  const calls: Calls = { companyModules: [], contextPermissions: [], legalEntities: [], tenantAccess: [] };
  const nativeAccess = yield* ContextAccess.pipe(Effect.provide(harness.layer));
  const access: ContextAccessService = {
    ...nativeAccess,
    contextPermissions: ({ targets }) => {
      calls.contextPermissions.push(...targets);
      return Effect.succeed(
        targets.map((target) => ({
          decision: controls.modulePermission,
          key: `${target.moduleId}:${target.permission}`,
        })),
      );
    },
    legalEntities: ({ legalEntityIds }) => {
      calls.legalEntities.push(...legalEntityIds);
      return Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key })));
    },
    modules: ({ moduleIds }) => {
      calls.companyModules.push(...moduleIds);
      return Effect.succeed(moduleIds.map((key) => ({ decision: controls.modulePermission, key })));
    },
    tenants: ({ permission, tenantIds }) => {
      calls.tenantAccess.push(permission);
      return Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key })));
    },
  };
  const moduleStates = {
    getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
      Effect.succeed(controls.states.filter(({ moduleKey }) => moduleIds.includes(moduleKey))),
    listActiveTenantModules: neverCalled,
    listTenantModuleStates: neverCalled,
  };
  const gate = makeShellTestAccessGate({
    answers: {
      [`${optedInPageKey}.read`]: controls.modulePermission,
      [`${requiredPageKey}.read`]: controls.modulePermission,
    },
  });
  const definitionsLayer = createShellGovernedReadDefinitionsLayer(
    { resource: { detail: neverCalled, timeline: neverCalled }, search: { search: neverCalled } },
    { issueAssertion: neverCalled },
    () => moduleStates,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ReadRuntime, harness.runtime),
        Layer.succeed(AccessDecisionGate, gate),
        Layer.succeed(ContextAccess, access),
        Layer.succeed(TenantModuleStateService, moduleStates),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        ShellCompositionFactoryLive,
        ShellResourceServicesFactoryLive,
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
    ownerAuthorizationDecision: 'allowed',
    scope: { ...tenantPrincipal, correlationId },
    shellSystemReads: registrations,
  });
  const layer = createShellGovernedReadsLayer(registrations).pipe(
    Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
  );
  const reads = yield* ShellGovernedReads.pipe(Effect.provide(layer));
  // The real Core scope resolver revalidates the staff namespace, exactly as the deployed runtime does.
  const registry = staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId]);
  const runTenant = (selector: TargetSelectorInput) =>
    reads
      .tenantModuleTarget({
        compositionRevision: catalog.composition.revision,
        correlationId,
        principal: tenantPrincipal,
        ...targetPayload(selector),
      })
      .pipe(Effect.provideService(CapturedShellCompositionCatalog, catalog), Effect.provide(registry));
  const runCompany = (selector: TargetSelectorInput) =>
    reads
      .moduleTarget({
        compositionRevision: catalog.composition.revision,
        correlationId,
        principal: companyPrincipal,
        ...targetPayload(selector),
      })
      .pipe(Effect.provideService(CapturedShellCompositionCatalog, catalog), Effect.provide(registry));
  return { calls, catalog, controls, gate, harness, reads, runCompany, runTenant };
});

describe('tenant-only module target admission', () => {
  it.effect('a verified tenant session with an allowed tenant module permission resolves only the opted-in page', () =>
    Effect.gen(function* optedInAllowed() {
      const f = yield* fixture({ modulePermission: 'allowed', states: [{ moduleKey: moduleId, state: 'active' }] });
      const result = yield* f.runTenant({ moduleId });
      expect(result.state).toBe('resolved');
      const target = result.state === 'resolved' ? result.target : undefined;
      expect(target?.moduleId).toBe(moduleId);
      expect(target?.entrypointKey).toBe(optedInPageKey);
      expect(target?.compositionRevision).toBe(f.catalog.composition.revision);
      // The target module is gated by a genuine tenant context permission, never by a company module decision.
      expect(f.calls.contextPermissions).toEqual([]);
      expect(f.gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
        `${optedInPageKey}.read`,
      ]);
      expect(f.calls.companyModules).toEqual([]);
      expect(f.calls.legalEntities).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect('a denied or indeterminate tenant module permission fails closed without reaching an owner', () =>
    Effect.gen(function* optedInDenied() {
      for (const modulePermission of ['denied', 'unavailable'] as const) {
        const f = yield* fixture({ modulePermission, states: [{ moduleKey: moduleId, state: 'active' }] });
        const exit = yield* f.runTenant({ moduleId }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(f.calls.companyModules).toEqual([]);
        expect(f.calls.legalEntities).toEqual([]);
        expect(f.calls.contextPermissions).toEqual([]);
        expect(f.gate.askedDecisions.map(({ carrier }) => carrier.accessDeclaration?.key)).toEqual([
          `${optedInPageKey}.read`,
        ]);
      }
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect(
    'tenant membership is checked before any module permission, so a denied membership never asks a module',
    () =>
      Effect.gen(function* membershipDenied() {
        const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract()]));
        let harness = yield* makeReadTestHarness({
          compositionRevision: catalog.composition.revision,
          executeOwnerQuery: neverCalled,
          operationTime: new Date('2026-11-03T15:00:00Z'),
          ownerAuthorizationDecision: 'allowed',
          permissionDecision: 'denied',
          scope: { ...tenantPrincipal, correlationId },
        });
        const calls: Calls = { companyModules: [], contextPermissions: [], legalEntities: [], tenantAccess: [] };
        const nativeAccess = yield* ContextAccess.pipe(Effect.provide(harness.layer));
        const access: ContextAccessService = {
          ...nativeAccess,
          contextPermissions: ({ targets }) => {
            calls.contextPermissions.push(...targets);
            return Effect.succeed(
              targets.map((target) => ({
                decision: 'allowed' as const,
                key: `${target.moduleId}:${target.permission}`,
              })),
            );
          },
          modules: ({ moduleIds }) => {
            calls.companyModules.push(...moduleIds);
            return Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key })));
          },
        };
        const moduleStates = {
          getTenantModuleStates: () => Effect.succeed([{ moduleKey: moduleId, state: 'active' as const }]),
          listActiveTenantModules: neverCalled,
          listTenantModuleStates: neverCalled,
        };
        const definitionsLayer = createShellGovernedReadDefinitionsLayer(
          { resource: { detail: neverCalled, timeline: neverCalled }, search: { search: neverCalled } },
          { issueAssertion: neverCalled },
          () => moduleStates,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ReadRuntime, harness.runtime),
              Layer.succeed(AccessDecisionGate, makeTestAccessDecision()),
              Layer.succeed(ContextAccess, access),
              Layer.succeed(TenantModuleStateService, moduleStates),
              Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
              ShellCompositionFactoryLive,
              ShellResourceServicesFactoryLive,
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
          ownerAuthorizationDecision: 'allowed',
          scope: { ...tenantPrincipal, correlationId },
          scopeAccess: 'denied',
          shellSystemReads: registrations,
        });
        const layer = createShellGovernedReadsLayer(registrations).pipe(
          Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
        );
        const reads = yield* ShellGovernedReads.pipe(Effect.provide(layer));
        const exit = yield* reads
          .tenantModuleTarget({
            compositionRevision: catalog.composition.revision,
            correlationId,
            principal: tenantPrincipal,
            ...targetPayload({ moduleId }),
          })
          .pipe(
            Effect.provideService(CapturedShellCompositionCatalog, catalog),
            Effect.provide(staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId])),
            Effect.exit,
          );
        expect(Exit.isFailure(exit)).toBe(true);
        // The tenant `access` decision refused before the composition, so no module permission or owner ran.
        expect(calls.contextPermissions).toEqual([]);
        expect(calls.companyModules).toEqual([]);
        expect(calls.legalEntities).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect('a page without the opt-in stays company-required and never asks a tenant module permission', () =>
    Effect.gen(function* requiredPage() {
      const f = yield* fixture({ modulePermission: 'allowed', states: [{ moduleKey: moduleId, state: 'active' }] });
      expect(yield* f.runTenant({ entrypointKey: requiredPageKey, moduleId })).toEqual({
        state: 'selection_required',
      });
      expect(yield* f.runTenant({ canonicalPath: '/property-required' })).toEqual({ state: 'selection_required' });
      expect(f.calls.contextPermissions).toEqual([]);
      expect(f.calls.companyModules).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect('unknown targets and inactive module lifecycle fail closed without a tenant module permission', () =>
    Effect.gen(function* unknownAndInactive() {
      const unknown = yield* fixture({
        modulePermission: 'allowed',
        states: [{ moduleKey: moduleId, state: 'active' }],
      });
      expect(Exit.isFailure(yield* unknown.runTenant({ moduleId: 'missing.module' }).pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* unknown.runTenant({ canonicalPath: '/missing-route' }).pipe(Effect.exit))).toBe(
        true,
      );
      expect(unknown.calls.contextPermissions).toEqual([]);

      const inactive = yield* fixture({
        modulePermission: 'allowed',
        states: [{ moduleKey: moduleId, state: 'inactive' }],
      });
      const failure = yield* inactive.runTenant({ moduleId }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerNotFound);
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect('a company session on an opted-in page keeps the company Read and module gate and never falls back', () =>
    Effect.gen(function* companyGate() {
      const f = yield* fixture({ modulePermission: 'allowed', states: [{ moduleKey: moduleId, state: 'active' }] });
      const target = yield* f.runCompany({ moduleId });
      expect(target.moduleId).toBe(moduleId);
      // The company path checks the company module permission for the target and the Shell entrypoint module
      // (`core.shell` prefetch), and never the tenant context permission. Exact, order-independent module set.
      expect(f.calls.companyModules).toEqual([]);
      expect(f.gate.askedDecisions.at(-1)?.scope.legalEntityId).toBe(legalEntityId);
      expect(f.calls.contextPermissions).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );

  it.effect('a company session with a denied company module permission fails closed and never falls back', () =>
    Effect.gen(function* companyDenied() {
      const f = yield* fixture({ modulePermission: 'denied', states: [{ moduleKey: moduleId, state: 'active' }] });
      const failure = yield* f.runCompany({ moduleId }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadPermissionDenied);
      expect(f.calls.contextPermissions).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(ShellCryptoLive)),
  );
});

/** The exported HTTP dispatch: tenant sessions take the tenant registration, company sessions the company one. */
const dispatch = Effect.fn('TenantModuleTarget.dispatch')(function* dispatch(
  session: ShellContextResult,
  readModuleTarget: ShellGovernedReadsService['moduleTarget'],
  readTenantModuleTarget: ShellGovernedReadsService['tenantModuleTarget'],
) {
  const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract()]));
  const moduleTarget = rs.fn(readModuleTarget);
  const tenantModuleTarget = rs.fn(readTenantModuleTarget);
  const resolveShellContext = rs.fn(() => Effect.succeed(session));
  const exit = yield* resolveModuleTargetHandler(request, targetPayload({ moduleId })).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(AuthenticationService, makeAuthenticationServiceDouble({ resolveShellContext })),
        Layer.succeed(AccessDecisionGate, makeTestAccessDecision()),
        Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
        Layer.mock(LegalEntityContext, {}),
        Layer.succeed(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://shell.test/shell/module-target', { method: 'POST' })),
        ),
        Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Layer.mock(ShellGovernedReads, {
          moduleTarget,
          tenantModuleTarget,
          tenantModuleTargetCarrier: tenantModuleTargetTestCarrier,
        }),
      ),
    ),
    Effect.exit,
  );
  return { catalog, exit, moduleTarget, resolveShellContext, tenantModuleTarget };
});

describe('resolveModuleTarget dispatch', () => {
  it.effect('routes a tenant session to the tenant-only read and never to the company read', () =>
    Effect.gen(function* tenantDispatch() {
      const { exit, moduleTarget, tenantModuleTarget } = yield* dispatch(tenantSession, neverCalled, (input) =>
        Effect.succeed({
          state: 'resolved',
          target: resolvedTarget(input.compositionRevision ?? '', `${moduleId}.dashboard`, optedInPageKey),
        }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(tenantModuleTarget).toHaveBeenCalledTimes(1);
      expect(moduleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );

  it.effect('answers 409 selection_required for a tenant session the tenant read refuses', () =>
    Effect.gen(function* tenantSelectionRequired() {
      const { exit, moduleTarget } = yield* dispatch(tenantSession, neverCalled, () =>
        Effect.succeed({ state: 'selection_required' }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('ShellSelectionRequiredProblem');
      expect(moduleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );

  it.effect('routes a company session to the company read even for an opted-in page', () =>
    Effect.gen(function* companyDispatch() {
      const { exit, moduleTarget, tenantModuleTarget } = yield* dispatch(
        companySession,
        (input) =>
          Effect.succeed(resolvedTarget(input.compositionRevision ?? '', `${moduleId}.dashboard`, optedInPageKey)),
        neverCalled,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(moduleTarget).toHaveBeenCalledTimes(1);
      expect(tenantModuleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );

  it.effect('a stale pinned revision fails the whole request before any read', () =>
    Effect.gen(function* stalePinned() {
      const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract()]));
      const moduleTarget = rs.fn(neverCalled);
      const tenantModuleTarget = rs.fn(neverCalled);
      const exit = yield* resolveModuleTargetHandler(
        request,
        targetPayload({ compositionRevision: 'f'.repeat(64), moduleId }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              AuthenticationService,
              makeAuthenticationServiceDouble({ resolveShellContext: () => Effect.succeed(tenantSession) }),
            ),
            Layer.succeed(AccessDecisionGate, makeTestAccessDecision()),
            Layer.succeed(ContextAccess, makeContextAccessDouble('allowed')),
            Layer.mock(LegalEntityContext, {}),
            Layer.succeed(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request('https://shell.test/shell/module-target', { method: 'POST' })),
            ),
            Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
            Layer.mock(ShellGovernedReads, {
              moduleTarget,
              tenantModuleTarget,
              tenantModuleTargetCarrier: tenantModuleTargetTestCarrier,
            }),
          ),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('ShellReloadRequiredProblem');
      expect(moduleTarget).not.toHaveBeenCalled();
      expect(tenantModuleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );

  it.effect('a selection-required session is refused 409 before any read', () =>
    Effect.gen(function* selectionRequiredDispatch() {
      const { exit, moduleTarget, tenantModuleTarget } = yield* dispatch(
        {
          availableLegalEntities: [{ legalEntityId, legalName: 'Property company' }],
          identity: tenantIdentity,
          principal: tenantPrincipal,
          setCookieHeaders: [],
          state: 'selection_required',
        },
        neverCalled,
        neverCalled,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('ShellSelectionRequiredProblem');
      expect(moduleTarget).not.toHaveBeenCalled();
      expect(tenantModuleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );

  it.effect('an anonymous session is refused 401 before any read', () =>
    Effect.gen(function* anonymousDispatch() {
      const { exit, moduleTarget, tenantModuleTarget } = yield* dispatch(
        { setCookieHeaders: [], state: 'anonymous' },
        neverCalled,
        neverCalled,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('ShellAuthenticationRequiredProblem');
      expect(moduleTarget).not.toHaveBeenCalled();
      expect(tenantModuleTarget).not.toHaveBeenCalled();
    }).pipe(Effect.provide(ShellCryptoLive)),
  );
});
