import type { OperationalScope } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { readVerifiedGatewayActor } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Config, DateTime, Effect, Option, Schema } from 'effect';

import { PreVerificationBindingNotFound } from '../../shared/actions/pre-verification-binding-not-found.ts';
import { PreVerificationBindingRejected } from '../../shared/actions/pre-verification-binding-rejected.ts';
import type {
  BindPreVerificationSubjectPayload,
  BindPreVerificationSubjectResult,
  WithdrawPreVerificationBindingPayload,
} from '../../shared/actions/pre-verification-binding-operations.ts';
import type {
  PreVerificationEligibilityRequest,
  PreVerificationEligibilityResponse,
} from '../../shared/apis/pre-verification-eligibility.ts';
import {
  evaluatePreVerificationEligibility,
  PreVerificationBindingPolicySchema,
  preVerificationConsumerAppIdOf,
  preVerificationSourceAppIdOf,
  preVerificationSubjectRefOf,
  resolvePreVerificationPolicy,
} from '../../shared/domain/pre-verification-binding.ts';
import type {
  PreVerificationBindingPolicy,
  PreVerificationNotEvaluatedCause,
} from '../../shared/domain/pre-verification-binding.ts';
import { createPrivacyEligibilityEvidence } from '../../shared/domain/privacy-processing-eligibility.ts';
import { isPrivacyInstantAfter } from '../../shared/domain/privacy-subject.ts';
import type { PrivacyOperationPersistenceError } from '../persistence/privacy-operation-persistence-error.ts';
import type { PreVerificationBindingRepositoryService } from '../persistence/pre-verification-binding-repository.ts';

/**
 * The Privacy owner's pre-verification binding policies of this deployment (PROPOSED configuration key). Each one is a
 * Privacy product and legal decision (controller, purpose version, operation, scope, legal basis, validity); there is no
 * default policy, so an unconfigured deployment binds nothing and evaluates nothing.
 */
const configuredPolicies = Config.schema(
  Schema.fromJsonString(Schema.Array(PreVerificationBindingPolicySchema).check(Schema.isMaxLength(1024))),
  'ONTOS_PRIVACY_PRE_VERIFICATION_BINDING_POLICIES',
).pipe(Config.withDefault([]));

export const preVerificationBindingPolicies = configuredPolicies.pipe(
  Effect.mapError((cause) =>
    Object.defineProperty(
      new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Pre-verification binding policy configuration is unavailable',
      }),
      'cause',
      { configurable: true, value: cause },
    ),
  ),
);

/** What binding needs besides the request: a fresh Privacy identity, the current policies and the binding store. */
export interface PreVerificationBindingServices {
  readonly newBindingRef: Effect.Effect<string>;
  readonly policies: readonly PreVerificationBindingPolicy[];
  readonly repository: Pick<PreVerificationBindingRepositoryService, 'bind'>;
}

/** What answering needs besides the request: the current policies, the binding store and Privacy's interventions. */
export interface PreVerificationEligibilityServices {
  readonly policies: readonly PreVerificationBindingPolicy[];
  readonly repository: Pick<PreVerificationBindingRepositoryService, 'get' | 'interventions'>;
}

const rejected = (reason: PreVerificationBindingRejected['reason']) =>
  new PreVerificationBindingRejected({ code: 'pre_verification_binding_rejected', reason });

/**
 * Binds the Privacy subject of one not yet verified source account. Only the verified module that owns the account may
 * bind it, only while the occurrence the source names is still usable, and only under exactly one current Privacy
 * policy of its exact Tenant and (possibly absent) Legal Entity. A subject Privacy already withdrew stays withdrawn.
 */
