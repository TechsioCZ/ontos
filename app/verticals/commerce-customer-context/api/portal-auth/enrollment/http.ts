import { admitEnrollmentAttempt } from '../../../src/enrollment/attempts/attempt-persistence.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { createHmac } from 'node:crypto';

import { HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
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
import type { CommerceEnrollmentOwnerAttemptStore } from '../../../src/enrollment/orchestration/owner-transition-driver.ts';
import { retailSelfEnrollmentEvidenceReference } from '../../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  ReconcileEnrollmentRequestSchema,
  ReconcileEnrollmentResolutionSchema,
  CommercePortalAccountSubjectSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  ReadEnrollmentAttemptInputSchema,
  RecordEnrollmentOutcomeInputSchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import {
  readRetailEnrollmentRestartContext,
  retailEnrollmentRestartIntent,
  retailRestartIdentity,
} from '../../../src/enrollment/journeys/retail-enrollment-restart.ts';
import type { StartPortalEnrollmentPayload } from '../../../shared/actions/start-portal-enrollment.ts';
import { readCurrentRetailEnrollment } from '../../../src/enrollment/attempts/registration-persistence.ts';
import { CommerceEnrollmentAttemptUnavailable, attemptUnavailable } from '../../../src/enrollment/attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../../../src/enrollment/attempts/errors.ts';
import { readCounterpartyInvitationClaimability } from '../../../src/persistence/access-persistence.ts';
import type {
  CommercePortalAccountSubject,
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptSnapshot,
  ReadEnrollmentAttemptInput,
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
  normalizeCommercePortalAuthEnrollmentPhone,
} from './intent.ts';
import type { CommercePortalAuthEnrollmentTransitionClaim } from './intent.ts';
import { commercePortalAuthEnrollmentSessionSubject } from './session-subject.ts';
import { advanceEnrollmentWithinRequest } from './request-continuation.ts';
import {
  answerEnrollmentFailure,
  answerEnrollmentOwnerFailure,
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
      unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
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
    unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
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
 * problem is exactly its schema; the Action runtime records the rejected invocation.
 */
const actionProblem = (error: { readonly _tag: string }) =>
  isAttemptUnavailable(error)
    ? commercePortalAuthEnrollmentUnavailableProblem()
    : commercePortalAuthEnrollmentRejectedProblem();

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

/** Advance under this request's live services, then project the committed owner journal. */
const continueEnrollment = Effect.fn('CommercePortalAuthEnrollmentHttp.continue')(function* continueEnrollmentEffect(
  continuation: typeof CommerceEnrollmentContinuation.Service,
  attempt: { readonly portalEnrollmentAttemptId: string; readonly tenantId: string },
) {
  // The read input rejects excess properties: only the durable identity reaches the pass.
  const identity = yield* Schema.decodeEffect(ReadEnrollmentAttemptInputSchema)({
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    tenantId: attempt.tenantId,
  }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
  yield* advanceEnrollmentWithinRequest(
    continuation.advance(identity).pipe(Effect.asSome),
    identity.portalEnrollmentAttemptId,
  );
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  return yield* commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: identity.tenantId }, runner.run)
    .read(identity)
    .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
});

/** An Attempt lease that has not expired is a live worker; only a lapsed one may be resumed. */
const attemptLeaseIsLive = (lease: EnrollmentAttemptSnapshot['lease']): Effect.Effect<boolean> =>
  lease === undefined
    ? Effect.succeed(false)
    : DateTime.now.pipe(Effect.map((now) => DateTime.isLessThan(now, lease.leaseExpiresAt)));

/**
 * Resume a nonterminal journey after a prior request halted or was interrupted.
 *
 * The explicit resume request owns one bounded pass, independent of a resident process or sweeper.
 * The current-enrollment GET remains read-only. Resuming is safe to repeat: the
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
 * Retail self-enrollment and Counterparty invitation both bring a brand-new subject into being;
 * only Existing-account proves ownership of one that already exists.
 */
export const commercePortalAuthEnrollmentCreatesAccount = (
  journey: CommercePortalAuthEnrollmentStartInput['journey'],
): boolean => journey === 'RETAIL_SELF_ENROLLMENT' || journey === 'COUNTERPARTY_INVITATION';

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
  ).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
  }).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
  ).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
  }).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
  ).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
  }).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
});

