import { HttpApiMiddleware } from '@modern-js/bff-effect/effect-edge';
import { Effect } from 'effect';

import {
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
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
 * reason, an Attempt identity the caller did not already name, or any part of the credential: a
 * failing owner value is preserved as a non-enumerable `cause` for diagnostics and never encoded.
 */

const PROBLEM_TYPE_PREFIX = 'https://ontos.dev/problems/commerce-portal-auth-enrollment-';

const problemStatus = {
  unavailable: 503,
} as const;

/** The failing value is retained as a non-enumerable `cause`; it never reaches the encoded body. */
const withCause = <Problem extends object>(problem: Problem, cause: unknown): Problem =>
  cause === undefined ? problem : Object.defineProperty(problem, 'cause', { configurable: true, value: cause });

export const commercePortalAuthEnrollmentInvalidProblem = (cause?: unknown) =>
  withCause(
    CommercePortalAuthEnrollmentInvalidProblemSchema.make({
      code: 'invalid_request',
      detail: 'The Commerce portal enrollment request is invalid.',
      status: 400,
      title: 'Invalid enrollment request',
      type: `${PROBLEM_TYPE_PREFIX}invalid`,
    }),
    cause,
  );

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
export const commercePortalAuthEnrollmentRejectedProblem = (cause?: unknown) =>
  withCause(forbiddenProblem('enrollment_rejected'), cause);

/** An Attempt owned by another subject answers exactly as an absent one does. */
export const commercePortalAuthEnrollmentNotFoundProblem = (cause?: unknown) =>
  withCause(
    CommercePortalAuthEnrollmentNotFoundProblemSchema.make({
      code: 'attempt_not_found',
      detail: 'No Commerce portal enrollment attempt is available for this caller.',
      status: 404,
      title: 'Enrollment attempt not found',
      type: `${PROBLEM_TYPE_PREFIX}not-found`,
    }),
    cause,
  );

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

/** The failing owner value is retained for diagnostics; it never reaches the encoded body. */
export const commercePortalAuthEnrollmentUnavailableProblem = (cause?: unknown) =>
  withCause(
    CommercePortalAuthEnrollmentUnavailableProblemSchema.make({
      code: 'enrollment_unavailable',
      detail: 'Commerce portal enrollment is temporarily unavailable.',
      retryable: true,
      status: problemStatus.unavailable,
      title: 'Enrollment unavailable',
      type: `${PROBLEM_TYPE_PREFIX}unavailable`,
    }),
    cause,
  );

export const commercePortalAuthEnrollmentSchemaErrorLive = HttpApiMiddleware.layerSchemaErrorTransform(
  CommercePortalAuthEnrollmentSchemaErrorMiddleware,
  // The schema failure is preserved as the problem's non-enumerable `cause`; the encoded body
  // stays the group's one invalid-request answer and never names the offending field.
  (schemaFailure) => Effect.fail(commercePortalAuthEnrollmentInvalidProblem(schemaFailure)),
);
