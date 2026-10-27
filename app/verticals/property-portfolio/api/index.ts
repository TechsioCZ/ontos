import { NodeCrypto } from '@effect/platform-node';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  ActionPermissionLive,
  ActionRepositoryLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Logger, References, Tracer, Layer as GovernedReadLayer } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionPgClientLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
// </generated-governed-http-handler-imports>

import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { propertyPortfolioApi, propertyPortfolioOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

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

const governedActionRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  governedModuleStateGateLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive)),
  ),
);
const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  GovernedReadLayer.provide(governedActionRuntimeDependenciesLive),
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

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  applyCommandActionApiLive,
  recordsReadApiLive,
  // </generated-governed-http-handler-layers>
);

/** What the handlers resolve when they run: built for each request on Workers, once on Node. */
const governedRequestServicesLive = GovernedReadLayer.mergeAll(governedActionRuntimeLive, governedReadRuntimeLive).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive,
      GovernedGatewayAssertionRedemptionLive.pipe(
        GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive),
        GovernedReadLayer.provide(GatewayAssertionPgClientLive),
        GovernedReadLayer.provide(Reactivity.layer),
      ),
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(GovernedReadLayer.empty),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
    'modernjs.trace.id': operationContext.traceId,
  };
  return attributes;
};
const telemetryLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger]),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
);

const propertyPortfolioReadinessLayer = HttpApiBuilder.group(propertyPortfolioApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.propertyPortfolio.readiness', {
        attributes: operationAttributes(propertyPortfolioOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = propertyPortfolioReadinessLayer;
const governedResolvedRequestServicesLive = governedRequestServicesLive.pipe(
  GovernedReadLayer.provideMerge(ActiveApplicationCompositionConfigLive),
  GovernedReadLayer.provideMerge(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provideMerge(GovernedDatabaseConfigLive),
  GovernedReadLayer.provideMerge(databaseIdentitiesLive),
  GovernedReadLayer.provideMerge(NodeCrypto.layer),
  GovernedReadLayer.provideMerge(telemetryLive),
  GovernedReadLayer.orDie,
);

export const makePropertyPortfolioApiRuntime = () =>
  assembleEffectBffRuntime({
    api: propertyPortfolioApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive),
    services: governedResolvedRequestServicesLive,
  });
const apiRuntime = makePropertyPortfolioApiRuntime();

export default apiRuntime;