/** A resumed HTTP proof uses the same native readmission as the background continuation. */
const readEnrollmentForCurrentComposition = Effect.fn('CommercePortalAuthEnrollmentHttp.readAdmittedAttempt')(
  function* readAdmittedAttempt(
    store: CommerceEnrollmentOwnerAttemptStore,
    run: CommerceEnrollmentOwnerTransactionRun,
    identity: ReadEnrollmentAttemptInput,
  ) {
    const current = yield* store.read(identity);
    const authority = yield* ActiveApplicationCompositionService;
    const active = yield* authority.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError((cause) =>
        attemptUnavailable(
          'The resumed enrollment requires current composition authority',
          identity.portalEnrollmentAttemptId,
          cause,
        ),
      ),
    );
    if (isEnrollmentAttemptTerminal(current.state) || current.compositionRevision === active.composition.revision) {
      return current;
    }
    yield* run({ tenantId: current.tenantId }, (transaction) =>
      admitEnrollmentAttempt(transaction, identity, active.composition.revision),
    );
    return yield* store.read(identity);
  },
);

/** Live-session ownership is read-only provider work, so an interrupted proof can be resolved honestly.
 * Native claim fences an expired lease; only then may native reconciliation settle the same invocation.
 */
export const recoverEnrollmentAccountVerification = Effect.fn('CommercePortalAuthEnrollmentHttp.recoverVerification')(
  function* recoverVerification<Failure, Requirements>(
    store: CommerceEnrollmentOwnerAttemptStore,
    claim: CommercePortalAuthEnrollmentTransitionClaim,
    attempt: EnrollmentAttemptSnapshot,
    accountSubject: CommercePortalAccountSubject,
    claimMissing: (current: EnrollmentAttemptSnapshot) => Effect.Effect<unknown, Failure, Requirements>,
  ) {
    let currentAttempt = attempt;
    const identity = { portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId, tenantId: attempt.tenantId };
    const operationIdentity = {
      ...identity,
      ownerModuleKey: claim.ownerModuleKey,
      transitionKey: claim.transitionKey,
    };
    const existing = yield* store.readOwnerOperation(operationIdentity).pipe(
      Effect.asSome,
      Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeedNone),
    );
    if (Option.isNone(existing)) {
      // Only an absent operation owes the governed initial claim. Replaying a settled Action
      // with its old revision must not block recovery of the exact native operation it created.
      yield* claimMissing(currentAttempt);
      currentAttempt = yield* store.read(identity);
    }
    let operation = Option.isSome(existing) ? existing.value : yield* store.readOwnerOperation(operationIdentity);
    if (
      operation.ownerInvocationId !== claim.ownerInvocationId ||
      operation.requestDigest !== claim.requestDigest ||
      operation.actorPrincipalId !== attempt.createdByPrincipalId ||
      claim.transitionKey !== 'provider.account.verify'
    ) {
      return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
    }
    if (operation.status === 'SUCCEEDED' || isEnrollmentAttemptTerminal(currentAttempt.state)) {
      return currentAttempt;
    }
    if (operation.status === 'IN_PROGRESS') {
      const fence = yield* Schema.decodeEffect(ClaimEnrollmentTransitionInputSchema)({
        ...identity,
        ...claim,
        actorPrincipalId: operation.actorPrincipalId,
        expectedRevision: currentAttempt.revision,
        leaseDurationMs: 30_000,
        required: operation.required,
        workerId: operation.lease?.workerId ?? `commerce.portal-auth.verify:${claim.ownerInvocationId}`,
      }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
      const fenced = yield* store.claimTransition(fence);
      ({ attempt: currentAttempt } = fenced);
      operation = yield* store.readOwnerOperation({
        ...identity,
        ownerModuleKey: claim.ownerModuleKey,
        transitionKey: claim.transitionKey,
      });
    }
    if (operation.status === 'IN_PROGRESS') {
      const outcome = yield* commercePortalAuthEnrollmentAccountVerificationOutcome(
        claim,
        currentAttempt,
        operation,
        accountSubject,
      );
      return (yield* store.recordOutcome(outcome)).attempt;
    }
    if (operation.status !== 'INDETERMINATE' && operation.status !== 'RECONCILIATION_REQUIRED') {
      return yield* Effect.fail(commercePortalAuthEnrollmentUnavailableProblem());
    }
    const request = yield* Schema.decodeEffect(ReconcileEnrollmentRequestSchema)({
      ...identity,
      ...claim,
      expectedRevision: currentAttempt.revision,
    }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    const resolution = yield* Schema.decodeEffect(ReconcileEnrollmentResolutionSchema)({
      accountSubject,
      actorPrincipalId: operation.actorPrincipalId,
      outcomeCode: PORTAL_ACCOUNT_VERIFIED_OUTCOME_CODE,
      reconciliationRef: retailSelfEnrollmentEvidenceReference([
        'live-session-account-verification',
        claim.ownerInvocationId,
        accountSubject.providerSubjectId,
      ]),
      resultReference: attempt.portalEnrollmentAttemptId,
      status: 'SUCCEEDED',
    }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    return (yield* store.reconcileOutcome(request, resolution)).attempt;
  },
);

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
  ).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
      .pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
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
      .pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));
    return yield* rejection;
  },
);

