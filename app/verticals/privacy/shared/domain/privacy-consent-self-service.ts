import { Effect, Schema } from 'effect';

import { ConsentDecisionKindSchema } from './privacy-consent-decision.ts';
import type { ConsentDecision } from './privacy-consent-decision.ts';
import { ConsentScopeSchema } from './privacy-consent-scope.ts';
import { PrivacyIsoTimestampSchema } from './privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * The two supported retail paths deliberately have different authority.
 * A profile binding is a current Commerce fact; an operation-scoped context
 * is a temporary consent channel and must never become an account or principal.
 */
export const ConsentSelfServicePathSchema = Schema.Union([
  Schema.Struct({
    bindingRef: Ref,
    bindingState: Schema.Literals(['ACTIVE', 'REVOKED']),
    kind: Schema.Literal('CURRENT_PROFILE_BINDING'),
    permission: Schema.Literal('retail.consent.manage'),
    permissionGranted: Schema.Boolean,
    profileRef: Ref,
  }),
  Schema.Struct({
    contextRef: Ref,
    expiresAt: PrivacyIsoTimestampSchema,
    kind: Schema.Literal('OPERATION_SCOPED'),
    operationRef: Ref,
    proofRef: Ref,
  }),
]);
export type ConsentSelfServicePath = typeof ConsentSelfServicePathSchema.Type;

export const ConsentSelfServiceRequestSchema = Schema.Struct({
  decision: ConsentDecisionKindSchema,
  path: ConsentSelfServicePathSchema,
  scope: ConsentScopeSchema,
});
export type ConsentSelfServiceRequest = typeof ConsentSelfServiceRequestSchema.Type;

export const ConsentSelfServiceOutcomeSchema = Schema.Literals([
  'ALLOWED_PROFILE',
  'ALLOWED_OPERATION_SCOPED',
  'PROFILE_BINDING_REQUIRED',
  'PROFILE_PERMISSION_REQUIRED',
  'OPERATION_CONTEXT_REQUIRED',
  'OPERATION_CONTEXT_EXPIRED',
]);
export type ConsentSelfServiceOutcome = typeof ConsentSelfServiceOutcomeSchema.Type;

export const ConsentSelfServiceAuthorizationSchema = Schema.Struct({
  allowed: Schema.Boolean,
  authority: Schema.Literals(['CONSENT_ONLY', 'RETAIL_PROFILE_CONSENT']),
  outcome: ConsentSelfServiceOutcomeSchema,
});
export type ConsentSelfServiceAuthorization = typeof ConsentSelfServiceAuthorizationSchema.Type;

export class ConsentSelfServiceAuthorizationError extends Schema.TaggedError<ConsentSelfServiceAuthorizationError>()(
  'ConsentSelfServiceAuthorizationError',
  { reason: Schema.String },
) {}

/**
 * Evaluate the independent self-service gate. Consent management is not
 * profile management: the operation-scoped path grants no reusable identity,
 * account, or other module permission.
 */
export const authorizeConsentSelfService = (input: {
  readonly now: string;
  readonly path: ConsentSelfServicePath;
}): ConsentSelfServiceAuthorization => {
  if (input.path.kind === 'CURRENT_PROFILE_BINDING') {
    if (input.path.bindingState !== 'ACTIVE') {
      return { allowed: false, authority: 'RETAIL_PROFILE_CONSENT', outcome: 'PROFILE_BINDING_REQUIRED' };
    }
    if (!input.path.permissionGranted) {
      return { allowed: false, authority: 'RETAIL_PROFILE_CONSENT', outcome: 'PROFILE_PERMISSION_REQUIRED' };
    }
    return {
      allowed: true,
      authority: 'RETAIL_PROFILE_CONSENT',
      outcome: 'ALLOWED_PROFILE',
    };
  }
  if (input.path.expiresAt <= input.now) {
    return {
      allowed: false,
      authority: 'CONSENT_ONLY',
      outcome: 'OPERATION_CONTEXT_EXPIRED',
    };
  }
  return {
    allowed: true,
    authority: 'CONSENT_ONLY',
    outcome: 'ALLOWED_OPERATION_SCOPED',
  };
};

/** Account-free withdrawal is valid on an authorized operation-scoped path. */
export const isAccountFreeConsentWithdrawal = (input: ConsentSelfServiceRequest): boolean =>
  input.decision === 'WITHDRAWN' && input.path.kind === 'OPERATION_SCOPED';

/** Keep the shared immutable decision contract as the only persisted fact. */
export const consentDecisionFromSelfService = (input: {
  readonly authorization: ConsentSelfServiceAuthorization;
  readonly decision: ConsentDecision;
}): Effect.Effect<ConsentDecision, ConsentSelfServiceAuthorizationError> => {
  if (!input.authorization.allowed) {
    return Effect.fail(
      new ConsentSelfServiceAuthorizationError({ reason: 'Consent self-service authorization is not allowed' }),
    );
  }
  return Effect.succeed(input.decision);
};
