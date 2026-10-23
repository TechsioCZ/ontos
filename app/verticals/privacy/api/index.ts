import {
  makeActionRuntimeLive,
  ActionAuthorizationPreflight,
  ActionRuntime,
  ActionAuthorizationPreflightDatabaseLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActionRuntimeService, GatewayAssertionRedemptionService } from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { FetchHttpClient } from 'effect/unstable/http';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { Effect, HttpApiBuilder, Layer, Schema } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Context, Logger, References, Tracer } from 'effect';

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
import { consentSelfServiceActionApiLive } from './consent-self-service-action-server.ts';
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

import { privacyApi, privacyMarkerSchema, privacyOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import {
  CommerceConsentAuthorityLookup,
  commerceConsentAuthorityLookup,
  preparedCommerceConsentExecution,
} from '../src/actions/commerce-consent-authority.ts';
import {
  ConsentSelfServiceAuthority,
  ConsentSelfServiceAuthorityUnavailableLive,
} from '../src/actions/consent-self-service.action.ts';
import { PrivacyApplicabilityBusinessFactAuthorityUnavailableLive } from '../src/actions/privacy-applicability-business-fact-authority-service.ts';
import { DsrIntakeReceiptAuthorityUnavailableLive } from '../src/actions/create-dsr-case.action.ts';
import { DsrOwnerTaskAuthorityUnavailableLive } from '../src/actions/privacy-dsr-owner-task-authority.ts';
import { DsrOwnerInventoryAuthorityUnavailableLive } from '../src/actions/privacy-dsr-owner-inventory-authority.ts';
import { DsrSubstantiveDecisionAuthorityUnavailableLive } from '../src/actions/privacy-dsr-substantive-decision-authority.ts';
import { ProcessingActivityCoverageAuthorityUnavailableLive } from '../src/actions/processing-activity-coverage-authority.ts';
import { RetentionRuleGovernanceAuthorityUnavailableLive } from '../src/actions/retention-rule-governance-authority.ts';
import { OwnerExecutionAuthorityUnavailableLive } from '../src/actions/privacy-owner-execution-authority.ts';
import { AntiResurrectionEnforcementAuthorityUnavailableLive } from '../src/actions/privacy-anti-resurrection-enforcement-authority.ts';
import { RetentionDispositionAuthorityUnavailableLive } from '../src/actions/privacy-retention-disposition-authority.ts';
import { DsrDeadlineAuthorityUnavailableLive } from '../src/actions/record-dsr-deadline.action.ts';
import { DsrDeliveryAuthorityUnavailableLive } from '../src/actions/record-dsr-delivery-evidence.action.ts';
import { DsrVerificationAuthorityUnavailableLive } from '../src/actions/record-dsr-verification.action.ts';
import {
  NoticeChannelDeliveryAuthority,
  NoticeChannelDeliveryAuthorityUnavailableLive,
} from '../src/actions/record-notice-provision.action.ts';
import { DsrDeliveryAccessAuthorityUnavailableLive } from '../src/actions/dsr-delivery-access-authority.ts';
import { ProcessingInterventionAuthorityUnavailableLive } from '../src/actions/processing-intervention-authority.ts';

/** Build the native runtime with fresh pre-transaction evidence for each invocation. */
const privacyConsentAuthorityActionRuntimeLive: Layer.Layer<
  ActionRuntime,
  never,
  ActionRuntime | CommerceConsentAuthorityLookup | Layer.Services<ReturnType<typeof makeActionRuntimeLive>>
> = Layer.effect(
  ActionRuntime,
  Effect.gen(function* privacyConsentAuthorityActionRuntime() {
    const existing = yield* ActionRuntime;
    const lookup = yield* CommerceConsentAuthorityLookup;
    const dependencies = yield* Effect.context<Layer.Services<ReturnType<typeof makeActionRuntimeLive>>>();
    const runAction: ActionRuntimeService['runAction'] = (input) =>
      Effect.scoped(
        Effect.gen(function* runConsentAwareAction() {
          const execution = yield* preparedCommerceConsentExecution.pipe(
            Effect.provideService(CommerceConsentAuthorityLookup, lookup),
          );
          const scope = yield* Effect.scope;
          const runtimeContext = yield* Layer.buildWithScope(
            makeActionRuntimeLive(ultramodernDeliveryUnit),
            scope,
          ).pipe(Effect.provideContext(Context.add(dependencies, ActionAuthorizationPreflight, execution.preflight)));
          return yield* Context.get(runtimeContext, ActionRuntime)
            .runAction(input)
            .pipe(
              Effect.provideService(ConsentSelfServiceAuthority, execution.authority),
              Effect.provideService(NoticeChannelDeliveryAuthority, execution.noticeAuthority),
            );
        }),
      );
    return { ...existing, runAction };
  }),
);

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
    Schema.decodeUnknownEffect(privacyMarkerSchema)(ultramodernApiMarker).pipe(
      Effect.orDie,
      Effect.map((marker) => ({
        checks: {
          api: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      })),
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
const compositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
    ),
  ),
);
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = Layer.provide(
  OperationalScopeResolverLive,
  Layer.mergeAll(CorePersistenceLive, ContextAccessLive),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const privacyActionAuthorityUnavailableLive = Layer.mergeAll(
  ConsentSelfServiceAuthorityUnavailableLive,
  PrivacyApplicabilityBusinessFactAuthorityUnavailableLive,
  DsrDeadlineAuthorityUnavailableLive,
  DsrDeliveryAuthorityUnavailableLive,
  DsrDeliveryAccessAuthorityUnavailableLive,
  DsrIntakeReceiptAuthorityUnavailableLive,
  DsrOwnerInventoryAuthorityUnavailableLive,
  DsrOwnerTaskAuthorityUnavailableLive,
  DsrSubstantiveDecisionAuthorityUnavailableLive,
  OwnerExecutionAuthorityUnavailableLive,
  AntiResurrectionEnforcementAuthorityUnavailableLive,
  RetentionDispositionAuthorityUnavailableLive,
  ProcessingActivityCoverageAuthorityUnavailableLive,
  RetentionRuleGovernanceAuthorityUnavailableLive,
  DsrVerificationAuthorityUnavailableLive,
  NoticeChannelDeliveryAuthorityUnavailableLive,
  ProcessingInterventionAuthorityUnavailableLive,
);
const productionReadRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
  Layer.provideMerge(PrivacyApplicabilityBusinessFactAuthorityUnavailableLive),
);
const productionActionRuntimeLive = privacyConsentAuthorityActionRuntimeLive.pipe(
  Layer.provideMerge(makeActionRuntimeLive(ultramodernDeliveryUnit)),
  Layer.provide(Layer.effect(CommerceConsentAuthorityLookup, commerceConsentAuthorityLookup)),
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      ActionAuthorizationPreflightDatabaseLive.pipe(Layer.provideMerge(CorePersistenceLive)),
      ActiveApplicationCompositionConfigLive.pipe(Layer.provide(compositionSourceLive)),
    ),
  ),
  Layer.provide(DatabaseConfigLive),
  Layer.provideMerge(privacyActionAuthorityUnavailableLive),
);

type PrivacyApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<
    Layer.Success<typeof productionReadRuntimeLive>,
    Layer.Error<typeof productionReadRuntimeLive>
  >,
  actionRuntime: Layer.Layer<
    Layer.Success<typeof productionActionRuntimeLive>,
    Layer.Error<typeof productionActionRuntimeLive>
  >,
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
    addProcessingPurposeVersionActionApiLive,
    applicabilityDecisionsReadApiLive,
    assignDsrResolverActionApiLive,
    assignLegalBasisActionApiLive,
    assignPrivacyResponsibilityActionApiLive,
    consentSelfServiceActionApiLive,
    createDsrCaseActionApiLive,
    createNoticeVersionActionApiLive,
    createPrivacySubjectActionApiLive,
    createProcessingActivityActionApiLive,
    createProcessingPurposeActionApiLive,
    currentConsentReadApiLive,
    dispatchPrivacyMeasureActionApiLive,
    dsrCasesReadApiLive,
    enqueueRetentionEvaluationActionApiLive,
    evaluateProcessingEligibilityActionApiLive,
    issueDsrDeliveryAccessActionApiLive,
    legalBasisAssignmentsReadApiLive,
    noticeVersionsReadApiLive,
    ownerInventoryReadApiLive,
    privacySubjectsReadApiLive,
    processingActivitiesReadApiLive,
    processingEligibilityReadApiLive,
    processingPurposesReadApiLive,
    recordAntiResurrectionProtectionActionApiLive,
    recordApplicabilityPolicyActionApiLive,
    recordConsentDecisionActionApiLive,
    recordDispositionDecisionActionApiLive,
    recordDsrDeadlineActionApiLive,
    recordDsrDeliveryEvidenceActionApiLive,
    recordDsrResponseActionApiLive,
    recordDsrSubstantiveDecisionActionApiLive,
    recordDsrVerificationActionApiLive,
    recordExternalObligationActionApiLive,
    recordLegalHoldActionApiLive,
    recordNoticeProvisionActionApiLive,
    recordOwnerContributionActionApiLive,
    recordOwnerExecutionOutcomeActionApiLive,
    recordPrivacyApplicabilityActionApiLive,
    recordPrivacyRepresentationActionApiLive,
    recordProcessingInterventionActionApiLive,
    recordRetentionExceptionActionApiLive,
    responsibilityAssignmentsReadApiLive,
    retentionRulesReadApiLive,
    transitionProcessingActivityActionApiLive,
    updateDsrCaseActionApiLive,
    upsertDsrOwnerTaskActionApiLive,
    upsertRetentionRuleActionApiLive,
    upsertTemporaryDsrExportActionApiLive,
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(RequestSchemaProblemLive));
  const requestServicesLive = Layer.mergeAll(governedReadRuntimeLive, governedActionRuntimeLive).pipe(
    Layer.provideMerge(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)),
    Layer.provideMerge(Layer.mergeAll(runtimeObservabilityLive, compositionSourceLive)),
    Layer.orDie,
  );
  return assembleEffectBffRuntime({
    api: privacyApi,
    handlers: apiHandlersLive,
    services: requestServicesLive,
  });
};

const apiRuntime = makePrivacyApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;