export const enrollmentSubjectOwnsAttempt = (
  attempt: EnrollmentAttemptSnapshot,
  subject: CommercePortalAccountSubject,
): boolean =>
  attempt.accountSubject?.authenticationNamespaceId === subject.authenticationNamespaceId &&
  attempt.accountSubject.subjectType === subject.subjectType &&
  attempt.accountSubject.providerSubjectId === subject.providerSubjectId;

/** A committed start is recovered from current native lineage, never from a cached Action answer. */
export const readRestartEnrollmentForIntent = Effect.fn('CommercePortalAuthEnrollmentHttp.readRestartForIntent')(
  function* readRestartForIntent(
    run: CommerceEnrollmentOwnerTransactionRun,
    scope: { readonly legalEntityId: string; readonly tenantId: string },
    actorPrincipalId: string,
    subject: CommercePortalAccountSubject,
    intent: StartPortalEnrollmentPayload,
  ) {
    const current = yield* run(scope, (transaction) =>
      readCurrentRetailEnrollment(transaction, actorPrincipalId, subject),
    );
    if (Option.isNone(current)) {
      return yield* attemptUnavailable('The committed restart is unavailable');
    }
    const tenantId = yield* Schema.decodeEffect(EnrollmentTenantIdSchema)(scope.tenantId).pipe(
      Effect.mapError((cause) => attemptUnavailable('The restart tenant is invalid', undefined, cause)),
    );
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, run);
    const attempt = yield* store.read({ portalEnrollmentAttemptId: current.value, tenantId });
    const proof = yield* run(scope, (transaction) =>
      readRetailEnrollmentRestartContext(transaction, attempt.portalEnrollmentAttemptId, false),
    );
    if (
      Option.isNone(proof) ||
      attempt.createdByPrincipalId !== actorPrincipalId ||
      attempt.journey !== 'EXISTING_ACCOUNT' ||
      attempt.targetLegalEntityId !== scope.legalEntityId ||
      attempt.intentKey !== intent.intentKey ||
      attempt.intentDigest !== intent.intentDigest ||
      attempt.targetResourceId !== intent.targetResourceId
    ) {
      return yield* attemptUnavailable('The committed restart does not match its native intent');
    }
    return { attempt, outcome: 'EXISTING' as const };
  },
);

