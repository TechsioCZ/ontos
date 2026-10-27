import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  ReadRuntimeLive as GovernedReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { NodeCrypto } from '@effect/platform-node';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer, Schema } from '@modern-js/bff-effect/effect-edge';
import { projectsApi, projectsOperationContexts, projectsMarkerSchema } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { archiveProjectActionApiLive } from './archive-project-action-server.ts';
import { createProjectActionApiLive } from './create-project-action-server.ts';
import { moveProjectActionApiLive } from './move-project-action-server.ts';
import { projectOwnerCandidatesReadApiLive } from './project-owner-candidates-read-server.ts';
import { readProjectReadApiLive } from './read-project-read-server.ts';
import { unarchiveProjectActionApiLive } from './unarchive-project-action-server.ts';
import { updateProjectActionApiLive } from './update-project-action-server.ts';
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
      GovernedCorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      GovernedContextAccessLive,
      governedModuleStateGateLive,
      GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
      GovernedOperationalScopeResolverLive.pipe(
        GovernedReadLayer.provide(GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive)),
      ),
      ActionAuthorizationPreflightDatabaseLive.pipe(GovernedReadLayer.provideMerge(GovernedCorePersistenceLive)),
      ActiveApplicationCompositionConfigLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  // <generated-governed-http-handler-layers>
  archiveProjectActionApiLive,
  createProjectActionApiLive,
  moveProjectActionApiLive,
  projectOwnerCandidatesReadApiLive,
  readProjectReadApiLive,
  unarchiveProjectActionApiLive,
  updateProjectActionApiLive,
  // </generated-governed-http-handler-layers>
);

const governedRequestServicesLive = GovernedReadLayer.mergeAll(governedActionRuntimeLive, governedReadRuntimeLive).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(
    GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(GovernedContextAccessLive),
);

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId !== undefined) {
    Object.assign(attributes, { 'modernjs.trace.id': operationContext.traceId });
  }
  return attributes;
};

const projectsReadinessLayer = HttpApiBuilder.group(projectsApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Schema.decodeEffect(projectsMarkerSchema)(ultramodernApiMarker).pipe(
      Effect.orDie,
      Effect.map((marker) => ({
        checks: {
          api: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      })),
      Effect.withSpan('ultramodern.api.projects.readiness', {
        attributes: operationAttributes(projectsOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const projectsApiHandlersLive = Layer.mergeAll(projectsReadinessLayer, governedReadApiHandlersLive).pipe(
  Layer.provide(RequestSchemaProblemLive),
);

const governedResolvedRequestServicesLive = governedRequestServicesLive.pipe(
  Layer.provideMerge(governedApplicationCompositionSourceLive),
  Layer.provideMerge(GovernedDatabaseConfigLive),
  Layer.provideMerge(databaseIdentitiesLive),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
      Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      Layer.succeed(References.MinimumLogLevel, 'Info'),
    ),
  ),
  Layer.orDie,
);

export default assembleEffectBffRuntime({
  api: projectsApi,
  handlers: projectsApiHandlersLive,
  services: governedResolvedRequestServicesLive,
});
