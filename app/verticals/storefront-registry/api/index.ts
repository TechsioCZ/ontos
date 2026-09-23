import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';

import { storefrontRegistryApi, storefrontRegistryOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
// <generated-governed-http-handler-imports>
import { currentStorefrontApplicationReadApiLive } from './current-storefront-application-read-server.ts';
// </generated-governed-http-handler-imports>
import {
  resolveStorefrontRegistryShellOrigin,
  storefrontRegistryCorsAllowedHeaders,
  storefrontRegistryCorsAllowedMethods,
  storefrontRegistryCorsAllowedOrigins,
} from './runtime-support.ts';

const storefrontRegistryReadinessLayer = HttpApiBuilder.group(storefrontRegistryApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.storefrontRegistry.readiness', {
        attributes: microVerticalOperationAttributes(storefrontRegistryOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  const configuredShellOrigin = (() => {
    try {
      return ULTRAMODERN_SHELL_ORIGIN;
    } catch {
      return null;
    }
  })();
  return resolveStorefrontRegistryShellOrigin(
    Schema.is(Schema.String)(configuredShellOrigin) ? configuredShellOrigin : undefined,
  );
};

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const productionReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
);

type StorefrontRegistryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makeStorefrontRegistryApiRuntime = (
  ...args: StorefrontRegistryApiRuntimeArguments
): EffectBffDefinition<typeof storefrontRegistryApi> & EffectBffRuntime<typeof storefrontRegistryApi> => {
  const [governedReadRuntimeLive, gatewayAssertionRedemption] = args;
  const apiHandlersLive = Layer.mergeAll(
    storefrontRegistryReadinessLayer,
    // <generated-governed-http-handler-layers>
    currentStorefrontApplicationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(GovernedActionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(Layer.provide(runtimeObservabilityLive), Layer.orDie);
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...storefrontRegistryCorsAllowedHeaders],
    allowedMethods: [...storefrontRegistryCorsAllowedMethods],
    allowedOrigins: storefrontRegistryCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: storefrontRegistryApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makeStorefrontRegistryApiRuntime(productionReadRuntimeLive, GovernedGatewayAssertionRedemptionLive);

export default apiRuntime;
