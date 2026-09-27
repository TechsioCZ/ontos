import { HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';

import {
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentConflictProblemSchema,
  CommercePortalAuthEnrollmentForbiddenProblemSchema,
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema,
  CommercePortalAuthEnrollmentNotFoundProblemSchema,
  CommercePortalAuthEnrollmentRateLimitedProblemSchema,
  CommercePortalAuthEnrollmentSchemaErrorMiddleware,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
} from '../../../shared/portal-auth/enrollment-api.ts';

/**
 * Every published enrollment problem body. None of them carries a provider message, an owner
 * reason, an Attempt identity the caller did not already name, or any part of the credential. A
 * problem is exactly its schema: the composed API encodes it closed.
 */

/**
 * Answers with a published problem after logging the failing owner value it stands for. The problem
 * is exactly its schema, because the composed API encodes it closed; the failing value belongs to
 * the operator log, never to the response.
 */
export const answerEnrollmentFailure =
  <Problem>(problem: () => Problem) =>
  <Failure>(failure: Failure) =>
    Effect.logWarning('Commerce portal enrollment answered a failure with a published problem', failure).pipe(
      Effect.andThen(Effect.fail(problem())),
    );

const PROBLEM_TYPE_PREFIX = 'https://ontos.dev/problems/commerce-portal-auth-enrollment-';

const problemStatus = {
  unavailable: 503,
} as const;

export const commercePortalAuthEnrollmentInvalidProblem = () =>
  CommercePortalAuthEnrollmentInvalidProblemSchema.make({
    code: 'invalid_request',
    detail: 'The Commerce portal enrollment request is invalid.',
    status: 400,
    title: 'Invalid enrollment request',
    type: `${PROBLEM_TYPE_PREFIX}invalid`,
  });

export const commercePortalAuthEnrollmentAuthenticationProblem =
  CommercePortalAuthEnrollmentAuthenticationProblemSchema.make({
    code: 'authentication_required',
    detail: 'The Commerce portal enrollment request requires an authenticated caller.',
    status: 401,
    title: 'Enrollment authentication required',
    type: `${PROBLEM_TYPE_PREFIX}authentication`,
  });

const forbiddenProblem = (code: 'enrollment_rejected' | 'origin_not_trusted') =>
  CommercePortalAuthEnrollmentForbiddenProblemSchema.make({
    code,
    detail: 'The Commerce portal enrollment request is not allowed for this caller.',
    status: 403,
    title: 'Enrollment request forbidden',
    type: `${PROBLEM_TYPE_PREFIX}forbidden`,
  });

export const commercePortalAuthEnrollmentUntrustedOriginProblem = forbiddenProblem('origin_not_trusted');
export const commercePortalAuthEnrollmentRejectedProblem = () => forbiddenProblem('enrollment_rejected');

/** An Attempt owned by another subject answers exactly as an absent one does. */
export const commercePortalAuthEnrollmentNotFoundProblem = () =>
  CommercePortalAuthEnrollmentNotFoundProblemSchema.make({
    code: 'attempt_not_found',
    detail: 'No Commerce portal enrollment attempt is available for this caller.',
    status: 404,
    title: 'Enrollment attempt not found',
    type: `${PROBLEM_TYPE_PREFIX}not-found`,
  });

/**
 * The journey itself is refused, not this request: no Attempt is persisted and no provider account
 * is created, so a caller is never left holding an orphaned account for a journey that cannot run.
 */
export const commercePortalAuthEnrollmentJourneyUnavailableProblem =
  CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema.make({
    code: 'enrollment_journey_unavailable',
    detail: 'This Commerce portal enrollment journey is not available.',
    status: 422,
    title: 'Enrollment journey unavailable',
    type: `${PROBLEM_TYPE_PREFIX}journey-unavailable`,
  });

/**
 * The journey has not yet established the Principal Auth Binding an invitation claim is recorded
 * under. It names no transition and no owner: a caller learns only that its own Attempt is not
 * there yet, which is the same thing a read of the Attempt would have told it.
 */
export const commercePortalAuthEnrollmentBindingPendingProblem = () =>
  CommercePortalAuthEnrollmentConflictProblemSchema.make({
    code: 'enrollment_binding_pending',
    detail: 'This Commerce portal enrollment attempt is not ready to claim its invitation yet.',
    status: 409,
    title: 'Enrollment binding pending',
    type: `${PROBLEM_TYPE_PREFIX}binding-pending`,
  });

/**
 * `retryAfterSeconds` names the window of the rule that actually refused the request: the route
 * spends more than one budget per start, each on its own window, and a caller told to wait out the
 * wrong one would still be refused when it retries.
 */
export const commercePortalAuthEnrollmentRateLimitedProblem = (rule: { readonly windowSeconds: number }) =>
  CommercePortalAuthEnrollmentRateLimitedProblemSchema.make({
    code: 'rate_limited',
    detail: 'Too many Commerce portal enrollment attempts.',
    retryAfterSeconds: rule.windowSeconds,
    status: 429,
    title: 'Enrollment request rate limited',
    type: `${PROBLEM_TYPE_PREFIX}rate-limited`,
  });

export const commercePortalAuthEnrollmentUnavailableProblem = () =>
  CommercePortalAuthEnrollmentUnavailableProblemSchema.make({
    code: 'enrollment_unavailable',
    detail: 'Commerce portal enrollment is temporarily unavailable.',
    retryable: true,
    status: problemStatus.unavailable,
    title: 'Enrollment unavailable',
    type: `${PROBLEM_TYPE_PREFIX}unavailable`,
  });

export const commercePortalAuthEnrollmentSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  CommercePortalAuthEnrollmentSchemaErrorMiddleware,
  // The group's one invalid-request answer never names the offending field.
  () => Effect.fail(commercePortalAuthEnrollmentInvalidProblem()),
);
