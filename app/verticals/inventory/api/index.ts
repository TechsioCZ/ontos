import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
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
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import type { EffectBffRuntimeAssembly } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime, HttpRouter } from '@modern-js/bff-effect/effect-edge';
import { Logger, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { catalogToStockBindingResolutionReadApiLive } from './catalog-to-stock-binding-resolution-read-server.ts';
import { changeStockSharingEligibilityActionApiLive } from './change-stock-sharing-eligibility-action-server.ts';
import { commitmentProtectionVerificationReadApiLive } from './commitment-protection-verification-read-server.ts';
import { compensateInventoryPreCommitActionApiLive } from './compensate-inventory-pre-commit-action-server.ts';
import { correctCatalogToStockBindingActionApiLive } from './correct-catalog-to-stock-binding-action-server.ts';
import { correctExternalStockCorrelationActionApiLive } from './correct-external-stock-correlation-action-server.ts';
import { correctStockPositionActionApiLive } from './correct-stock-position-action-server.ts';
import { createInventoryReservationActionApiLive } from './create-inventory-reservation-action-server.ts';
import { currentRelevantStockPositionSetReadApiLive } from './current-relevant-stock-position-set-read-server.ts';
import { currentStockEvidenceForAvailabilityReadApiLive } from './current-stock-evidence-for-availability-read-server.ts';
import { endCatalogToStockBindingActionApiLive } from './end-catalog-to-stock-binding-action-server.ts';
import { endExternalStockCorrelationActionApiLive } from './end-external-stock-correlation-action-server.ts';
import { endStockSharingEligibilityActionApiLive } from './end-stock-sharing-eligibility-action-server.ts';
import { establishCatalogToStockBindingActionApiLive } from './establish-catalog-to-stock-binding-action-server.ts';
import { establishCommitmentProtectionActionApiLive } from './establish-commitment-protection-action-server.ts';
import { establishExternalStockCorrelationActionApiLive } from './establish-external-stock-correlation-action-server.ts';
import { establishStockSharingEligibilityActionApiLive } from './establish-stock-sharing-eligibility-action-server.ts';
import { importSourceAssertionActionApiLive } from './import-source-assertion-action-server.ts';
import { inventoryBackendConfigurationCurrentReadApiLive } from './inventory-backend-configuration-current-read-server.ts';
import { inventoryEffectOutcomeReadApiLive } from './inventory-effect-outcome-read-server.ts';
import { inventoryReconciliationEvidenceReadApiLive } from './inventory-reconciliation-evidence-read-server.ts';
import { inventoryReservationDetailReadApiLive } from './inventory-reservation-detail-read-server.ts';
import { inventorySourceConflictDetailReadApiLive } from './inventory-source-conflict-detail-read-server.ts';
import { recoverInventoryEffectActionApiLive } from './recover-inventory-effect-action-server.ts';
import { releaseInventoryReservationActionApiLive } from './release-inventory-reservation-action-server.ts';
import { reservationConfirmationVerificationReadApiLive } from './reservation-confirmation-verification-read-server.ts';
import { resolveInventorySourceConflictActionApiLive } from './resolve-inventory-source-conflict-action-server.ts';
import { selectInventoryBackendActionApiLive } from './select-inventory-backend-action-server.ts';
import { stockIssueActionApiLive } from './stock-issue-action-server.ts';
import { stockReceiptActionApiLive } from './stock-receipt-action-server.ts';
import { stockSharingEligibilityResolutionReadApiLive } from './stock-sharing-eligibility-resolution-read-server.ts';
// </generated-governed-http-handler-imports>

import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { inventoryApi, inventoryOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const inventoryReadinessLayer = HttpApiBuilder.group(inventoryApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: {
        ...ultramodernApiMarker,
        kind: 'microvertical-delivery-unit' as const,
        schemaVersion: 1 as const,
      },
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.inventory.readiness', {
        attributes: microVerticalOperationAttributes(inventoryOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

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
const inventoryActionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
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
  Layer.provide(DatabaseConfigLive),
  Layer.provide(databaseIdentitiesLive),
);
const inventoryReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(databaseIdentitiesLive),
);

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type InventoryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof inventoryReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof inventoryActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

type InventoryApiGroups = (typeof inventoryApi.groups)[keyof typeof inventoryApi.groups];

export const makeInventoryApiRuntime = (
  ...args: InventoryApiRuntimeArguments
): EffectBffDefinition<typeof inventoryApi> & EffectBffRuntime<typeof inventoryApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    inventoryReadinessLayer,
    // <generated-governed-http-handler-layers>
    catalogToStockBindingResolutionReadApiLive,
    changeStockSharingEligibilityActionApiLive,
    commitmentProtectionVerificationReadApiLive,
    compensateInventoryPreCommitActionApiLive,
    correctCatalogToStockBindingActionApiLive,
    correctExternalStockCorrelationActionApiLive,
    correctStockPositionActionApiLive,
    createInventoryReservationActionApiLive,
    currentRelevantStockPositionSetReadApiLive,
    currentStockEvidenceForAvailabilityReadApiLive,
    endCatalogToStockBindingActionApiLive,
    endExternalStockCorrelationActionApiLive,
    endStockSharingEligibilityActionApiLive,
    establishCatalogToStockBindingActionApiLive,
    establishCommitmentProtectionActionApiLive,
    establishExternalStockCorrelationActionApiLive,
    establishStockSharingEligibilityActionApiLive,
    importSourceAssertionActionApiLive,
    inventoryBackendConfigurationCurrentReadApiLive,
    inventoryEffectOutcomeReadApiLive,
    inventoryReconciliationEvidenceReadApiLive,
    inventoryReservationDetailReadApiLive,
    inventorySourceConflictDetailReadApiLive,
    recoverInventoryEffectActionApiLive,
    releaseInventoryReservationActionApiLive,
    reservationConfirmationVerificationReadApiLive,
    resolveInventorySourceConflictActionApiLive,
    selectInventoryBackendActionApiLive,
    stockIssueActionApiLive,
    stockReceiptActionApiLive,
    stockSharingEligibilityResolutionReadApiLive,
    // </generated-governed-http-handler-layers>
  );
  const requestServicesLive = Layer.mergeAll(
    governedReadRuntimeLive,
    governedActionRuntimeLive,
    actionPrincipalVerifierLive,
    gatewayAssertionRedemption,
  ).pipe(
    Layer.provideMerge(compositionSourceLive),
    Layer.provideMerge(runtimeObservabilityLive),
    Layer.provideMerge(databaseIdentitiesLive),
    Layer.orDie,
  );
  type InventoryHandlerRequirements =
    | (typeof apiHandlersLive extends Layer.Layer<infer _Services, infer _Error, infer Requirements>
        ? Requirements
        : never)
    | HttpRouter.HttpRouter;
  const resolvedApiHandlersLive: EffectBffRuntimeAssembly<
    'InventoryApi',
    InventoryApiGroups,
    InventoryHandlerRequirements,
    Layer.Success<typeof requestServicesLive>
  >['handlers'] = apiHandlersLive.pipe(Layer.provide(RequestSchemaProblemLive));

  return assembleEffectBffRuntime({
    api: inventoryApi,
    handlers: resolvedApiHandlersLive,
    services: requestServicesLive,
  });
};

const apiRuntime: EffectBffDefinition<typeof inventoryApi> & EffectBffRuntime<typeof inventoryApi> =
  makeInventoryApiRuntime(
    inventoryReadRuntimeLive,
    inventoryActionRuntimeLive,
    productionGatewayAssertionRedemptionLive,
  );

export default apiRuntime;
