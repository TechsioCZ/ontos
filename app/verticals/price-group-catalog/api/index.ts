import {
  ActionRuntimeLive,
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
import { assembleEffectBffRuntime } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';

// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { createPriceGroupActionApiLive } from './create-price-group-action-server.ts';
import { createPriceGroupDefinitionRevisionActionApiLive } from './create-price-group-definition-revision-action-server.ts';
import { priceGroupDefinitionReadApiLive } from './price-group-definition-read-server.ts';
import { retirePriceGroupActionApiLive } from './retire-price-group-action-server.ts';
import { validatePriceGroupCompatibilityReadApiLive } from './validate-price-group-compatibility-read-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { priceGroupCatalogApi, priceGroupCatalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import {
  priceGroupCatalogCorsAllowedHeaders,
  priceGroupCatalogCorsAllowedMethods,
  priceGroupCatalogCorsAllowedOrigins,
  resolvePriceGroupCatalogShellOrigin,
} from './runtime-support.ts';

const priceGroupCatalogReadinessLayer = HttpApiBuilder.group(priceGroupCatalogApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.priceGroupCatalog.readiness', {
        attributes: microVerticalOperationAttributes(priceGroupCatalogOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolvePriceGroupCatalogShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolvePriceGroupCatalogShellOrigin();
  }
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
const priceGroupCatalogActionRuntimeLive = ActionRuntimeLive.pipe(
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
const priceGroupCatalogReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
);

type PriceGroupCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof priceGroupCatalogReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof priceGroupCatalogActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makePriceGroupCatalogApiRuntime = (
  ...args: PriceGroupCatalogApiRuntimeArguments
): EffectBffDefinition<typeof priceGroupCatalogApi> & EffectBffRuntime<typeof priceGroupCatalogApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    priceGroupCatalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    createPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPriceGroupDefinitionRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    priceGroupDefinitionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retirePriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    validatePriceGroupCompatibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(Layer.provide(runtimeObservabilityLive), Layer.orDie);
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...priceGroupCatalogCorsAllowedHeaders],
    allowedMethods: [...priceGroupCatalogCorsAllowedMethods],
    allowedOrigins: priceGroupCatalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: priceGroupCatalogApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime = makePriceGroupCatalogApiRuntime(
  priceGroupCatalogReadRuntimeLive,
  priceGroupCatalogActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;
