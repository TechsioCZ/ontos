import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ActionRuntime,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  GatewayAssertionRedemptionService,
  ReadRuntime,
  ReadRuntimeLive,
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
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { commerceMarketCatalogApi, commerceMarketCatalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
} from './auth/gateway-assertion-redemption.ts';
// <generated-governed-http-handler-imports>
import { activateMarketActionApiLive } from './activate-market-action-server.ts';
import { associateStorefrontActionApiLive } from './associate-storefront-action-server.ts';
import { createMarketActionApiLive } from './create-market-action-server.ts';
import { currentMarketCatalogReadApiLive } from './current-market-catalog-read-server.ts';
import { eligibleMarketTuplesReadApiLive } from './eligible-market-tuples-read-server.ts';
import { marketHistoryReadApiLive } from './market-history-read-server.ts';
import { marketRetirementStatusReadApiLive } from './market-retirement-status-read-server.ts';
import { pricingCurrentMarketEvidenceReadApiLive } from './pricing-current-market-evidence-read-server.ts';
import { removeStorefrontAssociationActionApiLive } from './remove-storefront-association-action-server.ts';
import { resolveCommerceMarketReadApiLive } from './resolve-commerce-market-read-server.ts';
import { retireMarketActionApiLive } from './retire-market-action-server.ts';
import { reviseMarketDefinitionActionApiLive } from './revise-market-definition-action-server.ts';
import { reviseStorefrontAssociationActionApiLive } from './revise-storefront-association-action-server.ts';
import { suspendMarketActionApiLive } from './suspend-market-action-server.ts';
import { verifyMarketEligibilityV1ReadApiLive } from './verify-market-eligibility-v1-read-server.ts';
// </generated-governed-http-handler-imports>
import {
  commerceMarketCatalogCorsAllowedHeaders,
  commerceMarketCatalogCorsAllowedMethods,
  commerceMarketCatalogCorsAllowedOrigins,
  resolveCommerceMarketCatalogShellOrigin,
} from './runtime-support.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

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

const productionGatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type CommerceMarketCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

export const makeCommerceMarketCatalogApiRuntime = (
  ...args: CommerceMarketCatalogApiRuntimeArguments
): EffectBffDefinition<typeof commerceMarketCatalogApi> & EffectBffRuntime<typeof commerceMarketCatalogApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    commerceMarketCatalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    activateMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    associateStorefrontActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentMarketCatalogReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    eligibleMarketTuplesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketRetirementStatusReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    pricingCurrentMarketEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeStorefrontAssociationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    resolveCommerceMarketReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseMarketDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseStorefrontAssociationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    suspendMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    verifyMarketEligibilityV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, databaseIdentitiesLive, compositionSourceLive),
    ),
    Layer.orDie,
  );
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

/** Assemble this owner's unchanged HTTP runtime from caller-owned scoped services. */
export const commerceMarketCatalogApiRuntimeFromContext = Effect.gen(
  function* commerceMarketCatalogApiRuntimeFromContext() {
    const readRuntime = yield* ReadRuntime;
    const actionRuntime = yield* ActionRuntime;
    const redemption = yield* GatewayAssertionRedemptionService;
    return makeCommerceMarketCatalogApiRuntime(
      Layer.succeed(ReadRuntime, readRuntime),
      Layer.succeed(ActionRuntime, actionRuntime),
      Layer.succeed(GatewayAssertionRedemptionService, redemption),
    );
  },
);

const apiRuntime = makeCommerceMarketCatalogApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;
