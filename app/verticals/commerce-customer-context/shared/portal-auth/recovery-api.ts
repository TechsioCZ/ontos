import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';

import {
  CommercePortalAuthPasswordResetRequestSchema,
  CommercePortalAuthPasswordResetSchema,
  CommercePortalAuthRecoveryReconciliationConflictClassSchema,
} from '../../api/portal-auth/provider/recovery/contracts.ts';

const recoveryToken = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const callbackURL = Schema.String.check(Schema.isMaxLength(2048));
const providerRejectionCode = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64));

export const CommercePortalAuthRecoveryInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthRecoveryInvalidProblem',
  400,
  {
    code: Schema.Literal('invalid_request'),
  },
);
/** Carries the owner rejection code verbatim; the raw provider body never reaches the client. */
export const CommercePortalAuthRecoveryRejectedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthRecoveryRejectedProblem',
  400,
  {
    code: providerRejectionCode,
  },
);
export const CommercePortalAuthRecoveryForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthRecoveryForbiddenProblem',
  403,
  {
    code: Schema.Literals(['origin_not_trusted', 'invalid_callback_url']),
  },
);
export const CommercePortalAuthRecoveryRateLimitedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthRecoveryRateLimitedProblem',
  429,
  {
    code: Schema.Literal('rate_limited'),
  },
);
export const CommercePortalAuthRecoveryUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthRecoveryUnavailableProblem',
  503,
  {
    code: Schema.Literal('authentication_unavailable'),
  },
);

type CommercePortalAuthRecoveryProblem =
  | typeof CommercePortalAuthRecoveryInvalidProblemSchema.Type
  | typeof CommercePortalAuthRecoveryRejectedProblemSchema.Type
  | typeof CommercePortalAuthRecoveryForbiddenProblemSchema.Type
  | typeof CommercePortalAuthRecoveryRateLimitedProblemSchema.Type
  | typeof CommercePortalAuthRecoveryUnavailableProblemSchema.Type;

/** Every failure the owner recovery service can surface, without the transport-only origin guard. */
export type CommercePortalAuthRecoveryServiceProblem = Exclude<
  CommercePortalAuthRecoveryProblem,
  typeof CommercePortalAuthRecoveryForbiddenProblemSchema.Type
>;

const CommercePortalAuthRecoveryStartedResultSchema = Schema.Struct({
  outcome: Schema.Literal('ACCOUNT_RECOVERY_STARTED'),
});
const CommercePortalAuthRecoveryCompletedResultSchema = Schema.Struct({
  outcome: Schema.Literal('ACCOUNT_RECOVERY_COMPLETED_SAME_SUBJECT'),
});
/** The reset token is validated as a path parameter and never echoed back to the caller. */
export const CommercePortalAuthPasswordResetPendingResultSchema = Schema.Struct({
  callbackURL: Schema.optionalKey(Schema.String),
  outcome: Schema.Literal('PASSWORD_RESET_PENDING'),
});
const CommercePortalAuthEmailVerificationCompletedResultSchema = Schema.Struct({
  outcome: Schema.Literal('EMAIL_VERIFICATION_COMPLETED_SAME_SUBJECT'),
});
/**
 * Raised instead of a normal completion when recovery evidence conflicts. Terminal for the request
 * that produced it: no token is granted, no password is reset, no email is marked verified. The
 * caller learns only that reconciliation is required, never which account or subject was involved.
 */
const CommercePortalAuthRecoveryReconciliationRequiredResultSchema = Schema.Struct({
  conflictClass: CommercePortalAuthRecoveryReconciliationConflictClassSchema,
  outcome: Schema.Literal('ACCOUNT_RECOVERY_RECONCILIATION_REQUIRED'),
});

export class CommercePortalAuthRecoverySchemaErrorMiddleware extends HttpApiMiddleware.Service<CommercePortalAuthRecoverySchemaErrorMiddleware>()(
  'commerce-customer-context/CommercePortalAuthRecoverySchemaErrorMiddleware',
  { error: CommercePortalAuthRecoveryInvalidProblemSchema },
) {}

