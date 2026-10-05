import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import { availabilityApi, availabilityOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

import {
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/unstable/http';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { currentAvailabilityReadApiLive } from './current-availability-read-server.ts';
import {
  AvailabilityConsumerOwnerUnavailableLive,
  availabilityConsumerCurrentnessLive,
} from '../src/services/availability-consumer-contract.service.ts';
// </generated-governed-http-handler-imports>

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

const availabilityConsumerDependenciesLive = GovernedReadLayer.mergeAll(
  AvailabilityConsumerOwnerUnavailableLive,
  availabilityConsumerCurrentnessLive.pipe(GovernedReadLayer.provide(AvailabilityConsumerOwnerUnavailableLive)),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  currentAvailabilityReadApiLive.pipe(
    GovernedReadLayer.provide(governedReadRuntimeLive),
    GovernedReadLayer.provide(availabilityConsumerDependenciesLive),
  ),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(GovernedReadLayer.empty),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  return operationContext.traceId === undefined
    ? attributes
    : { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

/** The native assembly installs handlers; the owner composes actual logging and span services here. */
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);

const availabilityReadinessLayer = HttpApiBuilder.group(availabilityApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.availability.readiness', {
        attributes: operationAttributes(availabilityOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = availabilityReadinessLayer;
export const makeAvailabilityApiRuntime = () =>
  assembleEffectBffRuntime({
    api: availabilityApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
      GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
      GovernedReadLayer.provide(GovernedDatabaseConfigLive),
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
      GovernedReadLayer.orDie,
    ),
  });
const apiRuntime = makeAvailabilityApiRuntime();

export default apiRuntime;
