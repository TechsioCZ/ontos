import { createHmac } from 'node:crypto';

import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { Cause, DateTime, Effect, Option, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { bindGovernedActionHttp } from '@app/core-runtime/http/action-runner';
import type { ActionRegistration, DomainEventContractMap, TrustedPrincipalContext } from '@app/core-runtime';

import {
  authenticateOperationPrincipal,
  verifyOperationPrincipalWithoutRedemption,
} from '../../auth/action-principal.ts';
import { commerceCustomerContextApi } from '../../../shared/api.ts';
import { claimPortalEnrollmentTransitionAction } from '../../../src/actions/claim-portal-enrollment-transition.action.ts';
import { startPortalEnrollmentAction } from '../../../src/actions/start-portal-enrollment.action.ts';
import { CommerceEnrollmentContinuation } from '../../../src/enrollment/continuation/enrollment-continuation.ts';
import type { CommerceEnrollmentContinuationResult } from '../../../src/enrollment/continuation/enrollment-continuation.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  ReadEnrollmentAttemptInputSchema,
  RecordEnrollmentOutcomeInputSchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import { CommerceEnrollmentAttemptUnavailable, attemptUnavailable } from '../../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../../src/enrollment/attempts/errors.ts';
import { readCounterpartyInvitationClaimability } from '../../../src/persistence/access-persistence.ts';
import type {
  CommercePortalAccountSubject,
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
} from '../../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../../shared/portal-auth-contracts.ts';
import { noStoreHeaders, requestHeaders, requireTrustedOrigin } from '../http-transport.ts';
import { CommercePortalAuthAccountCreationService } from '../provider/account-create.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../provider/account-creation-unavailable.ts';
import type { CommercePortalAuthAccountCreationRejected } from '../provider/account-creation-rejected.ts';
import type { CommercePortalAccountCreateResult } from '../provider/account-create.ts';
import { CommercePortalAuthAccountLookupService } from '../provider/account-lookup-service.ts';
import { CommercePortalAuthConfig } from '../provider/config-service.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../provider/config.ts';
import { consumeRateLimitBudget } from '../rate-limit-service.ts';
import type { CommercePortalAuthRecoveryRateLimitRule } from '../rate-limit-service.ts';
import { CommercePortalAuthService } from '../session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../session/lifecycle-service.ts';
import { commercePortalAuthEnrollmentClaimInvitation } from './claim-invitation.ts';
import {
  CommercePortalAuthEnrollmentStartInputSchema,
  commercePortalAuthEnrollmentAttemptProjection,
} from './contracts.ts';
import type { CommercePortalAuthEnrollmentStartInput } from './contracts.ts';
import {
  commercePortalAuthEnrollmentAccountCreationClaim,
  commercePortalAuthEnrollmentAccountVerificationClaim,
  commercePortalAuthEnrollmentIntent,
} from './intent.ts';
import type { CommercePortalAuthEnrollmentTransitionClaim } from './intent.ts';
import { commercePortalAuthEnrollmentSessionSubject } from './session-subject.ts';
import {
  commercePortalAuthEnrollmentAuthenticationProblem,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentJourneyUnavailableProblem,
  commercePortalAuthEnrollmentNotFoundProblem,
  commercePortalAuthEnrollmentRateLimitedProblem,
  commercePortalAuthEnrollmentRejectedProblem,
  commercePortalAuthEnrollmentSchemaErrorLive,
  commercePortalAuthEnrollmentUnavailableProblem,
  commercePortalAuthEnrollmentUntrustedOriginProblem,
} from './problems.ts';

/**
 * The one route that carries an enrollment credential: the password is `Redacted` from decode to
 * dispatch and never enters the Attempt, an intent, a request digest or a log.
 *
 * Start is three governed steps — create or converge on the Attempt, durably claim the one
 * transition this route owns for the journey, then record what that claim authorized. For Retail
 * self-enrollment the claim is `provider.account.create` and the effect is the provider sign-up,
 * which the private account-creation capability refuses for any invocation the Attempt has not
 * already claimed. For Existing-account the claim is `provider.account.verify` and what it records
 * is the subject the caller's own portal session is authenticated as; nothing is created.
 */

const ENROLLMENT_START_ROUTE = '/enrollment/start';

/** Account creation is the throttled resource, so the route spends that policy's budget. */
const enrollmentStartRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.windowSeconds,
};

/**
 * Reuses `accountCreation`'s budget: the session subject is the only customer-scoped signal before
 * an account exists, so one policy governs enrollment-start effects whether or not one creates an account.
 */
