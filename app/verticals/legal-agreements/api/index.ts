import { NodeCrypto } from '@effect/platform-node';
import { Logger, References, Tracer, Layer as GovernedReadLayer } from 'effect';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import { legalAgreementsApi, legalAgreementsOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

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
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Reactivity } from 'effect/unstable/reactivity';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/unstable/http';
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
      governedModuleStateGateLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ActiveApplicationCompositionConfigLive,
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
  };
  return operationContext.traceId === undefined
    ? attributes
    : { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

const legalAgreementsReadinessLayer = HttpApiBuilder.group(legalAgreementsApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.legalAgreements.readiness', {
        attributes: operationAttributes(legalAgreementsOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = legalAgreementsReadinessLayer;
const governedResolvedRequestServicesLive = governedRequestServicesLive.pipe(
  GovernedReadLayer.provideMerge(NodeCrypto.layer),
  GovernedReadLayer.provideMerge(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provideMerge(GovernedDatabaseConfigLive),
  GovernedReadLayer.provideMerge(databaseIdentitiesLive),
  GovernedReadLayer.provideMerge(
    GovernedReadLayer.mergeAll(
      Logger.layer([Logger.defaultLogger]),
      GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
    ),
  ),
  GovernedReadLayer.orDie,
);

export const makeLegalAgreementsApiRuntime = () =>
  assembleEffectBffRuntime({
    api: legalAgreementsApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive),
    services: governedResolvedRequestServicesLive,
  });
const apiRuntime = makeLegalAgreementsApiRuntime();

export default apiRuntime;
