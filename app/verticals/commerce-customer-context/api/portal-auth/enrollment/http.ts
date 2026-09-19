import { createHmac } from 'node:crypto';

import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Cause, Effect, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import type { ActionRegistration, DomainEventContractMap } from '@app/core-runtime';

import { authenticateOperationPrincipal } from '../../auth/action-principal.ts';
import { bindActionHttpRunner } from '../../action-http-runner.ts';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { claimPortalEnrollmentTransitionAction } from '../../../src/actions/claim-portal-enrollment-transition.action.ts';
import { startPortalEnrollmentAction } from '../../../src/actions/start-portal-enrollment.action.ts';
import { CommerceEnrollmentContinuation } from '../../../src/enrollment/continuation/enrollment-continuation.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import { EnrollmentTenantIdSchema, ReadEnrollmentAttemptInputSchema } from '../../../shared/enrollment-contracts.ts';
import { CommerceEnrollmentAttemptUnavailable } from '../../../src/enrollment/attempts/errors.ts';
import type { EnrollmentAttemptIdSchema } from '../../../shared/enrollment-contracts.ts';
import { noStoreHeaders, requireTrustedOrigin, resolveClientKey } from '../http-transport.ts';
import { CommercePortalAuthAccountCreationService } from '../provider/account-create.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../provider/account-creation-unavailable.ts';
import { CommercePortalAuthConfig } from '../provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import {
  CommercePortalAuthEnrollmentStartInputSchema,
  commercePortalAuthEnrollmentAttemptProjection,
} from './contracts.ts';
import type { CommercePortalAuthEnrollmentStartInput } from './contracts.ts';
import { commercePortalAuthEnrollmentAccountCreationClaim, commercePortalAuthEnrollmentIntent } from './intent.ts';
import {
  commercePortalAuthEnrollmentAuthenticationProblem,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentNotFoundProblem,
  commercePortalAuthEnrollmentRateLimitedProblem,
  commercePortalAuthEnrollmentRejectedProblem,
  commercePortalAuthEnrollmentSchemaErrorLive,
  commercePortalAuthEnrollmentUnavailableProblem,
  commercePortalAuthEnrollmentUntrustedOriginProblem,
} from './problems.ts';

/**
 * The Commerce Portal Enrollment transport.
 *
 * This is the one route that carries an enrollment credential, and it carries it exactly as far as
 * the private provider account-creation port: the password is `Redacted` from decode to dispatch,
 * never enters the durable Enrollment Attempt, never reaches an intent or request digest, and is
 * never logged. What the Attempt records is the account subject the provider answered with.
 *
 * Start is three governed steps in the order the Attempt journal requires: create (or converge on)
 * the Attempt, durably claim the `provider.account.create` transition for a fresh owner invocation,
 * then perform the single provider effect that claim authorizes. A caller that skips a step cannot
 * reach the provider: the private account-creation capability refuses any invocation the Attempt
 * has not already claimed.
 */

const ENROLLMENT_START_ROUTE = '/enrollment/start';

/** Account creation is the throttled resource, so the route spends that policy's budget. */
const enrollmentStartRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.windowSeconds,
};

const runActionHttp = bindActionHttpRunner({
  authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
  unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
});

/**
 * The enrollment subject is part of the budget key, never the counter store's contents: it is keyed
 * under the deployment secret, so the durable `rate_limit` rows stay a set of opaque digests rather
 * than a readable list of the addresses people are enrolling with.
 */
const enrollmentSubjectKey = (subject: string, secret: Redacted.Redacted): string =>
  createHmac('sha256', Redacted.value(secret)).update(subject).digest('base64url');

/**
 * The origin gate runs before the budget is spent, exactly as the sibling sign-in and recovery
 * transports order it: an enrollment body is a CORS simple request, so a third-party page can drive
 * a visitor's browser into this handler, and spending first would let that page burn the named
 * address's account-creation budget and collect a 403 only afterwards.
 *
 * The key names the resolved client and the address the attempt is for. The address half is what
 * keeps one caller from denying enrollment to everybody: this vertical is served by a web handler
 * whose request carries no socket peer (`../http-transport.ts`), so a client-only key would be a
 * single deployment-wide counter that any caller could spend.
 */