const startEnrollment = Effect.fn('CommercePortalAuthEnrollmentHttp.start')(function* startEnrollmentEffect(
  payload: Schema.Codec.Encoded<typeof CommercePortalAuthEnrollmentStartInputSchema>,
  idempotencyKey: string | undefined,
  request: HttpServerRequest.HttpServerRequest,
  restart?: { readonly intent: StartPortalEnrollmentPayload; readonly subject: CommercePortalAccountSubject },
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthEnrollmentUntrustedOriginProblem);
  const input: CommercePortalAuthEnrollmentStartInput = yield* Schema.decodeEffect(
    CommercePortalAuthEnrollmentStartInputSchema,
    { onExcessProperty: 'error' },
  )(payload).pipe(
    Effect.flatMap(normalizeCommercePortalAuthEnrollmentPhone),
    Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
  );
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
  const ownerSubject =
    restart?.subject ??
    (commercePortalAuthEnrollmentRequiresAccountOwner(input.journey)
      ? yield* commercePortalAuthEnrollmentAccountOwner(requestHeaders(request.headers), caller.principalId, email)
      : undefined);
  if (restart !== undefined) {
    yield* commercePortalAuthEnrollmentExistingAccountBudget(caller.principalId, restart.subject.providerSubjectId);
  }
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
  const intent =
    restart?.intent ??
    (yield* commercePortalAuthEnrollmentIntent(input).pipe(
      Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
    ));
  const restartRunner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const started = yield* restart === undefined
    ? runEnrollmentAction(startPortalEnrollmentAction, intent)
    : runActionHttp({
        endpointHeaders: actionEndpointHeaders(request, idempotencyKey),
        internalProblem: () => commercePortalAuthEnrollmentUnavailableProblem(),
        invalidCorrelationProblem: () => commercePortalAuthEnrollmentInvalidProblem(),
        mapError: actionProblem,
        payload: intent,
        recoverAlreadyCommitted: () => null,
        registration: startPortalEnrollmentAction,
        requestHeaders: actionRequestHeaders(request),
      }).pipe(
        Effect.filterOrElse(
          (result) => result !== null,
          () =>
            readRestartEnrollmentForIntent(
              restartRunner.run,
              { legalEntityId: input.sellingLegalEntityId, tenantId: caller.tenantId },
              caller.principalId,
              restart.subject,
              intent,
            ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem)),
        ),
      );

  if (started.outcome === 'EXISTING') {
    // Convergence names an Attempt this request did not create; only its own creator may claim its
    // next transition, so a second Principal is refused exactly as the read route refuses a foreign
    // Attempt, before any transition is claimed or any provider account is dispatched under it.
    const callerPrincipalId = yield* Schema.decodeEffect(EnrollmentPrincipalIdSchema)(caller.principalId).pipe(
      Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
    );
    if (!commercePortalAuthEnrollmentReadableBy(started.attempt, callerPrincipalId)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    if (input.journey === 'RETAIL_SELF_ENROLLMENT') {
      const provider = yield* CommercePortalAuthService;
      const lifecycle = yield* CommercePortalAuthSessionLifecycle;
      const subject = yield* commercePortalAuthEnrollmentSessionSubject(
        provider,
        lifecycle,
        requestHeaders(request.headers),
      );
      // A repeated signup is not proof of account ownership, even behind the same workload.
      if (Option.isNone(subject) || !enrollmentSubjectOwnsAttempt(started.attempt, subject.value)) {
        return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
      }
    }
  }

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
    const verifiedStore = commerceEnrollmentOwnerAttemptStoreForRun(
      { tenantId: started.attempt.tenantId },
      restartRunner.run,
    );
    const current = yield* readEnrollmentForCurrentComposition(verifiedStore, restartRunner.run, {
      portalEnrollmentAttemptId: started.attempt.portalEnrollmentAttemptId,
      tenantId: started.attempt.tenantId,
    }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    const journalled = yield* recoverEnrollmentAccountVerification(
      verifiedStore,
      verification,
      current,
      ownerSubject,
      (unclaimed) =>
        runActionHttp({
          endpointHeaders: actionEndpointHeaders(request, idempotencyKey),
          internalProblem: () => commercePortalAuthEnrollmentUnavailableProblem(),
          invalidCorrelationProblem: () => commercePortalAuthEnrollmentInvalidProblem(),
          mapError: actionProblem,
          payload: {
            expectedRevision: unclaimed.revision,
            ownerInvocationId: verification.ownerInvocationId,
            ownerModuleKey: verification.ownerModuleKey,
            portalEnrollmentAttemptId: unclaimed.portalEnrollmentAttemptId,
            requestDigest: verification.requestDigest,
            transitionKey: verification.transitionKey,
          },
          recoverAlreadyCommitted: () => null,
          registration: claimPortalEnrollmentTransitionAction,
          requestHeaders: actionRequestHeaders(request),
        }),
    ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    const continued = yield* continueEnrollment(continuation, journalled);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(continued), outcome: started.outcome };
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
    const continued = yield* continueEnrollment(continuation, claimed.attempt);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(continued), outcome: started.outcome };
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
  ).pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));

  if (!commercePortalAuthEnrollmentOwesTransitionOutcome(claimedState.operation, claim)) {
    // The transition already carries a recorded outcome, so this start is a retry of one that
    // dispatched: it answers with the Attempt as the journal now has it and dispatches nothing.
    const continued = yield* continueEnrollment(continuation, claimedState.attempt);
    return { attempt: commercePortalAuthEnrollmentAttemptProjection(continued), outcome: started.outcome };
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
      Effect.catch((error) =>
        answerEnrollmentOwnerFailure(
          isAccountCreationUnavailable(error),
          error,
          commercePortalAuthEnrollmentRejectedProblem,
        ),
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
    .pipe(Effect.catch(answerEnrollmentFailure(() => commercePortalAuthEnrollmentUnavailableProblem())));

  const continued = yield* continueEnrollment(continuation, recorded.attempt);
  return { attempt: commercePortalAuthEnrollmentAttemptProjection(continued), outcome: started.outcome };
});

