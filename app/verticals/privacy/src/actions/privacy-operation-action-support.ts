import type {
  ActionCollectorError,
  ActionHandlerContext,
  DomainEventContractMap,
  OutboxMessage,
  OperationalScope,
} from '@app/core-runtime';
/* eslint-disable effect-native/no-unbranded-identifier-schema -- Audit evidence retains the owner-issued opaque record identity from a validated Privacy result. expires: 2027-03-31. */
import { Effect, Option, Schema } from 'effect';

import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import { validateConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/privacy-consent-decision-recorded.ts';
import type { PurposeVersion } from '../../shared/domain/processing-purpose.ts';
import { ProcessingPurposeRefSchema } from '../../shared/resources/processing-purpose.ts';
import type {
  OwnerExecutionAuthorityResult,
  OwnerExecutionOutcomeRequest,
  PrivacyMeasureHandoff,
} from '../../shared/domain/privacy-measure-handoff.ts';
import { validateOwnerExecutionAuthorityResult } from '../../shared/domain/privacy-measure-handoff.ts';
import { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-repository.ts';
import type { PrivacyOperationRepositoryService } from '../persistence/privacy-operation-repository.ts';
import type { ProcessingPurposeRepositoryService } from '../persistence/processing-purpose-repository.ts';
import type { OwnerExecutionAuthorityService } from './privacy-owner-execution-authority.ts';
import { PrivacyActionRejected } from './privacy-action-rejected.ts';
import { PrivacyActionScopeRequired } from './privacy-action-scope-required.ts';

export { PrivacyActionRejected } from './privacy-action-rejected.ts';
export { PrivacyActionScopeRequired } from './privacy-action-scope-required.ts';

export const PrivacyActionErrorSchema = Schema.Union([
  PrivacyActionRejected,
  PrivacyActionScopeRequired,
  PrivacyOperationPersistenceError,
]);

export const PrivacyActionAuditEvidenceSchema = Schema.Struct({
  operationKind: Schema.String,
  recordId: Schema.String,
});

export const privacyActionDomainEvents = {} as const;

export const privacyConsentDecisionDomainEvents = {
  'privacy.consent.decision.recorded': OutboxPayloadSchema,
} as const;

export interface TrustedPrivacyActionScope {
  readonly legalEntityId: string;
  readonly tenantId: string;
}

export const requirePrivacyActionScope = (
  scope: OperationalScope,
): Effect.Effect<TrustedPrivacyActionScope, PrivacyActionScopeRequired> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new PrivacyActionScopeRequired({
          code: 'privacy_action_scope_required',
          reason: 'The Privacy operation requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });

type OwnerExecutionAuthorityActionServices = Pick<PrivacyOperationRepositoryService, 'getPrivacyMeasureHandoff'> & {
  readonly authority: OwnerExecutionAuthorityService;
};

interface ValidatedOwnerExecutionAuthority {
  readonly authority: OwnerExecutionAuthorityResult;
  readonly handoff: PrivacyMeasureHandoff;
}

export const resolveOwnerExecutionAuthority = Effect.fn('PrivacyOperationActionSupport.resolveOwnerExecutionAuthority')(
  function* resolveOwnerExecutionAuthorityEffect(
    request: OwnerExecutionOutcomeRequest,
    scope: TrustedPrivacyActionScope,
    context: ActionHandlerContext<typeof privacyActionDomainEvents, OwnerExecutionAuthorityActionServices>,
  ): Effect.fn.Return<ValidatedOwnerExecutionAuthority, PrivacyActionRejected | PrivacyOperationPersistenceError> {
    const handoffOption = yield* context.services.getPrivacyMeasureHandoff(
      scope.tenantId,
      scope.legalEntityId,
      request.measureId,
    );
    if (Option.isNone(handoffOption)) {
      return yield* new PrivacyOperationPersistenceError({
        code: 'privacy_operation_not_found',
        reason: 'Privacy Measure dispatch was not found',
      });
    }
    const authority = yield* context.services.authority.resolve(request, {
      actionInvocationId: context.actionInvocationId,
      handoff: handoffOption.value,
      legalEntityId: scope.legalEntityId,
      principalId: context.scope.principalId,
      tenantId: scope.tenantId,
    });
    const authorityError = validateOwnerExecutionAuthorityResult(handoffOption.value, request, authority);
    if (authorityError !== undefined) {
      return yield* new PrivacyActionRejected({ code: 'privacy_action_rejected', reason: authorityError });
    }
    return { authority, handoff: handoffOption.value };
  },
);

const samePurposeRef = Schema.toEquivalence(ProcessingPurposeRefSchema);

export const loadAndValidateConsentPurpose = Effect.fn('PrivacyAction.loadAndValidateConsentPurpose')(
  function* loadAndValidateConsentPurposeEffect(
    decision: ConsentDecision,
    scope: TrustedPrivacyActionScope,
    getPurpose: ProcessingPurposeRepositoryService['get'],
  ) {
    const purposeOption = yield* getPurpose(
      scope.tenantId,
      scope.legalEntityId,
      decision.scope.processingPurposeRef.resourceId,
    ).pipe(
      Effect.mapError(
        (error) =>
          new PrivacyOperationPersistenceError({
            code: 'privacy_operation_persistence_unavailable',
            reason: error.reason,
          }),
      ),
    );
    if (Option.isNone(purposeOption)) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Consent Decision must reference an authoritative Processing Purpose',
      });
    }
    if (!samePurposeRef(purposeOption.value.purposeRef, decision.scope.processingPurposeRef)) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Consent Decision must reference the exact authoritative Processing Purpose identity',
      });
    }
    const purposeVersion = purposeOption.value.versions.find(
      ({ versionId }) => versionId === decision.scope.purposeVersionRef,
    );
    if (purposeVersion === undefined) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Consent Decision must reference an authoritative Purpose Version',
      });
    }
    if (
      purposeVersion.effectiveFrom > decision.effectiveAt ||
      (purposeVersion.effectiveTo !== null && decision.effectiveAt >= purposeVersion.effectiveTo)
    ) {
      return yield* new PrivacyActionRejected({
        code: 'privacy_action_rejected',
        reason: 'Consent Decision effective time must fall within the referenced Purpose Version period',
      });
    }
    const reason = validateConsentDecision(decision, purposeVersion, purposeVersion.requiredConsentDimensions ?? []);
    if (reason !== undefined) {
      return yield* new PrivacyActionRejected({ code: 'privacy_action_rejected', reason });
    }
    return purposeVersion satisfies PurposeVersion;
  },
);

