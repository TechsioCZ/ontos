import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  ReadRuntime,
  GatewayAssertionRedemptionService,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { storefrontRegistryApi, storefrontRegistryOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>
// <generated-governed-http-handler-imports>
import { currentStorefrontApplicationReadApiLive } from './current-storefront-application-read-server.ts';
import { registerStorefrontApplicationActionApiLive } from './register-storefront-application-action-server.ts';
import { reviseStorefrontApplicationActionApiLive } from './revise-storefront-application-action-server.ts';
import { storefrontApplicationsReadApiLive } from './storefront-applications-read-server.ts';
import { verifyCurrentStorefrontApplicationV1ReadApiLive } from './verify-current-storefront-application-v1-read-server.ts';
// </generated-governed-http-handler-imports>
import {
  resolveStorefrontRegistryShellOrigin,
  storefrontRegistryCorsAllowedHeaders,
  storefrontRegistryCorsAllowedMethods,
  storefrontRegistryCorsAllowedOrigins,
} from './runtime-support.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

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
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
    ),
  ),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const productionActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  Layer.provide(
    Layer.mergeAll(
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(compositionSourceLive)),
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(databaseIdentitiesLive),
);
const productionReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(databaseIdentitiesLive),
);

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type StorefrontRegistryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

export const makeStorefrontRegistryApiRuntime = (
  ...args: StorefrontRegistryApiRuntimeArguments
): EffectBffDefinition<typeof storefrontRegistryApi> & EffectBffRuntime<typeof storefrontRegistryApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    storefrontRegistryReadinessLayer,
    // <generated-governed-http-handler-layers>
    currentStorefrontApplicationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    registerStorefrontApplicationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseStorefrontApplicationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    storefrontApplicationsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    verifyCurrentStorefrontApplicationV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, databaseIdentitiesLive, compositionSourceLive),
    ),
    Layer.orDie,
  );
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

/** Explicit owner assembly from already verified caller-owned test/runtime services. */
export const storefrontRegistryApiRuntimeFromContext = Effect.gen(function* assembleStorefrontRegistryApiRuntime() {
  const readRuntime = yield* ReadRuntime;
  const actionRuntime = yield* ActionRuntime;
  const redemption = yield* GatewayAssertionRedemptionService;
  return makeStorefrontRegistryApiRuntime(
    Layer.succeed(ReadRuntime, readRuntime),
    Layer.succeed(ActionRuntime, actionRuntime),
    Layer.succeed(GatewayAssertionRedemptionService, redemption),
  );
});

const apiRuntime = makeStorefrontRegistryApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;