/**
 * Read one Attempt back. The Tenant is the governed one the caller's own gateway assertion names,
 * and the durable read is Tenant-scoped inside PostgreSQL, so an Attempt belonging to another
 * Tenant is not merely hidden — it is unreachable. Inside that Tenant the Attempt still belongs to
 * the Principal that started it, so a caller that did not is answered exactly as an absent one is.
 */
/** No browser Attempt, Party or provider identifier participates in current-subject authority. */
/** New native Attempt for the same verified account; the FAILED predecessor is read-only. */
export const restartCurrentEnrollment = Effect.fn('CommercePortalAuthEnrollmentHttp.restartCurrent')(
  function* restartCurrent(request: HttpServerRequest.HttpServerRequest) {
    yield* noStoreHeaders;
    yield* requireTrustedOrigin(request.headers, () => commercePortalAuthEnrollmentUntrustedOriginProblem);
    // Read-only verification here. startEnrollment redeems this exact assertion once, for its governed Actions.
    const principal = yield* verifyOperationPrincipalWithoutRedemption(
      Redacted.make(request.headers['authorization']),
      {
        authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
        unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
      },
    );
    if (principal.legalEntityId === undefined) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    const provider = yield* CommercePortalAuthService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    const subject = yield* commercePortalAuthEnrollmentSessionSubject(
      provider,
      lifecycle,
      requestHeaders(request.headers),
    );
    if (Option.isNone(subject)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem);
    }
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const scope = { legalEntityId: principal.legalEntityId, tenantId: principal.tenantId };
    const current = yield* runner
      .run(scope, (transaction) => readCurrentRetailEnrollment(transaction, principal.principalId, subject.value))
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    if (Option.isNone(current)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    const tenantId = yield* Schema.decodeEffect(EnrollmentTenantIdSchema)(principal.tenantId).pipe(
      Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
    );
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, runner.run);
    const attempt = yield* store
      .read({ portalEnrollmentAttemptId: current.value, tenantId })
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    const isSource = attempt.state === 'FAILED';
    if (!isSource && (Option.isNone(retailRestartIdentity(attempt)) || isEnrollmentAttemptTerminal(attempt.state))) {
      return commercePortalAuthEnrollmentAttemptProjection(attempt);
    }
    const proof = yield* runner
      .run(scope, (transaction) => readRetailEnrollmentRestartContext(transaction, current.value, isSource))
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    if (Option.isNone(proof)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentJourneyUnavailableProblem);
    }
    const source = yield* store
      .read({ portalEnrollmentAttemptId: proof.value.sourceAttemptId, tenantId })
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    if (
      !enrollmentSubjectOwnsAttempt(source, subject.value) ||
      source.createdByPrincipalId !== principal.principalId ||
      source.targetLegalEntityId !== principal.legalEntityId
    ) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    const intent = yield* retailEnrollmentRestartIntent(source, proof.value).pipe(
      Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem),
    );
    const started = yield* startEnrollment(
      {
        email: proof.value.registration.email,
        journey: 'EXISTING_ACCOUNT',
        sellingLegalEntityId: principal.legalEntityId,
      },
      `retail-restart:${source.portalEnrollmentAttemptId}`,
      request,
      { intent, subject: subject.value },
    );
    return started.attempt;
  },
);