const enrollmentExistingAccountRateLimit: CommercePortalAuthRecoveryRateLimitRule = {
  max: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.max,
  windowSeconds: COMMERCE_PORTAL_AUTH_POLICY.rateLimit.accountCreation.windowSeconds,
};

/**
 * The governed Action transport for one already authenticated caller.
 *
 * Start is a single composed operation that runs more than one governed Action, and the caller
 * presents one Bearer assertion for all of them. Redemption is what makes that assertion single-use
 * — the deployed store accepts an `(issuer, audience, jti)` exactly once — so authenticating each
 * Action from the same inbound header would spend the assertion on the first Action and leave every
 * later one refusing its own caller as a replay. The assertion is therefore verified and redeemed
 * once for the whole operation and every Action of it runs under that one verified principal.
 */
const runActionHttpAs = (principal: TrustedPrincipalContext) =>
  bindGovernedActionHttp({ authenticate: () => Effect.succeed(principal) });

/**
 * The enrollment subject is part of the budget key, never the counter store's contents: it is keyed
 * under the deployment secret, so the durable `rate_limit` rows stay a set of opaque digests rather
 * than a readable list of the addresses people are enrolling with.
 */
const enrollmentSubjectKey = (subject: string, secret: Redacted.Redacted): string =>
  createHmac('sha256', Redacted.value(secret)).update(subject).digest('base64url');

/**
 * Keys are scoped to the verified Principal and this route, not the unattributable
 * `resolveClientKey` — otherwise a caller could spend another Principal's budget by replaying its assertion.
 */
const enrollmentPrincipalScopeKey = (principalId: string, secret: Redacted.Redacted): string =>
  `${enrollmentSubjectKey(principalId, secret)}|${ENROLLMENT_START_ROUTE}`;

const enrollmentAddressBudgetKey = (principalId: string, email: string, secret: Redacted.Redacted): string =>
  `${enrollmentPrincipalScopeKey(principalId, secret)}|${enrollmentSubjectKey(email, secret)}`;

/**
 * Keyed by (Principal, session subject): the session subject is the only customer-scoped signal
 * before an account is proven, narrowing the budget to one customer rather than every shopper
 * behind the same Storefront Client Principal.
 */
const enrollmentExistingAccountBudgetKey = (
  principalId: string,
  sessionProviderSubjectId: string,
  secret: Redacted.Redacted,
): string =>
  `${enrollmentPrincipalScopeKey(principalId, secret)}|existing-account|${enrollmentSubjectKey(sessionProviderSubjectId, secret)}`;

/**
 * Spends the narrow (Principal, address) budget that bounds provider account creation. Only journeys
 * that actually create an account owe it (see `commercePortalAuthEnrollmentCreatesAccount`); an
 * Existing-account journey proves ownership of an account that already exists and dispatches nothing
 * this budget is meant to throttle.
 */
export const commercePortalAuthEnrollmentAddressBudget = Effect.fn('CommercePortalAuthEnrollmentHttp.addressBudget')(
  function* consumeEnrollmentAddressBudgetEffect(principalId: string, email: string) {
    const configuration = yield* CommercePortalAuthConfig;
    const key = enrollmentAddressBudgetKey(principalId, email, configuration.secret);
    const spent = yield* consumeRateLimitBudget(key, enrollmentStartRateLimit, {
      route: ENROLLMENT_START_ROUTE,
      unavailable: (failure) => commercePortalAuthEnrollmentUnavailableProblem(failure),
    });
    if (!spent) {
      return yield* Effect.fail(commercePortalAuthEnrollmentRateLimitedProblem(enrollmentStartRateLimit));
    }
    return null;
  },
);

/**
 * Spent after the session is read but before the directory lookup, so a no-session start answers 401
 * and spends nothing. Bounds this exact customer's ownership probes without affecting other
 * customers behind the same Storefront Client Principal.
 */
export const commercePortalAuthEnrollmentExistingAccountBudget = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.existingAccountBudget',
)(function* consumeEnrollmentExistingAccountBudgetEffect(principalId: string, sessionProviderSubjectId: string) {
  const configuration = yield* CommercePortalAuthConfig;
  const key = enrollmentExistingAccountBudgetKey(principalId, sessionProviderSubjectId, configuration.secret);
  const spent = yield* consumeRateLimitBudget(key, enrollmentExistingAccountRateLimit, {
    route: ENROLLMENT_START_ROUTE,
    unavailable: (failure) => commercePortalAuthEnrollmentUnavailableProblem(failure),
  });
  if (!spent) {
    return yield* Effect.fail(commercePortalAuthEnrollmentRateLimitedProblem(enrollmentExistingAccountRateLimit));
  }
  return null;
});

