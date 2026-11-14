import { PgClient } from '@effect/sql-pg';
import type { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApproveHandler,
  makeOwnerActionInspectHandler,
} from '@app/core-runtime/access/approvals/owner-http';
import { assortmentRegistration } from '../vertical.registration.ts';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ActionAuthorizationPreflightDatabaseLive,
  makeActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Crypto, Layer as GovernedReadLayer, Logger, References, Result, Schema, Tracer } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';

import { assortmentApi, assortmentMarkerSchema, assortmentOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { checkAssortmentFixtureOwnerCurrentness } from '../src/adapters/assortment-fixture-owner-currentness.ts';
import {
  AssortmentFixtureOwnerCurrentness,
  assortmentOwnerAuthorizationOverlayLive,
} from '../src/services/assortment-currentness.ts';
// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
  gatewayAssertionRedemptionPgClient,
} from './auth/gateway-assertion-redemption.ts';
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
import { importSymmyRuleActionApiLive } from './import-symmy-rule-action-server.ts';
import { issueAssortmentCommitmentConfirmationActionApiLive } from './issue-assortment-commitment-confirmation-action-server.ts';
import { purchaseReadApiLive } from './purchase-read-server.ts';
import { replaceApplicabilityBindingActionApiLive } from './replace-applicability-binding-action-server.ts';
import { replaceClosedAssortmentBoundaryActionApiLive } from './replace-closed-assortment-boundary-action-server.ts';
import { retireRuleActionApiLive } from './retire-rule-action-server.ts';
import { visibilityReadApiLive } from './visibility-read-server.ts';
// </generated-governed-http-handler-imports>

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

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

const assortmentApiMarker = Result.getOrThrow(Schema.decodeResult(assortmentMarkerSchema)(ultramodernApiMarker));

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
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(compositionSourceLive),
);

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const accessEnforcementLive = AccessDecisionLive.pipe(
  Layer.provideMerge(AccessEnforcementPortsLive),
  Layer.provide(TenantIntentLoaderLive),
  Layer.provide(CorePersistenceLive),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(nodeCryptoLayer),
  Layer.provide(databaseIdentitiesLive),
);
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive, accessEnforcementLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
  accessEnforcementLive,
);

const assortmentFixtureOwnerCurrentnessLive = Layer.effect(
  AssortmentFixtureOwnerCurrentness,
  Effect.gen(function* assortmentOwnerOverlay() {
    const crypto = yield* Crypto.Crypto;
    const client = yield* HttpClient.HttpClient;
    return {
      check: (scope, at, fingerprint) =>
        checkAssortmentFixtureOwnerCurrentness(crypto, scope, at, fingerprint).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
    };
  }),
);

/** Installs owner Current checks without replacing Core's separate exact Permission checks. */
export const withAssortmentOwnerAuthorizationOverlay = Layer.provide(
  assortmentOwnerAuthorizationOverlayLive.pipe(
    Layer.provide(assortmentFixtureOwnerCurrentnessLive),
    Layer.provide(Layer.merge(compositionHttpClientLive, nodeCryptoLayer)),
  ),
);
const productionReadRuntimeLive = withAssortmentOwnerAuthorizationOverlay(
  makeReadRuntimeLive(ultramodernDeliveryUnit, assortmentRegistration),
).pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(activeApplicationCompositionLive),
  Layer.provide(databaseIdentitiesLive),
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
const ownerActionApprovalsLive = withAssortmentOwnerAuthorizationOverlay(
  makeOwnerActionApprovalsLive(ultramodernDeliveryUnit, assortmentRegistration),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      actionAuthorizationPreflightDatabaseLive,
      actionRuntimeDependenciesLive,
      activeApplicationCompositionLive,
      accessEnforcementLive,
    ),
  ),
);

const actionRuntimeCoreLive = withAssortmentOwnerAuthorizationOverlay(
  makeActionRuntimeLive(ultramodernDeliveryUnit, assortmentRegistration),
).pipe(
  Layer.provideMerge(ownerActionApprovalsLive),
  Layer.provide(
    Layer.mergeAll(
      actionAuthorizationPreflightDatabaseLive,
      actionRuntimeDependenciesLive,
      activeApplicationCompositionLive,
      accessEnforcementLive,
    ),
  ),
);
const productionActionRuntimeLive = actionRuntimeCoreLive.pipe(
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(databaseIdentitiesLive),
);
const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(
    GatewayAssertionRedemptionDatabaseLive.pipe(Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient))),
  ),
  Layer.provide(DatabaseConfigLive),
);

type AssortmentApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime | OwnerActionApprovals, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

export type AssortmentApiRuntime = EffectBffDefinition<typeof assortmentApi> & EffectBffRuntime<typeof assortmentApi>;

export const makeAssortmentApiRuntime = (...args: AssortmentApiRuntimeArguments): AssortmentApiRuntime => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    assortmentReadinessLayer,
    HttpApiBuilder.group(assortmentApi, 'ownerActionApprovals', (handlers) =>
      handlers
        .handle('approve', makeOwnerActionApproveHandler(authenticateOwnerApprovalPrincipal))
        .handle('inspect', makeOwnerActionInspectHandler(authenticateOwnerApprovalPrincipal)),
    ).pipe(
      GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    // <generated-governed-http-handler-layers>
    configurationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createRuleRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    decisionExplanationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    endApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    endClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    importSymmyRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    issueAssortmentCommitmentConfirmationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    purchaseReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    replaceApplicabilityBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    replaceClosedAssortmentBoundaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    visibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeObservabilityLive,
        RequestSchemaProblemLive,
        compositionSourceLive,
        databaseIdentitiesLive,
        // Commitment confirmation issuance signs its confirmation with Crypto inside the handler's Action execution.
        nodeCryptoLayer,
      ),
    ),
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
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;
