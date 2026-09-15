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
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';

// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { addProcessingPurposeVersionActionApiLive } from './add-processing-purpose-version-action-server.ts';
import { applicabilityDecisionsReadApiLive } from './applicability-decisions-read-server.ts';
import { assignDsrResolverActionApiLive } from './assign-dsr-resolver-action-server.ts';
import { assignLegalBasisActionApiLive } from './assign-legal-basis-action-server.ts';
import { assignPrivacyResponsibilityActionApiLive } from './assign-privacy-responsibility-action-server.ts';
import { createDsrCaseActionApiLive } from './create-dsr-case-action-server.ts';
import { createNoticeVersionActionApiLive } from './create-notice-version-action-server.ts';
import { createPrivacySubjectActionApiLive } from './create-privacy-subject-action-server.ts';
import { createProcessingActivityActionApiLive } from './create-processing-activity-action-server.ts';
import { createProcessingPurposeActionApiLive } from './create-processing-purpose-action-server.ts';
import { currentConsentReadApiLive } from './current-consent-read-server.ts';
import { dispatchPrivacyMeasureActionApiLive } from './dispatch-privacy-measure-action-server.ts';
import { dsrCasesReadApiLive } from './dsr-cases-read-server.ts';
import { enqueueRetentionEvaluationActionApiLive } from './enqueue-retention-evaluation-action-server.ts';
import { evaluateProcessingEligibilityActionApiLive } from './evaluate-processing-eligibility-action-server.ts';
import { issueDsrDeliveryAccessActionApiLive } from './issue-dsr-delivery-access-action-server.ts';
import { legalBasisAssignmentsReadApiLive } from './legal-basis-assignments-read-server.ts';
import { noticeVersionsReadApiLive } from './notice-versions-read-server.ts';
import { ownerInventoryReadApiLive } from './owner-inventory-read-server.ts';
import { privacySubjectsReadApiLive } from './privacy-subjects-read-server.ts';
import { processingActivitiesReadApiLive } from './processing-activities-read-server.ts';
import { processingEligibilityReadApiLive } from './processing-eligibility-read-server.ts';
import { processingPurposesReadApiLive } from './processing-purposes-read-server.ts';
import { recordAntiResurrectionProtectionActionApiLive } from './record-anti-resurrection-protection-action-server.ts';
import { recordApplicabilityPolicyActionApiLive } from './record-applicability-policy-action-server.ts';
import { recordConsentDecisionActionApiLive } from './record-consent-decision-action-server.ts';
import { recordDispositionDecisionActionApiLive } from './record-disposition-decision-action-server.ts';
import { recordDsrDeadlineActionApiLive } from './record-dsr-deadline-action-server.ts';
import { recordDsrDeliveryEvidenceActionApiLive } from './record-dsr-delivery-evidence-action-server.ts';
import { recordDsrResponseActionApiLive } from './record-dsr-response-action-server.ts';
import { recordDsrSubstantiveDecisionActionApiLive } from './record-dsr-substantive-decision-action-server.ts';
import { recordDsrVerificationActionApiLive } from './record-dsr-verification-action-server.ts';
import { recordExternalObligationActionApiLive } from './record-external-obligation-action-server.ts';
import { recordLegalHoldActionApiLive } from './record-legal-hold-action-server.ts';
import { recordNoticeProvisionActionApiLive } from './record-notice-provision-action-server.ts';
import { recordOwnerContributionActionApiLive } from './record-owner-contribution-action-server.ts';
import { recordOwnerExecutionOutcomeActionApiLive } from './record-owner-execution-outcome-action-server.ts';
import { recordPrivacyApplicabilityActionApiLive } from './record-privacy-applicability-action-server.ts';
import { recordPrivacyRepresentationActionApiLive } from './record-privacy-representation-action-server.ts';
import { recordProcessingInterventionActionApiLive } from './record-processing-intervention-action-server.ts';
import { recordRetentionExceptionActionApiLive } from './record-retention-exception-action-server.ts';
import { responsibilityAssignmentsReadApiLive } from './responsibility-assignments-read-server.ts';
import { retentionRulesReadApiLive } from './retention-rules-read-server.ts';
import { transitionProcessingActivityActionApiLive } from './transition-processing-activity-action-server.ts';
import { updateDsrCaseActionApiLive } from './update-dsr-case-action-server.ts';
import { upsertDsrOwnerTaskActionApiLive } from './upsert-dsr-owner-task-action-server.ts';
import { upsertRetentionRuleActionApiLive } from './upsert-retention-rule-action-server.ts';
import { upsertTemporaryDsrExportActionApiLive } from './upsert-temporary-dsr-export-action-server.ts';
// </generated-governed-http-handler-imports>

import { privacyApi, privacyOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  if (operationContext.traceId !== undefined) {
    Object.assign(attributes, { 'modernjs.trace.id': operationContext.traceId });
  }
  return attributes;
};

// fallow-ignore-next-line code-duplication -- Generated MicroVertical readiness and runtime-layer assembly follows the shared deployable-owner contract.
const privacyReadinessLayer = HttpApiBuilder.group(privacyApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.privacy.readiness', {
        attributes: operationAttributes(privacyOperationContexts.readiness),
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
const operationalScopeResolverLive = Layer.provide(
  OperationalScopeResolverLive,
  Layer.mergeAll(CorePersistenceLive, ContextAccessLive),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const productionReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
);
const productionActionRuntimeLive = ActionRuntimeLive.pipe(
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

type PrivacyApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

export const makePrivacyApiRuntime = (
  ...args: PrivacyApiRuntimeArguments
): EffectBffDefinition<typeof privacyApi> & EffectBffRuntime<typeof privacyApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    privacyReadinessLayer,
    // <generated-governed-http-handler-layers>
    addProcessingPurposeVersionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    applicabilityDecisionsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    assignDsrResolverActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignLegalBasisActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignPrivacyResponsibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createDsrCaseActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createNoticeVersionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPrivacySubjectActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProcessingActivityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProcessingPurposeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentConsentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    dispatchPrivacyMeasureActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    dsrCasesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    enqueueRetentionEvaluationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    evaluateProcessingEligibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    issueDsrDeliveryAccessActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    legalBasisAssignmentsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    noticeVersionsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    ownerInventoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    privacySubjectsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    processingActivitiesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    processingEligibilityReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    processingPurposesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    recordAntiResurrectionProtectionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordApplicabilityPolicyActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordConsentDecisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDispositionDecisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDsrDeadlineActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDsrDeliveryEvidenceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDsrResponseActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDsrSubstantiveDecisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordDsrVerificationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordExternalObligationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordLegalHoldActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordNoticeProvisionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordOwnerContributionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordOwnerExecutionOutcomeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordPrivacyApplicabilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordPrivacyRepresentationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordProcessingInterventionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    recordRetentionExceptionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    responsibilityAssignmentsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retentionRulesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    transitionProcessingActivityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateDsrCaseActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    upsertDsrOwnerTaskActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    upsertRetentionRuleActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    upsertTemporaryDsrExportActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(
    Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)),
    Layer.provide(runtimeObservabilityLive),
    Layer.orDie,
  );
  return assembleEffectBffRuntime({
    api: privacyApi,
    handlers: apiHandlersLive,
  });
};

const apiRuntime = makePrivacyApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;