const isAttemptUnavailable = Schema.is(CommerceEnrollmentAttemptUnavailable);

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
 * The caller's own wire headers, forwarded to the governed Action transport verbatim. The
 * correlation identity is what the runner reads here: this route authenticates the assertion once
 * for the whole start (see `runActionHttpAs`), so the authorization header travels as the request
 * data it is rather than as the thing each Action re-verifies.
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
const forkEnrollmentAdvance = <Failure>(
  advance: Effect.Effect<Option.Option<CommerceEnrollmentContinuationResult>, Failure>,
  portalEnrollmentAttemptId: string,
) =>
  advance.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment continuation did not advance this Attempt'), {
          cause: Cause.pretty(cause),
          portalEnrollmentAttemptId,
        }),
      onSuccess: (result) =>
        Option.isNone(result) || result.value.outcome === 'COMPLETE'
          ? Effect.void
          : Effect.annotateLogs(Effect.logInfo('The Commerce enrollment journey halted before completion'), {
              portalEnrollmentAttemptId,
              reason: result.value.halt.reason,
            }),
    }),
    Effect.forkDetach,
    Effect.asVoid,
  );

const triggerEnrollmentContinuation = (
  continuation: typeof CommerceEnrollmentContinuation.Service,
  attempt: { readonly portalEnrollmentAttemptId: string; readonly tenantId: string },
) =>
  forkEnrollmentAdvance(
    // The Attempt identity alone: the read input rejects excess properties, so handing it a whole
    // durable snapshot refuses every continuation this route triggers before it reaches an owner.
    Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
      portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
      tenantId: attempt.tenantId,
    }).pipe(
      Effect.flatMap((identity) => continuation.advance(identity)),
      Effect.asSome,
    ),
    attempt.portalEnrollmentAttemptId,
  );

/** An Attempt lease that has not expired is a live worker; only a lapsed one may be resumed. */
const attemptLeaseIsLive = (lease: EnrollmentAttemptSnapshot['lease']): Effect.Effect<boolean> =>
  lease === undefined
    ? Effect.succeed(false)
    : DateTime.now.pipe(Effect.map((now) => DateTime.isLessThan(now, lease.leaseExpiresAt)));

/**
 * Resume a journey the detached start fork abandoned.
 *
 * `advance` is only ever called by that fork, so a halt — another worker's lease, an unavailable
 * owner, an indeterminate answer — or a process that exited mid-flight leaves the Attempt
 * non-terminal with nothing scheduled to touch it again. A read is the one signal that someone is
 * still waiting on it, so it advances the Attempt once more. Resuming is safe to repeat: the
 * durable claim and its lease are what grant ownership, so a live lease is left alone and a lapsed
 * one is re-claimed by exactly one caller.
 */
export const commercePortalAuthEnrollmentResumeOnRead = (
  continuation: typeof CommerceEnrollmentContinuation.Service,
  attempt: EnrollmentAttemptSnapshot,
): Effect.Effect<Option.Option<CommerceEnrollmentContinuationResult>, CommerceEnrollmentAttemptError> =>
  isEnrollmentAttemptTerminal(attempt.state)
    ? Effect.succeedNone
    : attemptLeaseIsLive(attempt.lease).pipe(
        Effect.flatMap((live) =>
          live
            ? Effect.succeedNone
            : continuation
                .advance({
                  portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
                  tenantId: attempt.tenantId,
                })
                .pipe(Effect.asSome),
        ),
      );

/**
 * Whether this journey's start owns the provider account creation.
 *
 * It must agree with what the journey itself declares: a start that dispatches an account creation
 * the journey's definition does not require leaves an account nothing will ever use, and one that
 * claims a transition the definition removed gates the Attempt on a step that can never be proven.
 * Only Retail self-enrollment brings a brand-new subject into being.
 */
export const commercePortalAuthEnrollmentCreatesAccount = (
  journey: CommercePortalAuthEnrollmentStartInput['journey'],
): boolean => journey === 'RETAIL_SELF_ENROLLMENT';

/**
 * Whether this journey's start must be made by the authenticated owner of the account it enrolls.
 *
 * Only Existing-account continues a subject that already exists, and it binds that subject to a
 * Tenant it has never belonged to. "Some account holds this address" is not a fact about the
 * caller, so it can never be the authority for that: anyone who knows an address would otherwise
 * enroll its owner into a Tenant of their choosing. A journey that brings a brand-new subject into
 * being has no prior owner to authenticate as, which is exactly the complement of
 * `commercePortalAuthEnrollmentCreatesAccount` for every journey this route still starts.
 */
export const commercePortalAuthEnrollmentRequiresAccountOwner = (
  journey: CommercePortalAuthEnrollmentStartInput['journey'],
): boolean => journey === 'EXISTING_ACCOUNT';