const consumeEnrollmentBudget = Effect.fn('CommercePortalAuthEnrollmentHttp.rateLimit')(
  function* consumeEnrollmentBudgetEffect(request: HttpServerRequest.HttpServerRequest, email: string) {
    const configuration = yield* CommercePortalAuthConfig;
    const client = resolveClientKey(request, configuration.trustedProxies);
    const scope = enrollmentSubjectKey(email, configuration.secret);
    const allowed = yield* consumeRateLimitBudget(
      `${client}|${scope}|${ENROLLMENT_START_ROUTE}`,
      enrollmentStartRateLimit,
      {
        route: ENROLLMENT_START_ROUTE,
        unavailable: (failure) => commercePortalAuthEnrollmentUnavailableProblem(failure),
      },
    );
    if (!allowed) {
      return yield* Effect.fail(commercePortalAuthEnrollmentRateLimitedProblem);
    }
    return yield* Effect.void;
  },
);

const isAttemptUnavailable = Schema.is(CommerceEnrollmentAttemptUnavailable);
const isAccountCreationUnavailable = Schema.is(CommercePortalAuthAccountCreationUnavailable);

/**
 * Every governed Action failure this route can surface collapses to two public answers. An Attempt
 * the owner reports as retryably unavailable is the retryable 503; every other governed refusal is
 * the owner's closed-vocabulary 403, so a caller never learns which governed rule refused it. The
 * failing value is preserved as the problem's `cause` either way.
 */
const actionProblem = (error: { readonly _tag: string }) =>
  isAttemptUnavailable(error)
    ? commercePortalAuthEnrollmentUnavailableProblem(error)
    : commercePortalAuthEnrollmentRejectedProblem(error);

/**
 * The governed Action transport reads the caller's own wire headers verbatim — the authorization
 * assertion it will verify, and the correlation and trace identities the caller published. They are
 * request data forwarded to the runner, not an identity this module threads through its own call
 * graph.
 */
const actionRequestHeaders = (request: HttpServerRequest.HttpServerRequest) => ({
  authorization: Redacted.make(request.headers['authorization']),
  'x-correlation-id': request.headers['x-correlation-id'],
});

const actionEndpointHeaders = (request: HttpServerRequest.HttpServerRequest, idempotencyKey: string | undefined) => ({
  idempotencyKey,
  traceId: request.headers['x-trace-id'],
});

/**
 * Hand the rest of the journey to the continuation and answer the caller immediately.
 *
 * The fork is detached on purpose: the journey's remaining owner effects must not run inside this
 * request's scope, because cancelling the HTTP request would then cancel a claimed owner transition
 * mid-flight. Nothing is lost by detaching — every phase is durable, the claim leases are the only
 * thing that grants ownership, and a lapsed lease is re-claimed by the next `advance`. The
 * continuation bounds its own concurrency, so a burst of enrollments queues rather than floods the
 * owners. A failure here is an operator fact about a still-advanceable Attempt, never a failed
 * start: the account and the Attempt are already committed.
 */
const triggerEnrollmentContinuation = (
  continuation: typeof CommerceEnrollmentContinuation.Service,
  attempt: { readonly portalEnrollmentAttemptId: string; readonly tenantId: string },
) =>
  Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)(attempt).pipe(
    Effect.flatMap((identity) => continuation.advance(identity)),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment continuation did not advance this Attempt'), {
          cause: Cause.pretty(cause),
          portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        }),
      onSuccess: (result) =>
        result.outcome === 'COMPLETE'
          ? Effect.void
          : Effect.annotateLogs(Effect.logInfo('The Commerce enrollment journey halted before completion'), {
              portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
              reason: result.halt.reason,
            }),
    }),
    Effect.forkDetach,
    Effect.asVoid,
  );

/**
 * Start one enrollment. The Attempt is created by the governed `start-portal-enrollment` Action,
 * so its Tenant, Actor and invocation identity come from the governed context rather than from
 * this body, and a repeated equivalent request converges on the Attempt that already exists.
 */
