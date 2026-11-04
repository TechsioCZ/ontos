// @rstest-environment node
import {
  ContextAccess,
  ReadHandlerUnavailable,
  ReadRuntime,
  TenantModuleStateService,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import type { ContextAccessDecision, ContextAccessService, TenantModuleStateRecord } from '@app/core-runtime';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ShellCryptoLive } from '../../api/auth/gateway-issuer.ts';
import { CapturedShellCompositionCatalog } from '../../api/modules/captured-shell-catalog.ts';
import { makeInstalledModuleCatalogLoader } from '../../api/modules/installed-module-catalog.ts';
import { ShellCompositionFactoryLive } from '../../api/modules/shell-composition.ts';
import { createShellGovernedReadsLayer, ShellGovernedReads } from '../../api/modules/shell-governed-reads.ts';
import type { ShellGovernedReadsService } from '../../api/modules/shell-governed-reads.ts';
import { ShellResourceServicesFactoryLive } from '../../api/modules/shell-resources.ts';
import { ShellSystemSearch } from '../../api/modules/shell-system-search.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const alpha = 'admission.alpha';
const alphaType = `${alpha}.record`;
const correlationId = 'shell-people-inventory-admission';
const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const principalId = '30000000-0000-4000-8000-000000000001';
const sessionPrincipal = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '40000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:shell-people-inventory',
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  }),
  correlationId,
};

const contract = (moduleId: string, resourceType: string) => ({
  deployment: { appId: moduleId.replace('.', '-'), buildMarker: 'shell-people-inventory' },
  manifest: {
    activation: {
      defaultState: 'inactive',
      preservesHistoryWhenInactive: true,
      scope: 'tenant',
      supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'],
    },
    module: {
      description: 'Inventory admission fixture',
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
            contributionKey: `${moduleId}.search.contribution`,
            entrypoint: {
              access: 'read',
              authorization: { kind: 'context_permission', permission: 'module.access' },
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

interface AdmissionControls {
  readonly coreModule: ContextAccessDecision;
  readonly legalEntity: ContextAccessDecision;
  readonly tenant: ContextAccessDecision;
}
interface AdmissionCalls {
  readonly assertions: string[];
  readonly owners: string[];
  system: number;
}

/** A real Core governed search over one business owner plus the Core people system branch. */
const fixture = (controls: AdmissionControls) =>
  Effect.gen(function* makeFixture() {
    const catalog = yield* makeInstalledModuleCatalogLoader(makeCompositionSnapshot([contract(alpha, alphaType)]));
    const calls: AdmissionCalls = { assertions: [], owners: [], system: 0 };
    const states: readonly TenantModuleStateRecord[] = [{ moduleKey: alpha, state: 'active' }];
    const harness = yield* makeReadTestHarness({
      compositionRevision: catalog.composition.revision,
      executeOwnerQuery: () => Effect.die('the Shell people admission test must not run an owner SQL query'),
      operationTime: new Date('2026-11-04T12:00:00Z'),
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope: sessionPrincipal,
    });
    const native = yield* ContextAccess.pipe(Effect.provide(harness.layer));
    const access: ContextAccessService = {
      ...native,
      legalEntities: ({ legalEntityIds }) =>
        Effect.succeed(legalEntityIds.map((key) => ({ decision: controls.legalEntity, key }))),
      modules: ({ moduleIds }) =>
        Effect.succeed(
          moduleIds.map((key) => ({ decision: key === alpha ? ('allowed' as const) : controls.coreModule, key })),
        ),
      tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: controls.tenant, key }))),
    };
    const moduleStates = {
      getTenantModuleStates: (_tenantId: string, moduleIds: readonly string[]) =>
        Effect.succeed(states.filter(({ moduleKey }) => moduleIds.includes(moduleKey))),
      listActiveTenantModules: () => Effect.die('unexpected listActiveTenantModules'),
      listTenantModuleStates: () => Effect.die('unexpected listTenantModuleStates'),
    };
    const issuer = {
      issueAssertion: ({ appId }: { readonly appId: string }) => {
        calls.assertions.push(appId);
        return Effect.succeed('issuer-port-fixture');
      },
    };
    const gateways = {
      resource: {
        detail: () => Effect.die('unexpected resource detail'),
        timeline: () => Effect.die('unexpected resource timeline'),
      },
      search: {
        search: ({ appId }: { readonly appId: string }) => {
          calls.owners.push(appId);
          return Effect.succeed([
            {
              ref: { moduleId: alpha, resourceId: 'record-1', resourceType: alphaType, tenantId },
              selectedLegalEntityId: legalEntityId,
              title: 'Alfa záznam',
            },
          ]);
        },
      },
    };
    const layer = createShellGovernedReadsLayer(gateways, issuer, () => moduleStates).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ReadRuntime, harness.runtime),
          Layer.succeed(ContextAccess, access),
          Layer.succeed(TenantModuleStateService, moduleStates),
          ShellCompositionFactoryLive,
          ShellResourceServicesFactoryLive,
          Layer.succeed(ShellSystemSearch, {
            search: () => {
              calls.system += 1;
              return Effect.succeed({ partial: false, results: [] });
            },
          }),
        ),
      ),
    );
    const reads = yield* ShellGovernedReads.pipe(Effect.provide(layer), Effect.orDie);
    const search: ShellGovernedReadsService['search'] = (input) =>
      reads
        .search(input)
        .pipe(
          Effect.provideService(CapturedShellCompositionCatalog, catalog),
          Effect.provide(
            staffAuthenticationNamespaceRegistryLayer([catalog.composition.shell.deployment.appId]).pipe(Layer.orDie),
          ),
        );
    const run = (overrides: Partial<Parameters<ShellGovernedReadsService['search']>[0]> = {}) =>
      search({
        compositionRevision: catalog.composition.revision,
        correlationId,
        principal: sessionPrincipal,
        query: 'Alfa',
        ...overrides,
      });
    return { calls, catalog, run };
  });