/**
 * The outcome code the Attempt journal carries for a portal account this route created. It is the
 * same key the owner adapter records for its own dispatch of this transition, so the journal reads
 * identically whichever half of the vertical performed the provider call.
 */
const PORTAL_ACCOUNT_CREATED_OUTCOME_CODE = 'provider_account_created';

/**
 * The outcome code the Attempt journal carries for an account-ownership proof this route made. It
 * names what was proven rather than what was created: no provider state changed, and the journal
 * entry exists so the subject this request authenticated as is the one every later phase binds.
 */
const PORTAL_ACCOUNT_VERIFIED_OUTCOME_CODE = 'provider_account_verified';

/**
 * The typed failure code recorded when the provider definitively refuses the one account this
 * Attempt may create. It never carries the provider's own rejection text.
 */
const PORTAL_ACCOUNT_CREATION_REJECTED_FAILURE_CODE = 'provider_account_rejected';

/**
 * Whether this start still owes the effect its claim authorized.
 *
 * The claim is a governed Action, and a governed Action replays a recorded result verbatim: a retry
 * presenting the same Idempotency-Key is handed the very `CLAIMED` answer of the request that
 * already created the account. Only the durable owner journal separates the two — a transition this
 * request's own owner invocation still holds `IN_PROGRESS` has an effect left to run, and one whose
 * outcome is already recorded must never be dispatched a second time.
 */
export const commercePortalAuthEnrollmentOwesTransitionOutcome = (
  operation: EnrollmentOwnerOperationSnapshot,
  claim: CommercePortalAuthEnrollmentTransitionClaim,
): boolean =>
  operation.status === 'IN_PROGRESS' &&
  operation.ownerInvocationId === claim.ownerInvocationId &&
  operation.ownerModuleKey === claim.ownerModuleKey &&
  operation.transitionKey === claim.transitionKey;

/**
 * The durable outcome of the one provider effect this route dispatches.
 *
 * It is deliberately the journal entry the generic owner driver would have written for this
 * transition — the created subject, the owner's outcome code and the evidence the Attempt itself
 * issued — so completion derives and a later reconciliation reads the same facts whether the effect
 * was dispatched here or resolved by its owner. Everything but the created subject is taken from
 * the durable claim: the Actor, the lease token and the worker are the ones PostgreSQL recorded,
 * never values this request re-derived.
 */
export const commercePortalAuthEnrollmentAccountCreationOutcome = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.accountCreationOutcome',
)(function* accountCreationOutcomeEffect(
  claim: CommercePortalAuthEnrollmentTransitionClaim,
  attempt: EnrollmentAttemptSnapshot,
  operation: EnrollmentOwnerOperationSnapshot,
  created: CommercePortalAccountCreateResult,
) {
  const { lease } = operation;
  if (lease === undefined) {
    // Without the claim's own lease token the outcome cannot be recorded under the fence that
    // authorized the provider call, and no other value may stand in for it.
    return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
  }
  if (created.enrollmentAttemptId !== attempt.portalEnrollmentAttemptId || created.revision !== attempt.revision) {
    // The private capability answers about the exact Attempt and revision its own durable
    // authorization read; anything else cannot be attributed to the claim held here.
    return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
  }
  const { accountSubject, outcomeCode, resultReference } = yield* Effect.all(
    {
      accountSubject: Schema.decodeEffect(CommercePortalAccountSubjectSchema)({
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        providerSubjectId: created.providerSubjectId,
        subjectType: 'user',
      }),
      outcomeCode: Schema.decodeEffect(EnrollmentKeySchema)(PORTAL_ACCOUNT_CREATED_OUTCOME_CODE),
      resultReference: Schema.decodeEffect(EnrollmentResourceIdSchema)(created.evidenceRef),
      // Three independent in-memory decodes; none reaches a shared downstream resource.
    },
    { concurrency: 3 },
  ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
  return yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
    accountSubject,
    actorPrincipalId: operation.actorPrincipalId,
    expectedRevision: attempt.revision,
    leaseToken: lease.leaseToken,
    outcomeCode,
    ownerInvocationId: claim.ownerInvocationId,
    ownerModuleKey: claim.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    resultReference,
    status: 'SUCCEEDED',
    tenantId: attempt.tenantId,
    transitionKey: claim.transitionKey,
    workerId: lease.workerId,
  }).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
});

/**
 * The durable outcome of a provider rejection that is definitive for this Attempt's one account.
 *
 * A rejected `signUpEmail` still consumed the claim this route holds. Without journalling it the
 * transition stays `IN_PROGRESS` until its lease fences to indeterminate, and no correlation row
 * ever appears to resolve it since the rejected call never created an account.
 */
