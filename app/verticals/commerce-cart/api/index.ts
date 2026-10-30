import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import { commerceCartApi, commerceCartOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import {
  ultramodernApiMarker,
  ultramodernDeliveryUnit as governedActionDeliveryUnit,
} from '../shared/ultramodern-build.ts';

import {
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  makeActionRuntimeLive as GovernedMakeActionRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ActionPermissionLive as GovernedActionPermissionLive,
  ActionRepositoryLive as GovernedActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive as GovernedApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { CartOwnerAuthorizationOverlayLive } from '../src/policies/cart-draft-authority.policy.ts';

import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  gatewayAssertionRedemptionPgClient,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { closeCartDraftActionApiLive } from './close-cart-draft-action-server.ts';
import { createCartDraftActionApiLive } from './create-cart-draft-action-server.ts';
import { finalCartCandidateReadApiLive } from './final-cart-candidate-read-server.ts';
import { finalizeCartCandidateActionApiLive } from './finalize-cart-candidate-action-server.ts';
import { initializePopulationAuthorityActionApiLive } from './initialize-population-authority-action-server.ts';
import { openSelectionPopulationReadApiLive } from './open-selection-population-read-server.ts';
import { preapprovalCartObservationReadApiLive } from './preapproval-cart-observation-read-server.ts';
import { reviseCartDraftActionApiLive } from './revise-cart-draft-action-server.ts';
// </generated-governed-http-handler-imports>

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  CartOwnerAuthorizationOverlayLive,
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

const governedActionRuntimeLive = GovernedMakeActionRuntimeLive(governedActionDeliveryUnit).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      governedModuleStateGateLive,
      GovernedActionRepositoryLive,
      GovernedActionPermissionLive,
      GovernedApplicationCompositionConfigLive,
    ),
  ),
);

const cartGatewayAssertionRedemptionDatabaseLive = GatewayAssertionRedemptionDatabaseLive.pipe(
  GovernedReadLayer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
  GovernedReadLayer.provide(Reactivity.layer),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  closeCartDraftActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  createCartDraftActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  finalCartCandidateReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  finalizeCartCandidateActionApiLive.pipe(
    GovernedReadLayer.provide(governedActionRuntimeLive),
    GovernedReadLayer.provide(
      GovernedFetchHttpClient.layer.pipe(
        GovernedReadLayer.provide(
          GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
        ),
      ),
    ),
  ),
  initializePopulationAuthorityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  openSelectionPopulationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  preapprovalCartObservationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  reviseCartDraftActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive),
  ),
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive,
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(cartGatewayAssertionRedemptionDatabaseLive),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId === undefined) {
    return attributes;
  }
  return { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

const commerceCartReadinessLayer = HttpApiBuilder.group(commerceCartApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.commerceCart.readiness', {
        attributes: operationAttributes(commerceCartOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

/** The native assembly installs handlers; the owner composes actual logging and span services here. */
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);

const apiHandlersLive = commerceCartReadinessLayer;
export const makeCommerceCartApiRuntime = () =>
  assembleEffectBffRuntime({
    api: commerceCartApi,
    handlers: GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
      GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedDatabaseConfigLive, nodeCryptoLayer)),
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
      GovernedReadLayer.orDie,
    ),
  });
const apiRuntime = makeCommerceCartApiRuntime();

export default apiRuntime;
