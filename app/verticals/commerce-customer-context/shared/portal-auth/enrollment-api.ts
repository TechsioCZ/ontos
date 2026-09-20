import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { HttpApiMiddleware } from 'effect/unstable/httpapi';

import {
  CommercePortalAuthEnrollmentAttemptProjectionSchema,
  CommercePortalAuthEnrollmentStartInputSchema,
} from '../../api/portal-auth/enrollment/contracts.ts';
import { EnrollmentAttemptIdSchema } from '../enrollment-contracts.ts';

/**
 * The Commerce Portal Enrollment transport — the credential carrier for the three supported
 * journeys. Two routes only: one that starts an Attempt and dispatches its first owner transition,
 * and one that reads the Attempt projection back for the exact caller that owns it. There is no
 * route that advances, completes or terminates an Attempt from the outside: every later transition
 * travels through the governed enrollment Actions, and `COMPLETE` is derived from durable owner
 * outcomes rather than asserted by a caller.
 */

export const CommercePortalAuthEnrollmentInvalidProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentInvalidProblem',
  400,
  { code: Schema.Literal('invalid_request') },
);
export const CommercePortalAuthEnrollmentAuthenticationProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentAuthenticationProblem',
  401,
  { code: Schema.Literal('authentication_required') },
);
/**
 * `enrollment_rejected` carries the owner's own closed-vocabulary refusal, for instance a journey
 * that does not declare the requested transition or an invitation that belongs to another Tenant.
 */
export const CommercePortalAuthEnrollmentForbiddenProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentForbiddenProblem',
  403,
  { code: Schema.Literals(['enrollment_rejected', 'origin_not_trusted']) },
);
/** An Attempt that this caller does not own is indistinguishable from one that does not exist. */
export const CommercePortalAuthEnrollmentNotFoundProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentNotFoundProblem',
  404,
  { code: Schema.Literal('attempt_not_found') },
);
/**
 * A journey this deployment cannot carry end to end. The Counterparty invitation journey's claim
 * needs a one-time claim proof no owner effect holds yet, so starting one would persist an Attempt
 * and create a provider account that nothing could ever advance. The refusal is deliberately not a
 * 503: nothing about it is retryable until the missing owner design lands.
 */
export const CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentJourneyUnavailableProblem',
  422,
  { code: Schema.Literal('enrollment_journey_unavailable') },
);
export const CommercePortalAuthEnrollmentRateLimitedProblemSchema = makeProblemDetailsSchema(
  'CommercePortalAuthEnrollmentRateLimitedProblem',
  429,
  {
    code: Schema.Literal('rate_limited'),
    retryAfterSeconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  },
);
/**
 * The fail-closed answer a deployment without the Commerce portal realm gives on both routes: the
 * vertical still serves readiness and every business route, and enrollment is retryable-unavailable
 * rather than silently accepting a credential it has nowhere to place.
 */
export const CommercePortalAuthEnrollmentUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'CommercePortalAuthEnrollmentUnavailableProblem',
  503,
  { code: Schema.Literal('enrollment_unavailable') },
);

export class CommercePortalAuthEnrollmentSchemaErrorMiddleware extends HttpApiMiddleware.Service<CommercePortalAuthEnrollmentSchemaErrorMiddleware>()(
  'commerce-customer-context/CommercePortalAuthEnrollmentSchemaErrorMiddleware',
  { error: CommercePortalAuthEnrollmentInvalidProblemSchema },
) {}

const startErrors = [
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentForbiddenProblemSchema,
  CommercePortalAuthEnrollmentJourneyUnavailableProblemSchema,
  CommercePortalAuthEnrollmentRateLimitedProblemSchema,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
] as const;
const readErrors = [
  CommercePortalAuthEnrollmentInvalidProblemSchema,
  CommercePortalAuthEnrollmentAuthenticationProblemSchema,
  CommercePortalAuthEnrollmentForbiddenProblemSchema,
  CommercePortalAuthEnrollmentNotFoundProblemSchema,
  CommercePortalAuthEnrollmentUnavailableProblemSchema,
] as const;

/**
 * The started Attempt, plus whether this request created it or converged on the one an equivalent
 * request already created. The caller never learns an owner invocation identity from this route.
 */
const CommercePortalAuthEnrollmentStartedResultSchema = Schema.Struct({
  attempt: CommercePortalAuthEnrollmentAttemptProjectionSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING']),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/**
 * Paths are declared internal; the BFF runtime republishes them under the MicroVertical prefix, so
 * the public enrollment URLs are `/api/portal-auth/enrollment/...` exactly as written here.
 *
 * The endpoint chain stays a `const`. The MicroVertical API boundary checker walks a root API's
 * operands through const bindings only, so a class declaration hides the composed endpoints from
 * it. The exported group is annotated with a named type alias so its type still has a name:
 * `shared/api.ts` merges roughly a hundred group types into one `HttpApi` and declaration emit
 * serializes that union verbatim, so an anonymous group type pushes the composed contract past the
 * compiler's serialization limit (TS7056).
 */
const commercePortalAuthEnrollmentGroupDefinition = HttpApiGroup.make('portalAuthEnrollment')
  .add(
    HttpApiEndpoint.post('startEnrollment', '/api/portal-auth/enrollment/start', {
      error: startErrors,
      payload: Schema.toEncoded(CommercePortalAuthEnrollmentStartInputSchema),
      success: CommercePortalAuthEnrollmentStartedResultSchema,
    }),
  )
  .add(
    HttpApiEndpoint.get('readEnrollment', '/api/portal-auth/enrollment/:attemptId', {
      error: readErrors,
      // The path parameter is the branded Attempt identity itself, so a value this vertical's
      // vocabulary cannot name is rejected by the group's own 400 before any owner read.
      params: Schema.Struct({ attemptId: EnrollmentAttemptIdSchema }),
      success: CommercePortalAuthEnrollmentAttemptProjectionSchema,
    }),
  )
  .middleware(CommercePortalAuthEnrollmentSchemaErrorMiddleware);

export type CommercePortalAuthEnrollmentGroupContract = HttpApiGroup.HttpApiGroup<
  'portalAuthEnrollment',
  HttpApiGroup.Endpoints<typeof commercePortalAuthEnrollmentGroupDefinition>
>;

const CommercePortalAuthEnrollmentGroup: CommercePortalAuthEnrollmentGroupContract =
  commercePortalAuthEnrollmentGroupDefinition;

export const CommercePortalAuthEnrollmentApi = HttpApi.make('CommercePortalAuthEnrollmentApi').add(
  CommercePortalAuthEnrollmentGroup,
);