const commercePortalAuthEnrollmentAccountCreationRejectionOutcome = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.accountCreationRejectionOutcome',
)(function* accountCreationRejectionOutcomeEffect(
  claim: CommercePortalAuthEnrollmentTransitionClaim,
  attempt: EnrollmentAttemptSnapshot,
  operation: EnrollmentOwnerOperationSnapshot,
) {
  const { lease } = operation;
  if (lease === undefined) {
    // Without the claim's own lease token the outcome cannot be recorded under the fence that
    // authorized the provider call, and no other value may stand in for it.
    return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
  }
  const failureCode = yield* Schema.decodeEffect(EnrollmentKeySchema)(
    PORTAL_ACCOUNT_CREATION_REJECTED_FAILURE_CODE,
  ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
  return yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
    actorPrincipalId: operation.actorPrincipalId,
    expectedRevision: attempt.revision,
    failureCode,
    leaseToken: lease.leaseToken,
    ownerInvocationId: claim.ownerInvocationId,
    ownerModuleKey: claim.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    status: 'FAILED',
    tenantId: attempt.tenantId,
    transitionKey: claim.transitionKey,
    workerId: lease.workerId,
  }).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
});

/**
 * The durable outcome of the account-ownership proof.
 *
 * It is the same journal entry shape the account-creation dispatch records, and deliberately so:
 * the subject reaches the Attempt by exactly one route whichever journey started it, so the Core
 * reservation that follows binds a subject PostgreSQL holds rather than one a request body named.
 * The result reference is the Attempt's own identity — the very value the owner reconciliation
 * reports for this transition — so a start and a later reconciliation agree on it. Everything else
 * is taken from the durable claim: the Actor, the lease token and the worker are the ones
 * PostgreSQL recorded, never values this request re-derived.
 */
export const commercePortalAuthEnrollmentAccountVerificationOutcome = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.accountVerificationOutcome',
)(function* accountVerificationOutcomeEffect(
  claim: CommercePortalAuthEnrollmentTransitionClaim,
  attempt: EnrollmentAttemptSnapshot,
  operation: EnrollmentOwnerOperationSnapshot,
  accountSubject: CommercePortalAccountSubject,
) {
  const { lease } = operation;
  if (lease === undefined) {
    // Without the claim's own lease token the outcome cannot be recorded under the fence that
    // authorized it, and no other value may stand in for it.
    return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
  }
  const { outcomeCode, resultReference } = yield* Effect.all(
    {
      outcomeCode: Schema.decodeEffect(EnrollmentKeySchema)(PORTAL_ACCOUNT_VERIFIED_OUTCOME_CODE),
      resultReference: Schema.decodeEffect(EnrollmentResourceIdSchema)(String(attempt.portalEnrollmentAttemptId)),
      // Two independent in-memory decodes; neither reaches a shared downstream resource.
    },
    { concurrency: 2 },
  ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
  return yield* Schema.decodeEffect(RecordEnrollmentOutcomeInputSchema)({
    accountSubject,
    actorPrincipalId: operation.actorPrincipalId,
    expectedRevision: attempt.revision,
    leaseToken: lease.leaseToken,
    outcomeCode,
    ownerInvocationId: claim.ownerInvocationId,
    ownerModuleKey: claim.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    resultReference,
    status: 'SUCCEEDED',
    tenantId: attempt.tenantId,
    transitionKey: claim.transitionKey,
    workerId: lease.workerId,
  }).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
});

/**
 * Whether this caller may observe this Attempt at all.
 *
 * The durable read is Tenant-scoped inside PostgreSQL, so another Tenant's Attempt is unreachable.
 * Inside one Tenant an Attempt is still one person's enrollment, and its journey, invitation and
 * target Legal Entity are that person's business alone: the Principal that started it is the only
 * caller it belongs to, and every other one is answered exactly as an absent Attempt is.
 */
export const commercePortalAuthEnrollmentReadableBy = (
  attempt: EnrollmentAttemptSnapshot,
  actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type,
): boolean => attempt.createdByPrincipalId === actorPrincipalId;

/**
 * The authenticated owner of the account this Existing-account start names, or a refusal.
 *
 * Two independent facts have to line up, and neither is supplied by the request body. The caller's
 * own portal session names the subject it is authenticated as, and the provider directory decides
 * whether that exact subject is the one holding the address being enrolled — through the same
 * narrow probe the owner reconciler uses, which answers yes or no and returns no user record, no
 * subject and no credential. A caller with no session learns only that enrollment wants one, and a
 * caller whose session owns a different account is answered exactly as a malformed request is, so
 * neither answer tells anybody which addresses have accounts.
 *
 * The directory lookup below is spent against the (Principal, session subject) budget first,
 * bounding a replayable verify-only assertion's probes to one customer without affecting others
 * behind the same Principal.
 */
/**
 * Whether the named invitation can still be claimed. The refusal is the same generic
 * journey-unavailable answer whether the invitation id is unknown, already consumed, revoked or
 * expired, so it never discloses which of those applied.
 */
export const commercePortalAuthEnrollmentInvitationClaimable = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.invitationClaimable',
)(function* commercePortalAuthEnrollmentInvitationClaimableEffect(
  run: CommerceEnrollmentOwnerTransactionRun,
  tenantId: string,
  legalEntityId: string,
  invitationId: string,
) {
  const { claimable } = yield* run({ legalEntityId, tenantId }, (transaction) =>
    readCounterpartyInvitationClaimability(transaction, invitationId).pipe(
      Effect.mapError((failure) => attemptUnavailable(failure.reason, undefined, failure)),
    ),
  ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
  if (!claimable) {
    return yield* Effect.fail(commercePortalAuthEnrollmentJourneyUnavailableProblem);
  }
  return null;
});

export const commercePortalAuthEnrollmentAccountOwner = Effect.fn('CommercePortalAuthEnrollmentHttp.accountOwner')(
  function* commercePortalAuthEnrollmentAccountOwnerEffect(headers: Headers, principalId: string, email: string) {
    const provider = yield* CommercePortalAuthService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    const current = yield* commercePortalAuthEnrollmentSessionSubject(provider, lifecycle, headers);
    if (Option.isNone(current)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem);
    }
    yield* commercePortalAuthEnrollmentExistingAccountBudget(principalId, current.value.providerSubjectId);
    const accountLookup = yield* CommercePortalAuthAccountLookupService;
    const owns = yield* accountLookup
      .existsByProviderSubject({ email, providerSubjectId: current.value.providerSubjectId })
      .pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
    if (!owns) {
      return yield* Effect.fail(commercePortalAuthEnrollmentInvalidProblem());
    }
    return current.value;
  },
);

