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
import {
  productionCommercialFxDisclosureLive,
  unavailableCommercialFxCurrentContextPortLive,
} from './commerce-fx-production-layers.ts';
import { ManualCommercialFxPortsFactoryLive } from '../src/persistence/manual-rate-policy-persistence.ts';
import {
  commerceFxCorsAllowedHeaders,
  commerceFxCorsAllowedMethods,
  commerceFxCorsAllowedOrigins,
  resolveCommerceFxShellOrigin,
} from './runtime-support.ts';

// <generated-governed-http-handler-imports>
import { changeManualCommercialRatePolicyActionApiLive } from './change-manual-commercial-rate-policy-action-server.ts';
import { commercialFxConversionReadApiLive } from './commercial-fx-conversion-read-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { commerceFxApi, commerceFxOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

const commerceFxReadinessLayer = HttpApiBuilder.group(commerceFxApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.commerceFx.readiness', {
        attributes: microVerticalOperationAttributes(commerceFxOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolveCommerceFxShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolveCommerceFxShellOrigin();
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
const productionActionRuntimeLive = ActionRuntimeLive.pipe(
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
/** Deployment composition seam. Current-context authority remains an external requirement. */
const commerceFxReadRuntime = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provideMerge(ManualCommercialFxPortsFactoryLive),
  Layer.provide(DatabaseConfigLive),
);
const productionReadRuntimeLive = commerceFxReadRuntime.pipe(
  Layer.provideMerge(unavailableCommercialFxCurrentContextPortLive),
  Layer.provideMerge(productionCommercialFxDisclosureLive),
);

type CommerceFxApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makeCommerceFxApiRuntime = (
  ...args: CommerceFxApiRuntimeArguments
): EffectBffDefinition<typeof commerceFxApi> & EffectBffRuntime<typeof commerceFxApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    commerceFxReadinessLayer,
    // <generated-governed-http-handler-layers>
    changeManualCommercialRatePolicyActionApiLive.pipe(
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    commercialFxConversionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(runtimeObservabilityLive),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...commerceFxCorsAllowedHeaders],
    allowedMethods: [...commerceFxCorsAllowedMethods],
    allowedOrigins: commerceFxCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: commerceFxApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makeCommerceFxApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { commerceFxReadRuntime };
