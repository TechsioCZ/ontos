import { HttpClient, FetchHttpClient as GovernedFetchHttpClient } from 'effect/unstable/http';
import { PartyIntake, PartyIntakeSteps, partyIntakeServices } from '../src/services/party-intake.ts';
import { NodeFileSystem } from '@effect/platform-node';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';

import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { crmApi, crmOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

// <generated-governed-http-handler-support-imports>
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { agentReviewReadApiLive } from './agent-review-read-server.ts';
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
// </generated-governed-http-handler-imports>

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive)),
  ),
);
const governedReadRuntimeLive = GovernedReadRuntimeLive.pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
);
const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(
    GovernedFetchHttpClient.layer.pipe(
      GovernedReadLayer.provide(
        GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
      ),
    ),
  ),
);

const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      ActiveApplicationCompositionConfigLive.pipe(GovernedReadLayer.provide(governedApplicationCompositionSourceLive)),
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  agentReviewReadApiLive,
  applyCommandActionApiLive,
  recordsReadApiLive,
  // </generated-governed-http-handler-layers>
);

/** Capture transport at the application root; build company/correlation state for each reconciliation. */
const partyIntakeLive = GovernedReadLayer.effect(
  PartyIntake,
  Effect.gen(function* partyIntakeRoot() {
    const http = yield* HttpClient.HttpClient;
    return {
      reconcile: Effect.fn('Crm.reconcileRequest')(function* reconcileRequest(clientIds: readonly string[]) {
        const services = yield* partyIntakeServices;
        const steps: typeof PartyIntakeSteps.Service = {
          identify: (client, taken, crmClients) =>
            services.identify(client, taken, crmClients).pipe(Effect.provideService(HttpClient.HttpClient, http)),
          link: (clientId, party, revision) =>
            services.link(clientId, party, revision).pipe(Effect.provideService(HttpClient.HttpClient, http)),
        };
        return yield* services
          .reconcile(clientIds)
          .pipe(Effect.provideService(PartyIntakeSteps, steps), Effect.provideService(HttpClient.HttpClient, http));
      }),
    };
  }),
);

/** What the handlers resolve when they run: built for each request on Workers, once on Node. */
const governedRequestServicesLive = GovernedReadLayer.mergeAll(governedReadRuntimeLive, governedActionRuntimeLive).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive,
      GovernedGatewayAssertionRedemptionLive.pipe(GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive)),
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provideMerge(partyIntakeLive),
  GovernedReadLayer.provideMerge(GovernedReadLayer.mergeAll(NodeFileSystem.layer, GovernedFetchHttpClient.layer)),
);

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
});

const crmReadinessLayer = HttpApiBuilder.group(crmApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: ultramodernApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.crm.readiness', {
        attributes: operationAttributes(crmOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = crmReadinessLayer;
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);
const governedResolvedRequestServicesLive = governedRequestServicesLive.pipe(
  GovernedReadLayer.provideMerge(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provideMerge(GovernedDatabaseConfigLive),
  GovernedReadLayer.provideMerge(databaseIdentitiesLive),
  GovernedReadLayer.provideMerge(runtimeObservabilityLive),
  GovernedReadLayer.orDie,
);

export const makeCrmApiRuntime = () =>
  assembleEffectBffRuntime({
    api: crmApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive),
    services: governedResolvedRequestServicesLive,
  });
const apiRuntime = makeCrmApiRuntime();

export default apiRuntime;