const providerRouteProblems = [
  CommercePortalAuthRecoveryInvalidProblemSchema,
  CommercePortalAuthRecoveryRejectedProblemSchema,
  CommercePortalAuthRecoveryForbiddenProblemSchema,
  CommercePortalAuthRecoveryRateLimitedProblemSchema,
  CommercePortalAuthRecoveryUnavailableProblemSchema,
] as const;
const callbackRouteProblems = [
  CommercePortalAuthRecoveryInvalidProblemSchema,
  CommercePortalAuthRecoveryForbiddenProblemSchema,
] as const;
const verificationRouteProblems = [
  CommercePortalAuthRecoveryInvalidProblemSchema,
  CommercePortalAuthRecoveryRejectedProblemSchema,
  CommercePortalAuthRecoveryRateLimitedProblemSchema,
  CommercePortalAuthRecoveryUnavailableProblemSchema,
] as const;

/**
 * Paths are declared internal; the BFF runtime republishes them under the MicroVertical prefix,
 * so the public recovery URLs are unchanged by this contract.
 *
 * The endpoint chain stays a `const`. The MicroVertical API boundary checker walks a root API's
 * operands through const bindings only, so a class declaration hides the composed endpoints from
 * it. The exported group is annotated with a named type alias so its type still has a name: `shared/api.ts`
 * merges roughly a hundred group types into one `HttpApi` and declaration emit serializes that
 * union verbatim, so an anonymous group type pushes the composed contract past the compiler's
 * serialization limit (TS7056).
 *
 * The same checker reads declared routes syntactically, so each path is written as a literal
 * rather than composed from `COMMERCE_PORTAL_AUTH_INTERNAL_BASE_PATH`; each literal below is that
 * base path followed by one declared recovery route. Declaring exactly these four routes is what
 * keeps sign-up and unrelated Better Auth endpoints unreachable.
 */
const commercePortalAuthRecoveryGroupDefinition = HttpApiGroup.make('portalAuthRecovery')
  .add(
    HttpApiEndpoint.post('requestPasswordReset', '/api/portal-auth/request-password-reset', {
      error: providerRouteProblems,
      payload: Schema.toEncoded(CommercePortalAuthPasswordResetRequestSchema),
      success: CommercePortalAuthRecoveryStartedResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.post('resetPassword', '/api/portal-auth/reset-password', {
      error: providerRouteProblems,
      payload: Schema.toEncoded(CommercePortalAuthPasswordResetSchema),
      success: Schema.Union([
        CommercePortalAuthRecoveryCompletedResultSchema,
        CommercePortalAuthRecoveryReconciliationRequiredResultSchema,
      ]),
    }),
  )
  .add(
    HttpApiEndpoint.get('resetPasswordCallback', '/api/portal-auth/reset-password/:token', {
      error: callbackRouteProblems,
      params: Schema.Struct({ token: recoveryToken }),
      query: Schema.Struct({ callbackURL: Schema.optionalKey(callbackURL) }),
      success: CommercePortalAuthPasswordResetPendingResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.get('verifyEmail', '/api/portal-auth/verify-email', {
      error: verificationRouteProblems,
      query: Schema.Struct({ token: recoveryToken }),
      success: Schema.Union([
        CommercePortalAuthEmailVerificationCompletedResultSchema,
        CommercePortalAuthRecoveryReconciliationRequiredResultSchema,
      ]),
    }),
  )
  .middleware(CommercePortalAuthRecoverySchemaErrorMiddleware);

export type CommercePortalAuthRecoveryGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthRecovery',
  HttpApiGroup.Endpoints<typeof commercePortalAuthRecoveryGroupDefinition>
>;

const CommercePortalAuthRecoveryGroup: CommercePortalAuthRecoveryGroupContract =
  commercePortalAuthRecoveryGroupDefinition;

export const CommercePortalAuthRecoveryApi = HttpApi.make('CommercePortalAuthRecoveryApi').add(
  CommercePortalAuthRecoveryGroup,
);
