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
import type { EffectBffRuntimeAssembly } from '@app/shared-contracts/server/effect-bff-runtime';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';

// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
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
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

const inventoryReadinessLayer = HttpApiBuilder.group(inventoryApi, 'foundation', (handlers) =>
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

const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const inventoryActionRuntimeLive = ActionRuntimeLive.pipe(
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
const inventoryReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
);

type InventoryApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof inventoryReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof inventoryActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
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
    catalogToStockBindingResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    changeStockSharingEligibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    commitmentProtectionVerificationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    compensateInventoryPreCommitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctCatalogToStockBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctExternalStockCorrelationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctStockPositionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createInventoryReservationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentStockEvidenceForAvailabilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    endCatalogToStockBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    endExternalStockCorrelationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    endStockSharingEligibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    establishCatalogToStockBindingActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    establishCommitmentProtectionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    establishExternalStockCorrelationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    establishStockSharingEligibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    importSourceAssertionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    inventoryBackendConfigurationCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    inventoryEffectOutcomeReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    inventoryReconciliationEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    inventoryReservationDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    inventorySourceConflictDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    recoverInventoryEffectActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    releaseInventoryReservationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reservationConfirmationVerificationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    resolveInventorySourceConflictActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    selectInventoryBackendActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    stockIssueActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    stockReceiptActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    stockSharingEligibilityResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  type InventoryHandlerRequirements =
    typeof apiHandlersLive extends Layer.Layer<infer _Services, infer _Error, infer Requirements>
      ? Requirements
      : never;
  const resolvedApiHandlersLive: EffectBffRuntimeAssembly<
    'InventoryApi',
    InventoryApiGroups,
    InventoryHandlerRequirements
  >['handlers'] = apiHandlersLive.pipe(Layer.provide(runtimeObservabilityLive), Layer.orDie);

  return assembleEffectBffRuntime({
    api: inventoryApi,
    handlers: resolvedApiHandlersLive,
  });
};

const apiRuntime: EffectBffDefinition<typeof inventoryApi> & EffectBffRuntime<typeof inventoryApi> =
  makeInventoryApiRuntime(inventoryReadRuntimeLive, inventoryActionRuntimeLive, GovernedGatewayAssertionRedemptionLive);

export default apiRuntime;