export const currentEnrollmentForRequest = Effect.fn('CommercePortalAuthEnrollmentHttp.current')(
  function* currentEnrollment(request: HttpServerRequest.HttpServerRequest, resume: boolean) {
    yield* noStoreHeaders;
    if (resume) {
      yield* requireTrustedOrigin(request.headers, () => commercePortalAuthEnrollmentUntrustedOriginProblem);
    }
    const authenticate = resume ? verifyOperationPrincipalWithoutRedemption : authenticateOperationPrincipal;
    const principal = yield* authenticate(Redacted.make(request.headers['authorization']), {
      authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
      unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
    });
    if (principal.legalEntityId === undefined) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    const provider = yield* CommercePortalAuthService;
    const lifecycle = yield* CommercePortalAuthSessionLifecycle;
    const subject = yield* commercePortalAuthEnrollmentSessionSubject(
      provider,
      lifecycle,
      requestHeaders(request.headers),
    );
    if (Option.isNone(subject)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem);
    }
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const id = yield* runner
      .run({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId }, (transaction) =>
        readCurrentRetailEnrollment(transaction, principal.principalId, subject.value),
      )
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    if (Option.isNone(id)) {
      return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
    }
    const tenantId = yield* Schema.decodeEffect(EnrollmentTenantIdSchema)(principal.tenantId).pipe(
      Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem),
    );
    const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, runner.run);
    const attempt = yield* store
      .read({ portalEnrollmentAttemptId: id.value, tenantId })
      .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
    if (resume && attempt.accountSubject === undefined && Option.isSome(retailRestartIdentity(attempt))) {
      return yield* restartCurrentEnrollment(request).pipe(
        Effect.catchTag('CommercePortalAuthEnrollmentJourneyUnavailableProblem', () =>
          Effect.fail(commercePortalAuthEnrollmentUnavailableProblem()),
        ),
      );
    }
    if (resume) {
      yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
        authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
        unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
      });
    }
    if (resume && !isEnrollmentAttemptTerminal(attempt.state)) {
      yield* commercePortalAuthEnrollmentExistingAccountBudget(principal.principalId, subject.value.providerSubjectId);
      const continuation = yield* CommerceEnrollmentContinuation;
      // Explicit recovery is independent of background discovery's exhausted budget. It does not
      // reset that budget, any lease, or the original owner invocation/idempotency key.
      yield* advanceEnrollmentWithinRequest(commercePortalAuthEnrollmentResumeOnRead(continuation, attempt), id.value);
      const current = yield* store
        .read({ portalEnrollmentAttemptId: id.value, tenantId })
        .pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));
      return commercePortalAuthEnrollmentAttemptProjection(current);
    }
    return commercePortalAuthEnrollmentAttemptProjection(attempt);
  },
);

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
  const store = commerceEnrollmentOwnerAttemptStoreForRun({ tenantId }, runner.run);
  const attempt = yield* store
    .read({ portalEnrollmentAttemptId, tenantId })
    .pipe(
      Effect.catch((error) =>
        answerEnrollmentOwnerFailure(error.retryable, error, commercePortalAuthEnrollmentNotFoundProblem),
      ),
    );
  if (!commercePortalAuthEnrollmentReadableBy(attempt, actorPrincipalId)) {
    // A caller that may not observe this Attempt gets the same answer as an absent one.
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }
  const provider = yield* CommercePortalAuthService;
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const subject = yield* commercePortalAuthEnrollmentSessionSubject(
    provider,
    lifecycle,
    requestHeaders(request.headers),
  );
  if (
    Option.isNone(subject) ||
    !enrollmentSubjectOwnsAttempt(attempt, subject.value) ||
    principal.legalEntityId !== attempt.targetLegalEntityId
  ) {
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }
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
      .handle('readCurrentEnrollment', ({ request }) => currentEnrollmentForRequest(request, false))
      .handle('resumeCurrentEnrollment', ({ request }) => currentEnrollmentForRequest(request, true))
      .handle('restartCurrentEnrollment', ({ request }) => restartCurrentEnrollment(request))
      .handle('readEnrollment', ({ params, request }) => readEnrollment(params.attemptId, request)),
).pipe(Layer.provide(commercePortalAuthEnrollmentSchemaErrorLive));