export const completePrivacyAction = <DomainEvents extends DomainEventContractMap, Result>(
  context: Pick<ActionHandlerContext<DomainEvents, unknown>, 'recordAuditEvidence'>,
  operationKind: string,
  recordId: string,
  result: Result,
): Effect.Effect<Result, ActionCollectorError> =>
  context.recordAuditEvidence({ operationKind, recordId }).pipe(Effect.as(result));

export const completeConsentDecisionAction = Effect.fn('PrivacyOperationActionSupport.completeConsentDecisionAction')(
  function* completeConsentDecisionActionEffect<Services>(
    context: ActionHandlerContext<typeof privacyConsentDecisionDomainEvents, Services>,
    operationKind: string,
    result: ConsentDecision,
    createOutboxMessage: (payload: { readonly decision: ConsentDecision }) => OutboxMessage,
  ) {
    const eventPayload = { decision: result };
    const event = yield* context.addDomainEvent({
      eventType: 'privacy.consent.decision.recorded',
      payloadJson: eventPayload,
      producerModuleKey: 'privacy.core',
      subjectModuleKey: 'privacy.core',
      subjectResourceId: result.scope.privacySubjectRef.resourceId,
      subjectResourceType: result.scope.privacySubjectRef.resourceType,
    });
    yield* context.addOutboxMessage(event, createOutboxMessage(eventPayload));
    yield* context.recordAuditEvidence({ operationKind, recordId: result.decisionId });
    return result;
  },
);
