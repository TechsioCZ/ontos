import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  makeActionRuntimeLive,
  OwnerAuthorizationOverlay,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type {
  ActionRuntime,
  GatewayAssertionRedemptionService,
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  ReadRuntime,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
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
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive as GovernedGatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
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
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
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
const priceGroupCatalogOwnerOperations = [
  {
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group',
    permission: 'pricing.price_group.create',
    targetKind: 'pricing_catalog',
  },
  {
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
    permission: 'pricing.price_group.revision.create',
    targetKind: 'price_group',
  },
  {
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.retire-price-group',
    permission: 'pricing.price_group.retire',
    targetKind: 'price_group',
  },
  {
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.price-group-definition',
    permission: 'pricing.price_group.read',
    targetKind: 'price_group',
  },
  {
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
    permission: 'pricing.price_group.read',
    targetKind: 'price_group',
  },
] as const;

/**
 * This owner has one implicit catalog per Tenant (the catalog-root Resource id is the Tenant id).
 * It has no separate owner-held entitlement or lifecycle permission: Core still verifies the exact
 * business Permission and Action executor, and the same scoped native handler routines establish
 * identity, currentness, lifecycle and CAS. In particular, historical/retired reads and genuine
 * missing-owner responses must not be reclassified as permission denials here.
 */
export const priceGroupCatalogOwnerAuthorizationDecision = (
  transactionScope: ScopedTransactionExecutor['scope'],
  input: OwnerAuthorizationInput,
): OwnerAuthorizationDecision => {
  const [target] = input.targets;
  if (
    input.owningModuleKey !== 'pricing.price-group-catalog' ||
    input.targets.length !== 1 ||
    target?.kind !== 'business_permission' ||
    input.scope.tenantId !== transactionScope.tenantId ||
    input.scope.legalEntityId !== undefined ||
    transactionScope.legalEntityId !== undefined ||
    input.scope.trustedStorefrontId !== undefined ||
    target.trustedStorefrontId !== undefined ||
    (target.target.kind !== 'pricing_catalog' && target.target.kind !== 'price_group') ||
    target.target.tenantId !== transactionScope.tenantId ||
    target.target.pricingCatalogId !== transactionScope.tenantId
  ) {
    return 'unavailable';
  }
  const exactOperation = priceGroupCatalogOwnerOperations.some(
    (contract) =>
      contract.operation === input.operation &&
      contract.operationKey === input.operationKey &&
      contract.permission === target.permission &&
      contract.targetKind === target.target.kind,
  );
  return exactOperation ? 'allowed' : 'unavailable';
};

export const priceGroupCatalogOwnerAuthorizationOverlayLive = Layer.succeed(OwnerAuthorizationOverlay, {
  authorize: (transaction, input) =>
    Effect.succeed(priceGroupCatalogOwnerAuthorizationDecision(transaction.scope, input)),
});

const priceGroupCatalogActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  Layer.provide(
    Layer.mergeAll(
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(compositionSourceLive)),
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      priceGroupCatalogOwnerAuthorizationOverlayLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
);
const priceGroupCatalogReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      priceGroupCatalogOwnerAuthorizationOverlayLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
);
const priceGroupCatalogGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GovernedGatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type PriceGroupCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof priceGroupCatalogReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof priceGroupCatalogActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof priceGroupCatalogGatewayAssertionRedemptionLive>
  >,
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
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, compositionSourceLive)),
    Layer.orDie,
  );
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
  priceGroupCatalogGatewayAssertionRedemptionLive,
);

export default apiRuntime;
