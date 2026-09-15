import { Effect, Schema } from 'effect';

import {
  createPrivacyEligibilityEvidence,
  evaluatePrivacyEligibility,
  IntendedProcessingScopeSchema,
  PrivacyEligibilityEvidenceSchema,
  PrivacyEligibilityOutcomeSchema,
} from './privacy-processing-eligibility.ts';
import type {
  PrivacyEligibilityAuthoritativeReference,
  PrivacyEligibilityPolicyRevision,
  ResolvePrivacyEligibilityInputsInput,
} from './privacy-processing-eligibility.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/** Untrusted consumer declaration. It describes the intended use, but grants no authority. */
export const PrivacyEligibilityConsumerRequestSchema = Schema.Struct({
  boundary: Ref,
  consumerRef: Ref,
  operationRef: Ref,
  requestedScope: IntendedProcessingScopeSchema,
  subjectRef: Ref,
  trustedAsOf: Ref,
});
export type PrivacyEligibilityConsumerRequest = typeof PrivacyEligibilityConsumerRequestSchema.Type;

/** The public result is a decision and safe evidence only; it contains no private source payload. */
export const PrivacyEligibilityConsumerResponseSchema = Schema.Struct({
  boundary: Ref,
  consumerRef: Ref,
  decision: PrivacyEligibilityOutcomeSchema,
  evidence: PrivacyEligibilityEvidenceSchema,
  operationRef: Ref,
  subjectRef: Ref,
});
export type PrivacyEligibilityConsumerResponse = typeof PrivacyEligibilityConsumerResponseSchema.Type;

export class PrivacyEligibilityConsumerContractError extends Schema.TaggedError<PrivacyEligibilityConsumerContractError>()(
  'PrivacyEligibilityConsumerContractError',
  {
    code: Schema.Literals(['scope_mismatch', 'subject_unresolved', 'operation_mismatch']),
    reason: Schema.String,
  },
) {}

export interface ResolveTrustedPrivacyEligibilityInput {
  readonly authoritativeReferences?: readonly PrivacyEligibilityAuthoritativeReference[];
  readonly policyRevisions?: readonly PrivacyEligibilityPolicyRevision[];
  readonly requestedScope: PrivacyEligibilityConsumerRequest['requestedScope'];
  readonly subjectRef: string;
  readonly trustedInputs: ResolvePrivacyEligibilityInputsInput;
}

const sameScope = (
  left: PrivacyEligibilityConsumerRequest['requestedScope'],
  right: PrivacyEligibilityConsumerRequest['requestedScope'],
): boolean => {
  const dataCategoryRefs = new Set(right.dataCategoryRefs);
  const recipientRefs = new Set(right.recipientRefs);
  return (
    left.controllerRef === right.controllerRef &&
    left.operation === right.operation &&
    left.processingScopeRef.scopeId === right.processingScopeRef.scopeId &&
    left.processingScopeRef.scopeType === right.processingScopeRef.scopeType &&
    left.purposeRef === right.purposeRef &&
    left.purposeVersionId === right.purposeVersionId &&
    left.dataCategoryRefs.length === right.dataCategoryRefs.length &&
    left.dataCategoryRefs.every((value) => dataCategoryRefs.has(value)) &&
    left.recipientRefs.length === right.recipientRefs.length &&
    left.recipientRefs.every((value) => recipientRefs.has(value))
  );
};

/**
 * Resolves the public Privacy contract from trusted owner-local inputs. This only returns a
 * decision; it never invokes a consumer operation, changes owner data, or replaces auth gates.
 */
export const evaluatePrivacyEligibilityForConsumer = (
  request: PrivacyEligibilityConsumerRequest,
  trusted: ResolveTrustedPrivacyEligibilityInput,
): Effect.Effect<PrivacyEligibilityConsumerResponse, PrivacyEligibilityConsumerContractError> => {
  if (request.subjectRef !== trusted.subjectRef) {
    return Effect.fail(
      new PrivacyEligibilityConsumerContractError({
        code: 'subject_unresolved',
        reason: 'consumer_subject_does_not_match_trusted_resolution',
      }),
    );
  }
  if (!sameScope(request.requestedScope, trusted.requestedScope)) {
    return Effect.fail(
      new PrivacyEligibilityConsumerContractError({
        code: 'scope_mismatch',
        reason: 'consumer_scope_does_not_match_trusted_resolution',
      }),
    );
  }
  if (request.operationRef !== trusted.trustedInputs.intendedScope.operation) {
    return Effect.fail(
      new PrivacyEligibilityConsumerContractError({
        code: 'operation_mismatch',
        reason: 'consumer_operation_does_not_match_intended_scope',
      }),
    );
  }

  const decision = evaluatePrivacyEligibility(trusted.trustedInputs);
  return Effect.succeed({
    boundary: request.boundary,
    consumerRef: request.consumerRef,
    decision,
    evidence: createPrivacyEligibilityEvidence({
      authoritativeReferences: trusted.authoritativeReferences,
      outcome: decision,
      policyRevisions: trusted.policyRevisions,
    }),
    operationRef: request.operationRef,
    subjectRef: request.subjectRef,
  });
};

/** Consumers may use this only as an additional Business Policy check, never as Permission. */
export const privacyEligibilityAllowsConsumerOperation = (response: PrivacyEligibilityConsumerResponse): boolean =>
  response.operationRef === response.decision.evaluatedScope.operation &&
  response.decision.outcome === 'ALLOWED' &&
  response.evidence.outcome === 'ALLOWED';
