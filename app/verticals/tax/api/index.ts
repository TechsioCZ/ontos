import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
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
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { applicableTaxRuleSetReadApiLive } from './applicable-tax-rule-set-read-server.ts';
import { correctTaxRuleRevisionActionApiLive } from './correct-tax-rule-revision-action-server.ts';
import { createTaxRuleActionApiLive } from './create-tax-rule-action-server.ts';
import { createTaxRuleRevisionActionApiLive } from './create-tax-rule-revision-action-server.ts';
import { endTaxFactAuthorityContractActionApiLive } from './end-tax-fact-authority-contract-action-server.ts';
import { endTaxRuleRevisionActionApiLive } from './end-tax-rule-revision-action-server.ts';
import { establishTaxFactAuthorityContractActionApiLive } from './establish-tax-fact-authority-contract-action-server.ts';
import { recordTaxSourceAssertionActionApiLive } from './record-tax-source-assertion-action-server.ts';
import { reviseTaxFactAuthorityContractActionApiLive } from './revise-tax-fact-authority-contract-action-server.ts';
import { sellingLegalEntityVatRegistrationStateReadApiLive } from './selling-legal-entity-vat-registration-state-read-server.ts';
import { taxEvaluationReadApiLive } from './tax-evaluation-read-server.ts';
import { taxFactAuthorityCurrentReadApiLive } from './tax-fact-authority-current-read-server.ts';
import { taxMaterialityComparisonReadApiLive } from './tax-materiality-comparison-read-server.ts';
import { taxRuleHistoryReadApiLive } from './tax-rule-history-read-server.ts';
import { taxSourceAssertionHistoryReadApiLive } from './tax-source-assertion-history-read-server.ts';
import { taxSourceConflictDetailReadApiLive } from './tax-source-conflict-detail-read-server.ts';
// </generated-governed-http-handler-imports>

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
);
/** Action runtime bound by generated governed Action HTTP handlers mounted in the slot below. */
export const governedActionRuntimeLive = actionRuntimeLive;

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  taxReadinessLayer,
  // <generated-governed-http-handler-layers>
  applicableTaxRuleSetReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  correctTaxRuleRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  createTaxRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  createTaxRuleRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  endTaxFactAuthorityContractActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  endTaxRuleRevisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  establishTaxFactAuthorityContractActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  recordTaxSourceAssertionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  reviseTaxFactAuthorityContractActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  sellingLegalEntityVatRegistrationStateReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxEvaluationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxFactAuthorityCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxMaterialityComparisonReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxRuleHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxSourceAssertionHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  taxSourceConflictDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(GovernedActionPrincipalVerifierLive, GovernedGatewayAssertionRedemptionLive),
  ),
  // </generated-governed-http-handler-support-layers>
  Layer.provide(compositionSourceLive),
  Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
);
const resolvedApiHandlersLive = governedReadApiHandlersLive.pipe(Layer.orDie);

export const makeTaxApiRuntime = (): EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> =>
  assembleEffectBffRuntime({
    api: taxApi,
    handlers: resolvedApiHandlersLive,
  });

const apiRuntime: EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> = makeTaxApiRuntime();

export default apiRuntime;
