import { paymentRegistration } from '../vertical.registration.ts';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  makeActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ReadRuntime, GatewayAssertionRedemptionService, ActionRuntime } from '@app/core-runtime';
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
import { PgClient } from '@effect/sql-pg';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  gatewayAssertionRedemptionPgClient,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
import { paymentProductionOwnerPortsLive } from './payment-production-layers.ts';
import {
  paymentCorsAllowedHeaders,
  paymentCorsAllowedMethods,
  paymentCorsAllowedOrigins,
  resolvePaymentShellOrigin,
} from './runtime-support.ts';

// <generated-governed-http-handler-imports>
import { acceptPaymentObservationActionApiLive } from './accept-payment-observation-action-server.ts';
import { captureProviderNotificationActionApiLive } from './capture-provider-notification-action-server.ts';
import { configureGatewayEnablementActionApiLive } from './configure-gateway-enablement-action-server.ts';
import { configurePaymentMethodEnablementActionApiLive } from './configure-payment-method-enablement-action-server.ts';
import { configurePaymentSourceAuthorityActionApiLive } from './configure-payment-source-authority-action-server.ts';
import { configureProviderAccountBindingActionApiLive } from './configure-provider-account-binding-action-server.ts';
import { createPaymentActionApiLive } from './create-payment-action-server.ts';
import { currentPaymentReadApiLive } from './current-payment-read-server.ts';
import { gatewayConfigurationReadApiLive } from './gateway-configuration-read-server.ts';
import { gatewayCustomerActionReadApiLive } from './gateway-customer-action-read-server.ts';
import { gatewayReconciliationDebtReadApiLive } from './gateway-reconciliation-debt-read-server.ts';
import { gatewayReturnStatusReadApiLive } from './gateway-return-status-read-server.ts';
import { issuePaymentAuthorizationActionApiLive } from './issue-payment-authorization-action-server.ts';
import { paymentAuthorizationValidationReadApiLive } from './payment-authorization-validation-read-server.ts';
import { paymentHistoryReadApiLive } from './payment-history-read-server.ts';
import { paymentMethodApplicabilityReadApiLive } from './payment-method-applicability-read-server.ts';
import { paymentReconciliationDebtReadApiLive } from './payment-reconciliation-debt-read-server.ts';
import { recordPaymentLocalEvidenceActionApiLive } from './record-payment-local-evidence-action-server.ts';
import { recordPaymentReconciliationDecisionActionApiLive } from './record-payment-reconciliation-decision-action-server.ts';
import { requestPaymentCancellationActionApiLive } from './request-payment-cancellation-action-server.ts';
import { requestPaymentOperationRecoveryActionApiLive } from './request-payment-operation-recovery-action-server.ts';
import { requestPaymentRefundActionApiLive } from './request-payment-refund-action-server.ts';
import { rotateProviderCredentialActionApiLive } from './rotate-provider-credential-action-server.ts';
import { startPaymentCollectionActionApiLive } from './start-payment-collection-action-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { paymentApi, paymentOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

const paymentReadinessLayer = HttpApiBuilder.group(paymentApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.payment.readiness', {
        attributes: microVerticalOperationAttributes(paymentOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolvePaymentShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolvePaymentShellOrigin();
  }
};

const runtimeObservabilityLayers = [
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
] as const;
const runtimeObservabilityLive = Layer.mergeAll(...runtimeObservabilityLayers);
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
);
const operationalScopeResolverLive = Layer.provide(
  OperationalScopeResolverLive,
  Layer.mergeAll(CorePersistenceLive, ContextAccessLive, accessEnforcementLive),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const paymentReadRuntime = makeReadRuntimeLive(ultramodernDeliveryUnit, paymentRegistration).pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      accessEnforcementLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(activeApplicationCompositionLive),
);
const paymentOwnerEvidenceLive = paymentProductionOwnerPortsLive.pipe(Layer.provide(nodeCryptoLayer));
const productionReadRuntimeLive = paymentReadRuntime.pipe(Layer.provideMerge(paymentOwnerEvidenceLive));

const paymentActionRuntime = makeActionRuntimeLive(ultramodernDeliveryUnit, paymentRegistration).pipe(
  Layer.provide(
    Layer.mergeAll(
      activeApplicationCompositionLive,
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      accessEnforcementLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
);
const productionActionRuntimeLive = paymentActionRuntime.pipe(Layer.provideMerge(paymentOwnerEvidenceLive));

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(PgClient.layerFrom(gatewayAssertionRedemptionPgClient)),
  Layer.provide(Reactivity.layer),
  Layer.provide(DatabaseConfigLive),
);

type PaymentApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

export const makePaymentApiRuntime = (
  ...args: PaymentApiRuntimeArguments
): EffectBffDefinition<typeof paymentApi> & EffectBffRuntime<typeof paymentApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    paymentReadinessLayer,
    // <generated-governed-http-handler-layers>
    acceptPaymentObservationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    captureProviderNotificationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    configureGatewayEnablementActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    configurePaymentMethodEnablementActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    configurePaymentSourceAuthorityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    configureProviderAccountBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPaymentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentPaymentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gatewayConfigurationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gatewayCustomerActionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gatewayReconciliationDebtReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gatewayReturnStatusReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    issuePaymentAuthorizationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    paymentAuthorizationValidationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentMethodApplicabilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentReconciliationDebtReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    recordPaymentLocalEvidenceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordPaymentReconciliationDecisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    requestPaymentCancellationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    requestPaymentOperationRecoveryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    requestPaymentRefundActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    rotateProviderCredentialActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    startPaymentCollectionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, compositionSourceLive)),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...paymentCorsAllowedHeaders],
    allowedMethods: [...paymentCorsAllowedMethods],
    allowedOrigins: paymentCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: paymentApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makePaymentApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { paymentActionRuntime, paymentReadRuntime };