const startEnrollment = Effect.fn('CommercePortalAuthEnrollmentHttp.start')(function* startEnrollmentEffect(
  payload: Schema.Codec.Encoded<typeof CommercePortalAuthEnrollmentStartInputSchema>,
  idempotencyKey: string | undefined,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthEnrollmentUntrustedOriginProblem);
  const input: CommercePortalAuthEnrollmentStartInput = yield* Schema.decodeEffect(
    CommercePortalAuthEnrollmentStartInputSchema,
  )(payload).pipe(Effect.mapError(commercePortalAuthEnrollmentInvalidProblem));
  const email = input.email.trim().toLowerCase();
  yield* consumeEnrollmentBudget(request, email);

  const runEnrollmentAction = <
    PayloadSchema extends Schema.ConstraintDecoder<unknown> & Schema.ConstraintEncoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
    DomainEvents extends DomainEventContractMap,
    Owner extends string,
    Services,
    HandlerRequirements,
  >(
    registration: ActionRegistration<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements
    >,
    actionPayload: PayloadSchema['Type'],
  ) =>
    runActionHttp({
      endpointHeaders: actionEndpointHeaders(request, idempotencyKey),
      internalProblem: () => commercePortalAuthEnrollmentUnavailableProblem(),
      invalidCorrelationProblem: () => commercePortalAuthEnrollmentInvalidProblem(),
      mapError: actionProblem,
      payload: actionPayload,
      registration,
      requestHeaders: actionRequestHeaders(request),
    });

  const continuation = yield* CommerceEnrollmentContinuation;
  const intent = yield* commercePortalAuthEnrollmentIntent(input).pipe(
    Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
  );
  const started = yield* runEnrollmentAction(startPortalEnrollmentAction, intent);

  const claim = yield* commercePortalAuthEnrollmentAccountCreationClaim(
    input,
    started.attempt.portalEnrollmentAttemptId,
  ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
  const claimed = yield* runEnrollmentAction(claimPortalEnrollmentTransitionAction, {
    expectedRevision: started.attempt.revision,
    ownerInvocationId: claim.ownerInvocationId,
    ownerModuleKey: claim.ownerModuleKey,
    portalEnrollmentAttemptId: started.attempt.portalEnrollmentAttemptId,
    requestDigest: claim.requestDigest,
    transitionKey: claim.transitionKey,
  });

  // A replayed or already-claimed transition has its provider effect recorded already; dispatching
  // a second one would create a second account for the same Attempt. The journey still has to be
  // advanced, so the continuation is triggered on this path too.
  if (claimed.outcome !== 'CLAIMED') {
    yield* triggerEnrollmentContinuation(continuation, claimed.attempt);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(claimed.attempt), outcome: started.outcome };
  }

  const accountCreation = yield* CommercePortalAuthAccountCreationService;
  yield* accountCreation
    .createAccount({
      email: input.email,
      enrollmentAttemptId: claimed.attempt.portalEnrollmentAttemptId,
      name: input.displayName,
      ownerInvocationId: claim.ownerInvocationId,
      // The credential stays `Redacted` across the port boundary: the private capability decodes
      // it itself, so nothing here ever holds the plain value.
      password: input.password,
      tenantId: claimed.attempt.tenantId,
    })
    .pipe(
      Effect.mapError((failure) =>
        isAccountCreationUnavailable(failure)
          ? commercePortalAuthEnrollmentUnavailableProblem(failure)
          : commercePortalAuthEnrollmentRejectedProblem(failure),
      ),
    );

  yield* triggerEnrollmentContinuation(continuation, claimed.attempt);
  return { attempt: commercePortalAuthEnrollmentAttemptProjection(claimed.attempt), outcome: started.outcome };
});

/**
 * Read one Attempt back. The Tenant is the governed one the caller's own gateway assertion names,
 * and the durable read is Tenant-scoped inside PostgreSQL, so an Attempt belonging to another
 * Tenant is not merely hidden — it is unreachable, and answers exactly as an absent one does.
 */
const readEnrollment = Effect.fn('CommercePortalAuthEnrollmentHttp.read')(function* readEnrollmentEffect(
  portalEnrollmentAttemptId: typeof EnrollmentAttemptIdSchema.Type,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
    authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
    unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
  });
  // Decoded for the same reason the Actions decode it: a Tenant this vertical's Attempt
  // vocabulary cannot name must never reach a durable owner read.
  const tenantId = yield* Schema.decodeEffect(EnrollmentTenantIdSchema)(principal.tenantId).pipe(
    Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
  );
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, runner.run);
  const attempt = yield* store
    .read({ portalEnrollmentAttemptId, tenantId })
    .pipe(
      Effect.mapError((failure) =>
        failure.retryable
          ? commercePortalAuthEnrollmentUnavailableProblem(failure)
          : commercePortalAuthEnrollmentNotFoundProblem(failure),
      ),
    );
  return commercePortalAuthEnrollmentAttemptProjection(attempt);
});

/**
 * Root provides the governed Action runtime, the owner transaction runner, the provider account
 * creation capability, the enrollment budget and the realm configuration this group reads. A
 * deployment without the portal realm mounts the fail-closed leaf instead, so both routes answer
 * the retryable 503 rather than accepting a credential the deployment has nowhere to place.
 */
export const portalAuthEnrollmentApiLive = HttpApiBuilder.group(
  commerceCustomerContextApi,
  'portalAuthEnrollment',
  (handlers) =>
    handlers
      .handle('startEnrollment', ({ payload, request }) =>
        startEnrollment(payload, request.headers['idempotency-key'], request),
      )
      .handle('readEnrollment', ({ params, request }) => readEnrollment(params.attemptId, request)),
).pipe(Layer.provide(commercePortalAuthEnrollmentSchemaErrorLive));