export const bindPreVerificationSubject = Effect.fn('PrivacyPreVerification.bind')(function* bind(
  payload: BindPreVerificationSubjectPayload,
  scope: OperationalScope,
  services: PreVerificationBindingServices,
): Effect.fn.Return<
  BindPreVerificationSubjectResult,
  PreVerificationBindingRejected | PrivacyOperationPersistenceError
> {
  if (readVerifiedGatewayActor(scope)?.appId !== preVerificationSourceAppIdOf[payload.source.moduleId]) {
    return yield* rejected('CALLER_NOT_SOURCE');
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  if (!isPrivacyInstantAfter(payload.occurrence.validUntil, now)) {
    return yield* rejected('OCCURRENCE_NOT_CURRENT');
  }
  const resolved = resolvePreVerificationPolicy(
    services.policies,
    {
      legalEntityId: scope.legalEntityId,
      sourceModuleId: payload.source.moduleId,
      sourcePurposeRef: payload.sourcePurposeRef,
      sourceResourceType: payload.source.resourceType,
      tenantId: scope.tenantId,
    },
    now,
  );
  if (resolved.kind === 'NOT_EVALUATED') {
    return yield* rejected(resolved.reasonCode === 'MULTIPLE_CONTEXTS' ? 'AMBIGUOUS_POLICY' : 'NO_CURRENT_POLICY');
  }
  const bound = yield* services.repository.bind({
    bindingRef: yield* services.newBindingRef,
    occurrenceValidUntil: payload.occurrence.validUntil,
    source: payload.source,
  });
  if (bound.kind === 'SCOPE_CONFLICT') {
    return yield* rejected('SCOPE_CONFLICT');
  }
  const { policy } = resolved;
  return {
    bindingRef: bound.record.bindingRef,
    policy: { policyRef: policy.policyRef, revision: policy.revision },
    scope: { ...policy.scope, subjectRef: preVerificationSubjectRefOf(bound.record) },
    status: bound.record.status,
    validUntil: bound.record.validUntil,
  };
});

/** Withdraws one binding of the exact scope as the acting Privacy principal; withdrawing it again changes nothing. */
export const withdrawPreVerificationBinding = Effect.fn('PrivacyPreVerification.withdraw')(function* withdraw(
  payload: WithdrawPreVerificationBindingPayload,
  scope: OperationalScope,
  repository: Pick<PreVerificationBindingRepositoryService, 'withdraw'>,
) {
  const withdrawn = yield* repository.withdraw({
    bindingRef: payload.bindingRef,
    evidenceRef: payload.evidenceRef,
    withdrawnBy: scope.principalId,
  });
  return yield* Option.match(withdrawn, {
    onNone: () => Effect.fail(new PreVerificationBindingNotFound({ code: 'pre_verification_binding_not_found' })),
    onSome: Effect.succeed,
  });
});

/** Only the verified Communications module may ask, and only as itself. */
export const preVerificationConsumerAdmitted = (
  consumerModuleId: PreVerificationEligibilityRequest['consumerModuleId'],
  scope: OperationalScope,
): boolean => readVerifiedGatewayActor(scope)?.appId === preVerificationConsumerAppIdOf[consumerModuleId];

/**
 * The eligibility of one bound subject Now, in the published source-processing answer shape. Nothing about the request
 * is trusted beyond locating Privacy's own binding and policy: the scope is the policy's, the subject Privacy's own.
 */
export const evaluatePreVerificationEligibilityRequest = Effect.fn('PrivacyPreVerification.evaluate')(
  function* evaluate(
    request: PreVerificationEligibilityRequest,
    scope: OperationalScope,
    services: PreVerificationEligibilityServices,
  ): Effect.fn.Return<PreVerificationEligibilityResponse, PrivacyOperationPersistenceError> {
    const evaluatedAt = DateTime.formatIso(yield* DateTime.now);
    const notEvaluated = (reasonCode: PreVerificationNotEvaluatedCause) =>
      ({
        eligibility: { outcome: 'NOT_EVALUATED', reasonCode },
        evaluatedAt,
        outcome: 'DENIED',
        reason: 'AUTHORITY_NOT_CURRENT',
      }) as const;
    if (!preVerificationConsumerAdmitted(request.consumerModuleId, scope)) {
      return { evaluatedAt, outcome: 'DENIED', reason: 'AUTHORITY_NOT_CURRENT' };
    }
    const binding = yield* services.repository.get(request.bindingRef);
    if (Option.isNone(binding)) {
      return notEvaluated('SUBJECT_NOT_FOUND');
    }
    const resolved = resolvePreVerificationPolicy(
      services.policies,
      {
        legalEntityId: scope.legalEntityId,
        operation: request.operation,
        sourceModuleId: binding.value.source.moduleId,
        sourcePurposeRef: request.sourcePurposeRef,
        sourceResourceType: binding.value.source.resourceType,
        tenantId: scope.tenantId,
      },
      evaluatedAt,
    );
    if (resolved.kind === 'NOT_EVALUATED') {
      return notEvaluated(resolved.reasonCode);
    }
    const interventions = yield* services.repository.interventions(resolved.policy.scope.processingScopeRef.scopeId);
    const evaluation = evaluatePreVerificationEligibility({
      asOf: evaluatedAt,
      binding,
      interventions,
      legalEntityId: scope.legalEntityId,
      policy: resolved.policy,
    });
    if (evaluation.kind === 'NOT_EVALUATED') {
      return notEvaluated(evaluation.reasonCode);
    }
    const evidence = createPrivacyEligibilityEvidence(evaluation);
    const { outcome } = evaluation.outcome;
    return outcome === 'ALLOWED'
      ? {
          authorityIncarnation: resolved.policy.policyRef,
          authorityRevision: resolved.policy.revision,
          evaluatedAt,
          evidence,
          outcome,
        }
      : { eligibility: { evidence, outcome }, evaluatedAt, outcome: 'DENIED', reason: 'PROCESSING_NOT_ALLOWED' };
  },
);
