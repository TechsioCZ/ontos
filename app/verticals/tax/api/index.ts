import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
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
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { taxApi, taxOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { applicableTaxRuleSetReadApiLive } from './applicable-tax-rule-set-read-server.ts';
import { correctTaxRuleRevisionActionApiLive } from './correct-tax-rule-revision-action-server.ts';
import { createTaxRuleActionApiLive } from './create-tax-rule-action-server.ts';
import { createTaxRuleRevisionActionApiLive } from './create-tax-rule-revision-action-server.ts';
import { declareSellerVatRegimeActionApiLive } from './declare-seller-vat-regime-action-server.ts';
import { endTaxRuleRevisionActionApiLive } from './end-tax-rule-revision-action-server.ts';
import { finalizeOrderTaxActionApiLive } from './finalize-order-tax-action-server.ts';
import { finalOrderTaxReadApiLive } from './final-order-tax-read-server.ts';
import { importSellerVatRegimeDeclarationsActionApiLive } from './import-seller-vat-regime-declarations-action-server.ts';
import { sellerVatRegimeAtInstantReadApiLive } from './seller-vat-regime-at-instant-read-server.ts';
import { sellerVatRegimeHistoryReadApiLive } from './seller-vat-regime-history-read-server.ts';
import { taxCorrectionPreviewReadApiLive } from './tax-correction-preview-read-server.ts';
import { taxEvaluationReadApiLive } from './tax-evaluation-read-server.ts';
import { taxMaterialityComparisonReadApiLive } from './tax-materiality-comparison-read-server.ts';
import { taxPrivacyOwnerCoverageReadApiLive } from './tax-privacy-owner-coverage-read-server.ts';
import { taxRuleHistoryReadApiLive } from './tax-rule-history-read-server.ts';
// </generated-governed-http-handler-imports>

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

const taxReadinessLayer = HttpApiBuilder.group(taxApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.tax.readiness', {
        attributes: microVerticalOperationAttributes(taxOperationContexts.readiness),
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
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);
const readRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(databaseIdentitiesLive),
);
/** Read runtime bound by generated governed HTTP handlers mounted in the slot below. */
export const governedReadRuntimeLive = readRuntimeLive;
const compositionHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(compositionHttpClientLive));
const actionRuntimeLive = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
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
/** Action runtime bound by generated governed Action HTTP handlers mounted in the slot below. */
export const governedActionRuntimeLive = actionRuntimeLive;

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  taxReadinessLayer,
  // <generated-governed-http-handler-layers>
  applicableTaxRuleSetReadApiLive,
  correctTaxRuleRevisionActionApiLive,
  createTaxRuleActionApiLive,
  createTaxRuleRevisionActionApiLive,
  declareSellerVatRegimeActionApiLive,
  endTaxRuleRevisionActionApiLive,
  finalizeOrderTaxActionApiLive,
  finalOrderTaxReadApiLive,
  importSellerVatRegimeDeclarationsActionApiLive,
  sellerVatRegimeAtInstantReadApiLive,
  sellerVatRegimeHistoryReadApiLive,
  taxCorrectionPreviewReadApiLive,
  taxEvaluationReadApiLive,
  taxMaterialityComparisonReadApiLive,
  taxPrivacyOwnerCoverageReadApiLive,
  taxRuleHistoryReadApiLive,
  // </generated-governed-http-handler-layers>
);
const requestServicesLive = Layer.mergeAll(governedReadRuntimeLive, governedActionRuntimeLive).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provideMerge(
    GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, productionGatewayAssertionRedemptionLive),
  ),
  // </generated-governed-http-handler-support-layers>
  Layer.provideMerge(compositionSourceLive),
  Layer.provideMerge(runtimeObservabilityLive),
  Layer.provideMerge(databaseIdentitiesLive),
  Layer.orDie,
);
const resolvedApiHandlersLive = governedReadApiHandlersLive.pipe(Layer.provide(RequestSchemaProblemLive));

export const makeTaxApiRuntime = (): EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> =>
  assembleEffectBffRuntime({
    api: taxApi,
    handlers: resolvedApiHandlersLive,
    services: requestServicesLive,
  });

const apiRuntime: EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> = makeTaxApiRuntime();

export default apiRuntime;
