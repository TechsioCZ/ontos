import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type {
  ActionRuntime,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { assembleEffectBffRuntime } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/plugin-bff/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
import { unavailableCustomerContextGatewayCredentialLive } from './payment-term-catalog-production-layers.ts';
import {
  paymentTermCatalogCorsAllowedHeaders,
  paymentTermCatalogCorsAllowedMethods,
  paymentTermCatalogCorsAllowedOrigins,
  resolvePaymentTermCatalogShellOrigin,
} from './runtime-support.ts';

// <generated-governed-http-handler-imports>
import { correctPaymentTermActionApiLive } from './correct-payment-term-action-server.ts';
import { createPaymentTermActionApiLive } from './create-payment-term-action-server.ts';
import { currentPaymentTermsReadApiLive } from './current-payment-terms-read-server.ts';
import { paymentTermHistoryReadApiLive } from './payment-term-history-read-server.ts';
import { reconcilePaymentTermReferenceActionApiLive } from './reconcile-payment-term-reference-action-server.ts';
import { retirePaymentTermActionApiLive } from './retire-payment-term-action-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { paymentTermCatalogApi, paymentTermCatalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

const paymentTermCatalogReadinessLayer = HttpApiBuilder.group(
  paymentTermCatalogApi,
  'foundation',
  (handlers) =>
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
        Effect.withSpan('ultramodern.api.paymentTermCatalog.readiness', {
          attributes: microVerticalOperationAttributes(
            paymentTermCatalogOperationContexts.readiness,
          ),
          kind: 'server',
        }),
      ),
    ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolvePaymentTermCatalogShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolvePaymentTermCatalogShellOrigin();
  }
};

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(
  Layer.provide(CorePersistenceLive),
);
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(
  Layer.provide(moduleStateGateLive),
);
/** Deployment composition seam. Trusted Customer Context issuance remains a requirement. */
const paymentTermCatalogActionRuntime = ActionRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(DatabaseConfigLive),
);
const productionActionRuntimeLive = paymentTermCatalogActionRuntime.pipe(
  Layer.provideMerge(unavailableCustomerContextGatewayCredentialLive),
);
const productionReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(DatabaseConfigLive),
);

type PaymentTermCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makePaymentTermCatalogApiRuntime = (
  ...args: PaymentTermCatalogApiRuntimeArguments
): EffectBffDefinition<typeof paymentTermCatalogApi> &
  EffectBffRuntime<typeof paymentTermCatalogApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    paymentTermCatalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    correctPaymentTermActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPaymentTermActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentPaymentTermsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    paymentTermHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reconcilePaymentTermReferenceActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    retirePaymentTermActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(runtimeObservabilityLive),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...paymentTermCatalogCorsAllowedHeaders],
    allowedMethods: [...paymentTermCatalogCorsAllowedMethods],
    allowedOrigins: paymentTermCatalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: paymentTermCatalogApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makePaymentTermCatalogApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { paymentTermCatalogActionRuntime };
