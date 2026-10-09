import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  ActionAuthorizationPreflightDatabaseLive,
  makeActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Result, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { assortmentApi, assortmentMarkerSchema, assortmentOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { assortmentOwnerAuthorizationOverlayLive } from '../src/services/owner-authorization-current.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { configurationReadApiLive } from './configuration-read-server.ts';
import { createApplicabilityBindingActionApiLive } from './create-applicability-binding-action-server.ts';
import { createClosedAssortmentBoundaryActionApiLive } from './create-closed-assortment-boundary-action-server.ts';
import { createRuleActionApiLive } from './create-rule-action-server.ts';
import { createRuleRevisionActionApiLive } from './create-rule-revision-action-server.ts';
import { decisionExplanationReadApiLive } from './decision-explanation-read-server.ts';
import { endApplicabilityBindingActionApiLive } from './end-applicability-binding-action-server.ts';
import { endClosedAssortmentBoundaryActionApiLive } from './end-closed-assortment-boundary-action-server.ts';
import { issueAssortmentCommitmentConfirmationActionApiLive } from './issue-assortment-commitment-confirmation-action-server.ts';
import { purchaseReadApiLive } from './purchase-read-server.ts';
import { replaceApplicabilityBindingActionApiLive } from './replace-applicability-binding-action-server.ts';
import { replaceClosedAssortmentBoundaryActionApiLive } from './replace-closed-assortment-boundary-action-server.ts';
import { retireRuleActionApiLive } from './retire-rule-action-server.ts';
import { visibilityReadApiLive } from './visibility-read-server.ts';
// </generated-governed-http-handler-imports>

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

const assortmentApiMarker = Result.getOrThrow(Schema.decodeUnknownResult(assortmentMarkerSchema)(ultramodernApiMarker));

const assortmentReadinessLayer = HttpApiBuilder.group(assortmentApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: assortmentApiMarker,
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.assortment.readiness', {
        attributes: operationAttributes(assortmentOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const compositionHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttpClientLive));
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);

/** Installs owner Current checks without replacing Core's separate exact Permission checks. */
export const withAssortmentOwnerAuthorizationOverlay = Layer.provide(assortmentOwnerAuthorizationOverlayLive);

const productionReadRuntimeLive = withAssortmentOwnerAuthorizationOverlay(ReadRuntimeLive).pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(DatabaseConfigLive),
);
const actionAuthorizationPreflightDatabaseLive = ActionAuthorizationPreflightDatabaseLive.pipe(
  Layer.provideMerge(CorePersistenceLive),
);
const actionRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  ContextAccessLive,
  moduleStateGateLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);
const actionRuntimeCoreLive = withAssortmentOwnerAuthorizationOverlay(
  makeActionRuntimeLive(ultramodernDeliveryUnit),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      actionAuthorizationPreflightDatabaseLive,
      actionRuntimeDependenciesLive,
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(compositionSourceLive)),
    ),
  ),
);
const productionActionRuntimeLive = actionRuntimeCoreLive.pipe(Layer.provide(DatabaseConfigLive));
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

type AssortmentApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export type AssortmentApiRuntime = EffectBffDefinition<typeof assortmentApi> & EffectBffRuntime<typeof assortmentApi>;

export const makeAssortmentApiRuntime = (...args: AssortmentApiRuntimeArguments): AssortmentApiRuntime => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    assortmentReadinessLayer,
    // <generated-governed-http-handler-layers>
    configurationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createRuleRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    decisionExplanationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    endApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    endClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    issueAssortmentCommitmentConfirmationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    purchaseReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    replaceApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    replaceClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    visibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, compositionSourceLive)),
    Layer.orDie,
  );

  return assembleEffectBffRuntime({
    api: assortmentApi,
    handlers: resolvedApiHandlersLive,
  });
};

const apiRuntime = makeAssortmentApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;
