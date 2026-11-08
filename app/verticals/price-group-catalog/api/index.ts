import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApprovalApiLive,
} from '@app/core-runtime/access/approvals/owner-http';
import type { OwnerActionApprovals } from '@app/core-runtime/access/approvals/owner-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { priceGroupCatalogRegistration } from '../vertical.registration.ts';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  OwnerAuthorizationOverlay,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  makeReadRuntimeLive,
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
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
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

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

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
const priceGroupCatalogOwnerOperations = [
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.create',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group-definition-revision.create',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.retire',
    operation: 'action',
    operationKey: 'pricing.price-group-catalog.retire-price-group',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.read.definition',
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.price-group-definition',
  },
  {
    capabilityKey: 'pricing.price-group-catalog.price-group.read.compatibility',
    operation: 'read',
    operationKey: 'pricing.price-group-catalog.api.validate-price-group-compatibility',
  },
] as const;

/**
 * This owner has one implicit catalog per Tenant (the catalog-root Resource id is the Tenant id), so
 * every one of its capabilities lives in the Tenant context and in no company. It holds no separate
 * owner-held entitlement: the one access gate decides the capability (O67-Q2), and the scoped native
 * handler routines still establish identity, currentness, lifecycle and CAS. In particular,
 * historical/retired reads and genuine missing-owner responses must not be reclassified as
 * permission denials here.
 */
export const priceGroupCatalogOwnerAuthorizationDecision = (
  transactionScope: ScopedTransactionExecutor['scope'],
  input: OwnerAuthorizationInput,
): OwnerAuthorizationDecision => {
  if (
    input.owningModuleKey !== 'pricing.price-group-catalog' ||
    // A v2 descriptor carries no legacy target and asks for no record scope (O62, O67-Q2).
    input.targets.length !== 0 ||
    input.target !== undefined ||
    input.scope.tenantId !== transactionScope.tenantId ||
    input.scope.legalEntityId !== undefined ||
    transactionScope.legalEntityId !== undefined ||
    input.scope.trustedStorefrontId !== undefined
  ) {
    return 'unavailable';
  }
  const exactOperation = priceGroupCatalogOwnerOperations.some(
    (contract) =>
      contract.operation === input.operation &&
      contract.operationKey === input.operationKey &&
      contract.capabilityKey === input.capabilityKey,
  );
  return exactOperation ? 'allowed' : 'unavailable';
};

export const priceGroupCatalogOwnerAuthorizationOverlayLive = Layer.succeed(OwnerAuthorizationOverlay, {
  authorize: (transaction, input) =>
    Effect.succeed(priceGroupCatalogOwnerAuthorizationDecision(transaction.scope, input)),
});
const priceGroupCatalogReadRuntimeLive = makeReadRuntimeLive(
  ultramodernDeliveryUnit,
  priceGroupCatalogRegistration,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      priceGroupCatalogOwnerAuthorizationOverlayLive,
      accessEnforcementLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(activeApplicationCompositionLive),
  Layer.provide(databaseIdentitiesLive),
);

const ownerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  priceGroupCatalogRegistration,
).pipe(
  Layer.provide(
    Layer.mergeAll(
      activeApplicationCompositionLive,
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      priceGroupCatalogOwnerAuthorizationOverlayLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      accessEnforcementLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(databaseIdentitiesLive),
);

const priceGroupCatalogActionRuntimeLive = makeActionRuntimeLive(
  ultramodernDeliveryUnit,
  priceGroupCatalogRegistration,
).pipe(
  Layer.provideMerge(ownerActionApprovalsLive),
  Layer.provide(
    Layer.mergeAll(
      activeApplicationCompositionLive,
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      priceGroupCatalogOwnerAuthorizationOverlayLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      accessEnforcementLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
  Layer.provide(databaseIdentitiesLive),
);
const priceGroupCatalogGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GovernedGatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type PriceGroupCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof priceGroupCatalogReadRuntimeLive>>,
  actionRuntime: Layer.Layer<
    ActionRuntime | OwnerActionApprovals,
    Layer.Error<typeof priceGroupCatalogActionRuntimeLive>
  >,
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
    makeOwnerActionApprovalApiLive(priceGroupCatalogApi, authenticateOwnerApprovalPrincipal).pipe(
      GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
      GovernedReadLayer.provide(governedActionRuntimeLive),
    ),
    // <generated-governed-http-handler-layers>
    createPriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPriceGroupDefinitionRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    priceGroupDefinitionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retirePriceGroupActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    validatePriceGroupCompatibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive, compositionSourceLive, databaseIdentitiesLive),
    ),
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