/**
 * Start one enrollment. The Attempt is created by the governed `start-portal-enrollment` Action,
 * so its Tenant, Actor and invocation identity come from the governed context rather than from
 * this body, and a repeated equivalent request converges on the Attempt that already exists.
 */
const isAccountCreationUnavailable = Schema.is(CommercePortalAuthAccountCreationUnavailable);

const settleRejectedAccountCreation = Effect.fn('CommercePortalAuthEnrollmentHttp.settleRejectedAccountCreation')(
  function* settleRejectedAccountCreationEffect(
    store: ReturnType<typeof commerceEnrollmentOwnerAttemptStoreForRun>,
    claim: Parameters<typeof commercePortalAuthEnrollmentAccountCreationRejectionOutcome>[0],
    claimedState: {
      readonly attempt: Parameters<typeof commercePortalAuthEnrollmentAccountCreationRejectionOutcome>[1];
      readonly operation: Parameters<typeof commercePortalAuthEnrollmentAccountCreationRejectionOutcome>[2];
    },
    rejection: CommercePortalAuthAccountCreationRejected,
  ) {
    const outcome = yield* commercePortalAuthEnrollmentAccountCreationRejectionOutcome(
      claim,
      claimedState.attempt,
      claimedState.operation,
    );
    yield* store
      .recordOutcome(outcome)
      .pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
    return yield* rejection;
  },
);

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
  // Verified before any budget is spent; every budget below is keyed by the Principal it names, not
  // the assertion, so a caller can't exhaust another Principal's budget by naming it or replaying a
  // read-only assertion.
  const caller = yield* verifyOperationPrincipalWithoutRedemption(Redacted.make(request.headers['authorization']), {
    authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
    unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
  });
  // Refused before any budget is spent or Attempt is created: an unknown, consumed, revoked or
  // expired invitation would otherwise still produce an Attempt and provider account nothing can
  // ever complete.
  if (input.journey === 'COUNTERPARTY_INVITATION') {
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    yield* commercePortalAuthEnrollmentInvitationClaimable(
      runner.run,
      caller.tenantId,
      input.sellingLegalEntityId,
      input.invitationId,
    );
  }
  // For Existing-account, the ownership probe spends its own (Principal, session subject) budget
  // internally, before its directory lookup — see `commercePortalAuthEnrollmentAccountOwner`.
  const ownerSubject = commercePortalAuthEnrollmentRequiresAccountOwner(input.journey)
    ? yield* commercePortalAuthEnrollmentAccountOwner(requestHeaders(request.headers), caller.principalId, email)
    : undefined;
  // Only the journeys that actually create a provider account owe this narrower budget; see
  // `commercePortalAuthEnrollmentAddressBudget`.
  if (commercePortalAuthEnrollmentCreatesAccount(input.journey)) {
    yield* commercePortalAuthEnrollmentAddressBudget(caller.principalId, email);
  }
  // One redemption for the whole composed start. The gate above only read the assertion, so this is
  // the single place it is spent, and both governed Actions below are handed the principal it
  // produced rather than the header it came from.
  const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
    authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
    unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
  });
  const runActionHttp = runActionHttpAs(principal);

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

  if (input.journey === 'EXISTING_ACCOUNT') {
    // Counterparty was refused above, so this is the only other variant, and it carries no
    // `password` or `displayName` at the type level: this branch can never read a credential that
    // does not exist on it. The gate above has already produced this journey's owner subject; a
    // deployment where the two predicates disagreed would have no subject to journal and must
    // refuse rather than start a journey nothing can finish.
    if (ownerSubject === undefined) {
      return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
    }
    // This journey's definition drops the provider account-creation step and declares the
    // account-ownership proof in its place. The subject the gate authenticated is journalled under
    // that transition, because the continuation's first Core reservation binds the subject the
    // Attempt carries: an Attempt that records none can never leave IN_PROGRESS.
    const verification = yield* commercePortalAuthEnrollmentAccountVerificationClaim(
      input,
      started.attempt.portalEnrollmentAttemptId,
    ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    const verified = yield* runEnrollmentAction(claimPortalEnrollmentTransitionAction, {
      expectedRevision: started.attempt.revision,
      ownerInvocationId: verification.ownerInvocationId,
      ownerModuleKey: verification.ownerModuleKey,
      portalEnrollmentAttemptId: started.attempt.portalEnrollmentAttemptId,
      requestDigest: verification.requestDigest,
      transitionKey: verification.transitionKey,
    });
    if (verified.outcome !== 'CLAIMED') {
      yield* triggerEnrollmentContinuation(continuation, verified.attempt);
      return { attempt: commercePortalAuthEnrollmentAttemptProjection(verified.attempt), outcome: started.outcome };
    }
    // Both owner rows are re-read from the journal rather than taken from the Action's answer, and
    // through the same runner the read route uses: one committed transaction per owner phase.
    const verifiedRunner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const verifiedStore = commerceEnrollmentOwnerAttemptStoreForRun(
      { tenantId: verified.attempt.tenantId },
      verifiedRunner.run,
    );
    const verifiedState = yield* Effect.all(
      {
        attempt: verifiedStore.read({
          portalEnrollmentAttemptId: verified.attempt.portalEnrollmentAttemptId,
          tenantId: verified.attempt.tenantId,
        }),
        operation: verifiedStore.readOwnerOperation({
          ownerModuleKey: verification.ownerModuleKey,
          portalEnrollmentAttemptId: verified.attempt.portalEnrollmentAttemptId,
          tenantId: verified.attempt.tenantId,
          transitionKey: verification.transitionKey,
        }),
        // Two durable reads of the Attempt this request just claimed, in their own transactions.
      },
      { concurrency: 2 },
    ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
    if (!commercePortalAuthEnrollmentOwesTransitionOutcome(verifiedState.operation, verification)) {
      // A retry replaying this start's own `CLAIMED` answer: the subject is journalled already.
      yield* triggerEnrollmentContinuation(continuation, verifiedState.attempt);
      return {
        attempt: commercePortalAuthEnrollmentAttemptProjection(verifiedState.attempt),
        outcome: started.outcome,
      };
    }
    const verificationOutcome = yield* commercePortalAuthEnrollmentAccountVerificationOutcome(
      verification,
      verifiedState.attempt,
      verifiedState.operation,
      ownerSubject,
    );
    const journalled = yield* verifiedStore
      .recordOutcome(verificationOutcome)
      .pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
    yield* triggerEnrollmentContinuation(continuation, journalled.attempt);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(journalled.attempt), outcome: started.outcome };
  }

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

  // Both owner rows are re-read from the journal rather than taken from the Action's answer, and
  // through the same runner the read route uses: one committed transaction per owner phase, so the
  // provider call below never runs inside an Attempt transaction.
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: claimed.attempt.tenantId }, runner.run);
  const claimedState = yield* Effect.all(
    {
      attempt: store.read({
        portalEnrollmentAttemptId: claimed.attempt.portalEnrollmentAttemptId,
        tenantId: claimed.attempt.tenantId,
      }),
      operation: store.readOwnerOperation({
        ownerModuleKey: claim.ownerModuleKey,
        portalEnrollmentAttemptId: claimed.attempt.portalEnrollmentAttemptId,
        tenantId: claimed.attempt.tenantId,
        transitionKey: claim.transitionKey,
      }),
      // Two durable reads of the Attempt this request just claimed, in their own transactions.
    },
    { concurrency: 2 },
  ).pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));

  if (!commercePortalAuthEnrollmentOwesTransitionOutcome(claimedState.operation, claim)) {
    // The transition already carries a recorded outcome, so this start is a retry of one that
    // dispatched: it answers with the Attempt as the journal now has it and dispatches nothing.
    yield* triggerEnrollmentContinuation(continuation, claimedState.attempt);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(claimedState.attempt), outcome: started.outcome };
  }

  const accountCreation = yield* CommercePortalAuthAccountCreationService;
  const created = yield* accountCreation
    .createAccount({
      email: input.email,
      enrollmentAttemptId: claimedState.attempt.portalEnrollmentAttemptId,
      name: input.displayName,
      ownerInvocationId: claim.ownerInvocationId,
      // The credential stays `Redacted` across the port boundary: the private capability decodes
      // it itself, so nothing here ever holds the plain value.
      password: input.password,
      tenantId: claimedState.attempt.tenantId,
    })
    .pipe(
      // A definitive rejection is terminal for the claimed transition: recorded here, or the lease
      // fences it indeterminate and no correlation ever appears to resolve it.
      Effect.catchTag('CommercePortalAuthAccountCreationRejected', (rejection) =>
        settleRejectedAccountCreation(store, claim, claimedState, rejection),
      ),
      Effect.mapError((failure) =>
        isAccountCreationUnavailable(failure)
          ? commercePortalAuthEnrollmentUnavailableProblem(failure)
          : commercePortalAuthEnrollmentRejectedProblem(failure),
      ),
    );

  // The created subject is the whole point of the dispatch: until it is journalled the Attempt has
  // an account nothing can name, its completion can never derive, and a reconciliation has no
  // subject to correlate the provider effect by.
  const outcome = yield* commercePortalAuthEnrollmentAccountCreationOutcome(
    claim,
    claimedState.attempt,
    claimedState.operation,
    created,
  );
  const recorded = yield* store
    .recordOutcome(outcome)
    .pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));

  yield* triggerEnrollmentContinuation(continuation, recorded.attempt);
  return { attempt: commercePortalAuthEnrollmentAttemptProjection(recorded.attempt), outcome: started.outcome };
});

