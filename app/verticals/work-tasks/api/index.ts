import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApproveHandler,
  makeOwnerActionInspectHandler,
} from '@app/core-runtime/access/approvals/owner-http';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { workTasksBackendRegistration } from '../vertical.runtime-declaration.ts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  AccessEnforcementPortsLive as readAssignmentPorts,
  AssignablePrincipals,
  CoreSearchQueryRuntimeLive,
  CoreSearchProjectionStoreLive,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  makeReadRuntimeLive,
  makeAssignablePrincipals,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { workTasksApi, workTasksOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { agentReviewReadApiLive } from './agent-review-read-server.ts';
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
import { requestSearchRebuildActionApiLive } from './request-search-rebuild-action-server.ts';
import { submitStorefrontInquiryActionApiLive } from './submit-storefront-inquiry-action-server.ts';
import { tasksReadApiLive } from './tasks-search-server.ts';
// </generated-governed-http-handler-imports>

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const governedCompositionHttpClientLive = GovernedFetchHttpClient.layer.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  ),
);
const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(governedCompositionHttpClientLive),
);
const governedActiveApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedAccessEnforcementLive = AccessDecisionLive.pipe(
  GovernedReadLayer.provideMerge(AccessEnforcementPortsLive),
  GovernedReadLayer.provideMerge(TenantIntentLoaderLive),
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
);
const governedAssignmentLive = GovernedReadLayer.effect(
  AssignablePrincipals,
  Effect.gen(function* workAssignmentService() {
    return makeAssignablePrincipals(yield* readAssignmentPorts);
  }),
).pipe(GovernedReadLayer.provide(governedAccessEnforcementLive));
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive, governedAccessEnforcementLive),
    ),
  ),
  governedAccessEnforcementLive,
  governedAssignmentLive,
);
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, workTasksBackendRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
);

const ownerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  workTasksBackendRegistration,
).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

const governedActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit, workTasksBackendRegistration).pipe(
  GovernedReadLayer.provideMerge(ownerActionApprovalsLive),
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  HttpApiBuilder.group(workTasksApi, 'ownerActionApprovals', (handlers) =>
    handlers
      .handle('approve', makeOwnerActionApproveHandler(authenticateOwnerApprovalPrincipal))
      .handle('inspect', makeOwnerActionInspectHandler(authenticateOwnerApprovalPrincipal)),
  ).pipe(
    GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
    GovernedReadLayer.provide(governedActionRuntimeLive),
  ),
  // <generated-governed-http-handler-layers>
  agentReviewReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  applyCommandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  recordsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  requestSearchRebuildActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  submitStorefrontInquiryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  tasksReadApiLive.pipe(
    GovernedReadLayer.provide(governedReadRuntimeLive),
    GovernedReadLayer.provide(
      CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive)),
    ),
  ),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive.pipe(GovernedReadLayer.provide(GatewayAssertionRedemptionDatabaseLive)),
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
);

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
});

const workTasksReadinessLayer = HttpApiBuilder.group(workTasksApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.workTasks.readiness', {
        attributes: operationAttributes(workTasksOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = workTasksReadinessLayer;
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);
const governedResolvedApiHandlersLive = GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(databaseIdentitiesLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
  GovernedReadLayer.provide(runtimeObservabilityLive),
  GovernedReadLayer.orDie,
);

export const makeWorkTasksApiRuntime = () =>
  assembleEffectBffRuntime({
    api: workTasksApi,
    handlers: governedResolvedApiHandlersLive,
  });
const apiRuntime = makeWorkTasksApiRuntime();

export default apiRuntime;