const withRuntime = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.scoped, Effect.provide(ShellCryptoLive));

it.effect(
  'a denied Core people directory omits the system branch from a complete answer and calls no system provider',
  () =>
    withRuntime(
      Effect.gen(function* deniedDirectory() {
        const f = yield* fixture({ coreModule: 'allowed', legalEntity: 'denied', tenant: 'denied' });
        const result = yield* f.run();
        expect(result.partial).toBe(false);
        expect(result.presentation?.system).toBeUndefined();
        expect(result.results.map(({ title }) => title)).toEqual(['Alfa záznam']);
        expect(f.calls.system).toBe(0);
        expect(f.calls.assertions).toEqual(['admission-alpha']);
        expect(f.calls.owners).toEqual(['admission-alpha']);
      }),
    ),
);

it.effect('a denied Core people module gate omits the system branch while an indeterminate one fails unavailable', () =>
  withRuntime(
    Effect.gen(function* moduleGate() {
      const denied = yield* fixture({ coreModule: 'denied', legalEntity: 'allowed', tenant: 'allowed' });
      const deniedResult = yield* denied.run();
      expect(deniedResult.presentation?.system).toBeUndefined();
      expect(denied.calls.system).toBe(0);

      const indeterminate = yield* fixture({ coreModule: 'unavailable', legalEntity: 'allowed', tenant: 'allowed' });
      const failure = yield* indeterminate.run().pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      // The uncertain admission fails the read before any owner, assertion or system dispatch.
      expect(indeterminate.calls.owners).toEqual([]);
      expect(indeterminate.calls.assertions).toEqual([]);
      expect(indeterminate.calls.system).toBe(0);
    }),
  ),
);

it.effect('an indeterminate Core people directory fails the governed read unavailable and never dispatches', () =>
  withRuntime(
    Effect.gen(function* indeterminateDirectory() {
      const f = yield* fixture({ coreModule: 'allowed', legalEntity: 'unavailable', tenant: 'unavailable' });
      const failure = yield* f.run().pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(f.calls.system).toBe(0);
      expect(f.calls.owners).toEqual([]);
      expect(f.calls.assertions).toEqual([]);
    }),
  ),
);

it.effect('an admitted Core people directory keeps the system branch and calls the system provider once', () =>
  withRuntime(
    Effect.gen(function* admittedDirectory() {
      const f = yield* fixture({ coreModule: 'allowed', legalEntity: 'allowed', tenant: 'denied' });
      const result = yield* f.run();
      expect(result.partial).toBe(false);
      expect(result.presentation?.system).toBeDefined();
      expect(result.presentation?.system?.resourceType).toBe('core.identity.person');
      expect(f.calls.system).toBe(1);
      expect(f.calls.owners).toEqual(['admission-alpha']);
    }),
  ),
);

it.effect('a single allowed directory alternative admits the branch even when the other target is indeterminate', () =>
  withRuntime(
    Effect.gen(function* anyOfAdmits() {
      const f = yield* fixture({ coreModule: 'allowed', legalEntity: 'allowed', tenant: 'unavailable' });
      const result = yield* f.run();
      expect(result.presentation?.system).toBeDefined();
      expect(f.calls.system).toBe(1);
    }),
  ),
);

it.effect('an explicit empty selector returns the admitted inventory without any owner, assertion or system call', () =>
  withRuntime(
    Effect.gen(function* inventoryOnly() {
      const admitted = yield* fixture({ coreModule: 'allowed', legalEntity: 'allowed', tenant: 'allowed' });
      const admittedResult = yield* admitted.run({ resourceTypes: [] });
      expect(admittedResult.results).toEqual([]);
      expect(admittedResult.partial).toBe(false);
      expect(admittedResult.presentation?.system).toBeDefined();
      expect(admitted.calls.owners).toEqual([]);
      expect(admitted.calls.assertions).toEqual([]);
      expect(admitted.calls.system).toBe(0);

      const denied = yield* fixture({ coreModule: 'allowed', legalEntity: 'denied', tenant: 'denied' });
      const deniedResult = yield* denied.run({ resourceTypes: [] });
      expect(deniedResult.results).toEqual([]);
      expect(deniedResult.partial).toBe(false);
      expect(deniedResult.presentation?.system).toBeUndefined();
      expect(denied.calls.owners).toEqual([]);
      expect(denied.calls.assertions).toEqual([]);
      expect(denied.calls.system).toBe(0);
    }),
  ),
);

it.effect('an indeterminate People admission fails an inventory-only request instead of a complete inventory', () =>
  withRuntime(
    Effect.gen(function* uncertainInventory() {
      const f = yield* fixture({ coreModule: 'allowed', legalEntity: 'unavailable', tenant: 'unavailable' });
      const failure = yield* f.run({ resourceTypes: [] }).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(f.calls.owners).toEqual([]);
      expect(f.calls.assertions).toEqual([]);
      expect(f.calls.system).toBe(0);
    }),
  ),
);
