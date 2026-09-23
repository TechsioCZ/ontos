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
import { assembleEffectBffRuntime } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';

import { commerceMarketCatalogApi, commerceMarketCatalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
import { currentMarketCatalogReadApiLive } from './current-market-catalog-read-server.ts';
import { eligibleMarketTuplesReadApiLive } from './eligible-market-tuples-read-server.ts';
import { marketHistoryReadApiLive } from './market-history-read-server.ts';
import { resolveCommerceMarketReadApiLive } from './resolve-commerce-market-read-server.ts';
import {
  commerceMarketCatalogCorsAllowedHeaders,
  commerceMarketCatalogCorsAllowedMethods,
  commerceMarketCatalogCorsAllowedOrigins,
  resolveCommerceMarketCatalogShellOrigin,
} from './runtime-support.ts';

const commerceMarketCatalogReadinessLayer = HttpApiBuilder.group(commerceMarketCatalogApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.commerceMarketCatalog.readiness', {
        attributes: microVerticalOperationAttributes(commerceMarketCatalogOperationContexts.readiness),
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
  return resolveCommerceMarketCatalogShellOrigin(
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

type CommerceMarketCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makeCommerceMarketCatalogApiRuntime = (
  ...args: CommerceMarketCatalogApiRuntimeArguments
): EffectBffDefinition<typeof commerceMarketCatalogApi> & EffectBffRuntime<typeof commerceMarketCatalogApi> => {
  const [governedReadRuntimeLive, gatewayAssertionRedemption] = args;
  const apiHandlersLive = Layer.mergeAll(
    commerceMarketCatalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    currentMarketCatalogReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    eligibleMarketTuplesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    resolveCommerceMarketReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(ActionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(Layer.provide(runtimeObservabilityLive), Layer.orDie);
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...commerceMarketCatalogCorsAllowedHeaders],
    allowedMethods: [...commerceMarketCatalogCorsAllowedMethods],
    allowedOrigins: commerceMarketCatalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: commerceMarketCatalogApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makeCommerceMarketCatalogApiRuntime(productionReadRuntimeLive, GatewayAssertionRedemptionLive);

export default apiRuntime;