/**
 * Read one Attempt back. The Tenant is the governed one the caller's own gateway assertion names,
 * and the durable read is Tenant-scoped inside PostgreSQL, so an Attempt belonging to another
 * Tenant is not merely hidden — it is unreachable. Inside that Tenant the Attempt still belongs to
 * the Principal that started it, so a caller that did not is answered exactly as an absent one is.
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
  // Decoded for the same reason the Actions decode them: a Tenant or an Actor this vertical's
  // Attempt vocabulary cannot name must never reach a durable owner read or its scoping.
  const { actorPrincipalId, tenantId } = yield* Effect.all(
    {
      actorPrincipalId: Schema.decodeEffect(EnrollmentPrincipalIdSchema)(principal.principalId),
      tenantId: Schema.decodeEffect(EnrollmentTenantIdSchema)(principal.tenantId),
      // Two independent in-memory decodes; neither reaches a shared downstream resource.
    },
    { concurrency: 2 },
  ).pipe(Effect.mapError(commercePortalAuthEnrollmentInvalidProblem));
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const continuation = yield* CommerceEnrollmentContinuation;
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
  if (!commercePortalAuthEnrollmentReadableBy(attempt, actorPrincipalId)) {
    // Refused before the resume as well: a caller that may not observe this Attempt may not
    // advance it either, and the answer is the one an absent Attempt already gives.
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }
  // Detached for the same reason the start route detaches: cancelling this request must never
  // cancel a claimed owner transition mid-flight. The caller reads the projection as it was.
  yield* forkEnrollmentAdvance(
    commercePortalAuthEnrollmentResumeOnRead(continuation, attempt),
    attempt.portalEnrollmentAttemptId,
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
      .handle('claimEnrollmentInvitation', ({ params, payload, request }) =>
        commercePortalAuthEnrollmentClaimInvitation(
          params.attemptId,
          payload,
          request.headers['idempotency-key'],
          request,
        ),
      )
      .handle('readEnrollment', ({ params, request }) => readEnrollment(params.attemptId, request)),
).pipe(Layer.provide(commercePortalAuthEnrollmentSchemaErrorLive));
