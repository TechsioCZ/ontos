import { Cause, Crypto, Effect, Option, Redacted, Schema } from 'effect';
import type { HttpServerRequest } from 'effect/unstable/http';

import { ActionTransportMetadataSchema } from '@app/core-runtime';
import { bindGovernedActionHttp } from '@app/core-runtime/http/action-runner';
import type { ActionRuntime, ContextAccess, OperationalScope, PrincipalEligibility } from '@app/core-runtime';

import { authenticateOperationPrincipal } from '../../auth/action-principal.ts';
import { claimCounterpartyAccessInvitationAction } from '../../../src/actions/claim-counterparty-access-invitation.action.ts';
import type { ClaimCounterpartyAccessInvitationPayload } from '../../../shared/actions/claim-counterparty-access-invitation.ts';
import { CommerceEnrollmentContinuation } from '../../../src/enrollment/continuation/enrollment-continuation.ts';
import {
  CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
  COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
} from '../../../src/enrollment/journeys/counterparty-invitation.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
  RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
} from '../../../src/enrollment/journeys/existing-account.ts';
import { retailSelfEnrollmentEvidenceReference } from '../../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import type { CommerceEnrollmentAttemptError } from '../../../src/enrollment/attempts/errors.ts';
import {
  COUNTERPARTY_INVITATION_CLAIM_OPEN_OUTCOME_CODE,
  counterpartyInvitationClaimReconciliationFor,
} from '../../../src/enrollment/orchestration/owner-effect-registry.ts';
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../../../src/enrollment/orchestration/owner-transition-errors.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../../../src/enrollment/orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerTransition,
  CommerceEnrollmentOwnerTransitionDriver,
} from '../../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
} from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import type { CommerceEnrollmentOwnerTransactionRun } from '../../../src/enrollment/orchestration/owner-transition-production.ts';
import { readCounterpartyAccessInvitationForScope } from '../../../src/persistence/access-persistence.ts';
import { counterpartyInvitationClaimRedemptionForTransaction } from '../../../src/persistence/invitation-claim-authority-persistence.ts';
import type { CounterpartyInvitationProofDelivery } from '../../../shared/domain/access-port.ts';
import { CounterpartyAccessContractViolation } from '../../../shared/domain/access-error.ts';
import type { CounterpartyAccessDomainError } from '../../../shared/domain/access-error.ts';
import {
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  ReadEnrollmentOwnerOperationInputSchema,
  enrollmentDigest,
} from '../../../shared/enrollment-contracts.ts';
import type {
  EnrollmentAttemptIdSchema,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOperationSnapshot,
} from '../../../shared/enrollment-contracts.ts';
import { noStoreHeaders, requestHeaders, requireTrustedOrigin } from '../http-transport.ts';
import { CommercePortalAuthService } from '../session/http.ts';
import { CommercePortalAuthSessionLifecycle } from '../session/lifecycle-service.ts';
import {
  CommercePortalAuthEnrollmentClaimInvitationInputSchema,
  commercePortalAuthEnrollmentAttemptProjection,
} from './contracts.ts';
import { commercePortalAuthEnrollmentSessionSubject } from './session-subject.ts';
import {
  commercePortalAuthEnrollmentAuthenticationProblem,
  commercePortalAuthEnrollmentBindingPendingProblem,
  commercePortalAuthEnrollmentInvalidProblem,
  commercePortalAuthEnrollmentNotFoundProblem,
  commercePortalAuthEnrollmentRejectedProblem,
  commercePortalAuthEnrollmentUnavailableProblem,
  commercePortalAuthEnrollmentUntrustedOriginProblem,
} from './problems.ts';

/**
 * The one enrollment route the enrolling person calls for itself.
 *
 * Every other transition of a journey is dispatched by the continuation from state that survived a
 * crash. An invitation claim cannot be: the invitation's one-time secret was delivered to the
 * recipient and exists nowhere the server may read, so the claim is the recipient presenting it.
 * The secret stays `Redacted` from decode to redemption, and the durable journal records only the
 * proof reference the redemption resolved it to.
 *
 * Authority is two independent facts, neither of them supplied by the request body. The caller's
 * own portal session names the provider subject it is authenticated as, which must be the exact
 * subject this Attempt journalled; and the caller's gateway assertion names the Principal Auth
 * Binding it authenticated through, which must be the exact binding this Attempt's journey
 * reserved. Together they are "the Principal this Attempt bound, presenting its own session" —
 * established from durable Attempt state alone, with no Core call and no caller-named identity.
 */

/** Namespaces this route's derived owner invocation so it can never collide with the start's. */
const CLAIM_INVOCATION_PURPOSE = 'commerce.portal-enrollment.invitation-claim.owner-invocation';
/** The outcome code the Attempt journal carries for a claim this route completed. */
const INVITATION_CLAIMED_OUTCOME_CODE = 'counterparty_invitation_claimed';
const digestOf = (parts: readonly string[]): string => enrollmentDigest(parts.join('\u0000'));

const isContractViolation = Schema.is(CounterpartyAccessContractViolation);

type ClaimOwnerFailure =
  | InstanceType<typeof CommerceEnrollmentOwnerEffectRejected>
  | InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>;

const claimUnavailable = (reason: string) =>
  new CommerceEnrollmentOwnerEffectUnavailable({ code: 'counterparty_invitation_claim_unavailable', reason });

/**
 * The owner refusal a domain violation becomes. A violation is the owner's own closed vocabulary
 * about this exact invitation, so it is recorded as a rejection the Attempt can show; anything else
 * is an unavailable owner, which leaves the transition indeterminate and therefore retryable.
 */
const ownerFailureFor = (failure: CounterpartyAccessDomainError): ClaimOwnerFailure =>
  isContractViolation(failure)
    ? new CommerceEnrollmentOwnerEffectRejected({ code: failure.code, reason: failure.reason })
    : claimUnavailable('The Counterparty Access invitation owner is temporarily unavailable');

/**
 * The same reading, one layer out, for whatever the governed claim Action fails with.
 *
 * Only the Action's own domain vocabulary is a decision about this invitation. Everything else the
 * Action runtime can fail with — a missing idempotency key, a permission check that could not run,
 * persistence that was briefly unavailable, an indeterminate commit — says nothing about the
 * invitation, and recording it as a refusal would strand an Attempt whose redemption has already
 * committed. Those stay unavailable, so the transition remains reconcilable.
 */
const claimActionFailure = (error: { readonly _tag: string }): ClaimOwnerFailure =>
  isContractViolation(error)
    ? new CommerceEnrollmentOwnerEffectRejected({ code: error.code, reason: error.reason })
    : claimUnavailable(`The Counterparty Access invitation claim could not be completed (${error._tag})`);

/**
 * The transport's own idempotency-key rule, applied before anything is claimed or redeemed.
 *
 * The claim Action declares `idempotency: 'required'`, so a request without a usable key is a
 * request defect rather than an owner decision — and one discovered after redemption committed
 * would be journalled as a refusal of the invitation itself.
 */
const IdempotencyKeyCarrierSchema = Schema.Struct({
  idempotencyKey: ActionTransportMetadataSchema.fields.idempotencyKey,
});

const requiredIdempotencyKey = (candidate: string | undefined) =>
  Schema.decodeEffect(IdempotencyKeyCarrierSchema)(candidate === undefined ? {} : { idempotencyKey: candidate }).pipe(
    Effect.mapError(commercePortalAuthEnrollmentInvalidProblem),
    Effect.flatMap((carrier) =>
      carrier.idempotencyKey === undefined
        ? Effect.fail(commercePortalAuthEnrollmentInvalidProblem())
        : Effect.succeed(carrier.idempotencyKey),
    ),
  );

/** The exact result reference a prior transition durably recorded, or `none` while it has not. */
const succeededResultReference = (
  operations: readonly EnrollmentOwnerOperationSnapshot[],
  ownerModuleKey: string,
  transitionKey: string,
): Option.Option<string> =>
  Option.fromNullishOr(
    operations.find(
      (operation) => operation.ownerModuleKey === ownerModuleKey && operation.transitionKey === transitionKey,
    ),
  ).pipe(
    Option.flatMap((operation) =>
      operation.status === 'SUCCEEDED' && operation.resultReference !== undefined
        ? Option.some(String(operation.resultReference))
        : Option.none(),
    ),
  );

/**
 * Whether this Attempt already carries the Tenant-scoped Principal Auth Binding a claim is recorded
 * under. Both Core transitions must be proven: a reservation alone is a binding nobody can
 * authenticate through, so a claim recorded against it would name a Principal that cannot act.
 */
export const commercePortalAuthEnrollmentBindingEstablished = (
  operations: readonly EnrollmentOwnerOperationSnapshot[],
): boolean =>
  Option.isSome(
    succeededResultReference(operations, CORE_IDENTITY_OWNER_MODULE_KEY, RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY),
  ) &&
  Option.isSome(
    succeededResultReference(operations, CORE_IDENTITY_OWNER_MODULE_KEY, ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY),
  );

/**
 * Whether this caller is the Principal this Attempt bound.
 *
 * The reservation's own result reference is the Core Principal Auth Binding identifier, and the
 * caller's verified gateway assertion names the binding it authenticated through. Comparing the two
 * is the whole check: a caller holding any other Principal's assertion — the shared Storefront
 * Client Principal included — names a different binding and is refused.
 */
export const commercePortalAuthEnrollmentClaimantBinding = (
  operations: readonly EnrollmentOwnerOperationSnapshot[],
  authBindingId: string | undefined,
): boolean =>
  authBindingId !== undefined &&
  Option.contains(
    succeededResultReference(operations, CORE_IDENTITY_OWNER_MODULE_KEY, RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY),
    authBindingId,
  );

/**
 * Whether this Attempt can still be claimed by a request at all. A terminal Attempt has nothing
 * left to record, and one of any other journey never declared the claim transition.
 */
export const commercePortalAuthEnrollmentClaimableAttempt = (attempt: EnrollmentAttemptSnapshot): boolean =>
  attempt.journey === 'COUNTERPARTY_INVITATION' &&
  attempt.invitationId !== undefined &&
  attempt.targetLegalEntityId !== undefined &&
  attempt.accountSubject !== undefined &&
  attempt.state !== 'TERMINATED';

interface ClaimSeams {
  readonly crypto: Crypto.Crypto;
  readonly run: CommerceEnrollmentOwnerTransactionRun;
  /** The authenticated scope the redemption stamps its claimant from; never a caller-named value. */
  readonly trustedScope: OperationalScope & { readonly legalEntityId: string };
}

/**
 * Redeem the secret, then claim under the proof it resolved to.
 *
 * Redemption is the claimability gate as well as the secret check: the owner routine locks the
 * invitation, refuses anything but a current invitation with a staged, unexpired proof, and stamps
 * the claimant from the authenticated scope rather than from anything a caller named. A retry after
 * the proof was already redeemed by this same Principal replays rather than failing, so a crash
 * between redemption and the claim converges instead of burning the invitation.
 */
const claimInvitationEffect = (
  seams: ClaimSeams,
  input: { readonly claimProofReference: string; readonly invitationId: string; readonly secret: Redacted.Redacted },
  runClaimAction: (payload: ClaimCounterpartyAccessInvitationPayload) => Effect.Effect<unknown, ClaimOwnerFailure>,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, ClaimOwnerFailure> => {
  const { crypto, run, trustedScope } = seams;
  const { legalEntityId, principalId, tenantId } = trustedScope;
  const invitationRef = {
    moduleId: 'commerce.customer-context' as const,
    resourceId: input.invitationId,
    resourceType: 'commerce.customer-context.counterparty-access-invitation' as const,
    tenantId,
  };
  return run({ legalEntityId, tenantId }, (transaction) =>
    counterpartyInvitationClaimRedemptionForTransaction(transaction, crypto, trustedScope)
      .redeem({ invitationRef, proofReference: input.claimProofReference, rawProof: input.secret })
      .pipe(
        Effect.flatMap((redeemed) =>
          readCounterpartyAccessInvitationForScope(transaction, tenantId, {
            counterpartyRef: redeemed.counterpartyRef,
            invitationId: input.invitationId,
            scope: redeemed.scope,
          }).pipe(Effect.map((invitation) => ({ invitation, redeemed }))),
        ),
        Effect.matchEffect({
          onFailure: (failure: CounterpartyAccessDomainError) => Effect.succeed({ failure, kind: 'refused' as const }),
          onSuccess: (resolved) => Effect.succeed({ kind: 'redeemed' as const, resolved }),
        }),
      ),
  ).pipe(
    Effect.mapError((failure) => claimUnavailable(failure.reason)),
    Effect.flatMap((redemption) =>
      redemption.kind === 'refused'
        ? Effect.fail(ownerFailureFor(redemption.failure))
        : runClaimAction({
            claimant: { principalId, tenantId },
            claimProofReference: redemption.resolved.redeemed.proofReference,
            counterpartyRef: redemption.resolved.redeemed.counterpartyRef,
            expectedRevision: redemption.resolved.invitation.revision,
            invitationRef,
            scope: redemption.resolved.redeemed.scope,
          }).pipe(
            Effect.flatMap(() =>
              Effect.all(
                {
                  outcomeCode: Schema.decodeEffect(EnrollmentKeySchema)(INVITATION_CLAIMED_OUTCOME_CODE),
                  resultReference: Schema.decodeEffect(EnrollmentResourceIdSchema)(
                    redemption.resolved.redeemed.proofReference,
                  ),
                  // Two independent in-memory decodes; neither reaches a shared downstream resource.
                },
                { concurrency: 2 },
              ).pipe(
                Effect.map(({ outcomeCode, resultReference }): CommerceEnrollmentOwnerEffectOutcome => ({
                  outcomeCode,
                  resultReference,
                  status: 'SUCCEEDED',
                })),
                Effect.mapError((cause) =>
                  claimUnavailable(`The invitation claim proof reference is not a usable owner result (${cause._tag})`),
                ),
              ),
            ),
          ),
    ),
  );
};

/**
 * The public answer for an owner refusal recorded on the journal. It never names the owner rule.
 *
 * A refusal reaches this from three places that record the same two fields — the dispatch's own
 * outcome, a reconciliation's resolution, and a journal entry a reconciliation left behind — so it
 * reads exactly those fields rather than any one of their shapes.
 */
const claimRefusalProblem = (outcome: { readonly failureReason?: string; readonly outcomeCode?: string }) =>
  outcome.outcomeCode === 'invitation_claim_proof_invalid' || outcome.outcomeCode === 'invitation_invalid'
    ? commercePortalAuthEnrollmentInvalidProblem(outcome.failureReason)
    : commercePortalAuthEnrollmentRejectedProblem(outcome.outcomeCode);

/** What one claim request settled on, once the driver's phases have run as far as they can. */
type ClaimSettlement =
  | { readonly kind: 'LEASE_HELD' }
  | { readonly kind: 'REFUSED'; readonly refusal: { readonly failureReason?: string; readonly outcomeCode?: string } }
  | { readonly kind: 'SETTLED' };

const claimSettled: ClaimSettlement = { kind: 'SETTLED' };
const claimLeaseHeld: ClaimSettlement = { kind: 'LEASE_HELD' };

const settlementOfExecution = (
  executed: Effect.Success<ReturnType<CommerceEnrollmentOwnerTransitionDriver['execute']>>,
): ClaimSettlement => {
  if (executed.outcome === 'LEASE_HELD') {
    return claimLeaseHeld;
  }
  return executed.outcome === 'RECORDED' && executed.ownerOutcome.status === 'FAILED'
    ? { kind: 'REFUSED', refusal: executed.ownerOutcome }
    : claimSettled;
};

/**
 * Claim, dispatch, record — and, when a prior request's answer never arrived, settle that request
 * before this one.
 *
 * The durable fence turns a lapsed claim into an INDETERMINATE operation no dispatch may pass, so a
 * route that only ever executed would answer every later request with the same retryable failure
 * for ever. Reconciling reads the invitation instead: a claim that committed replays from the
 * journal, and one that never did reopens the transition for the proof this request re-presented.
 */
const claimWithReconciliation = Effect.fn('CommercePortalAuthEnrollmentHttp.claimWithReconciliation')(
  function* claimWithReconciliationEffect(
    driver: CommerceEnrollmentOwnerTransitionDriver,
    store: CommerceEnrollmentOwnerAttemptStore,
    transition: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<ClaimSettlement, CommerceEnrollmentAttemptError> {
    const executed = yield* driver.execute(transition).pipe(
      Effect.asSome,
      Effect.catchTag('CommerceEnrollmentAttemptIndeterminate', () => Effect.succeedNone),
    );
    if (Option.isSome(executed)) {
      return settlementOfExecution(executed.value);
    }
    const identity = {
      portalEnrollmentAttemptId: transition.portalEnrollmentAttemptId,
      tenantId: transition.tenantId,
    };
    const fenced = yield* store.read(identity);
    const reconciled = yield* driver.reconcile({ ...transition, expectedRevision: fenced.revision });
    if (reconciled.outcome === 'REPLAYED') {
      return claimSettled;
    }
    if (reconciled.outcome === 'NO_EFFECT') {
      return { kind: 'REFUSED', refusal: reconciled.operation };
    }
    if (reconciled.resolution.status === 'SUCCEEDED') {
      return claimSettled;
    }
    if (reconciled.resolution.outcomeCode !== COUNTERPARTY_INVITATION_CLAIM_OPEN_OUTCOME_CODE) {
      return { kind: 'REFUSED', refusal: reconciled.resolution };
    }
    // The invitation is still unclaimed, so the lost dispatch never committed: this request's own
    // re-presented proof is dispatched over the reopened transition.
    const reopened = yield* store.read(identity);
    return settlementOfExecution(yield* driver.execute({ ...transition, expectedRevision: reopened.revision }));
  },
);

/**
 * Claim the invitation this Attempt was started for.
 *
 * The claim travels through the generic owner driver, exactly as the continuation's own transitions
 * do: the durable claim and its lease are what authorize the one external effect, an answer that
 * never arrived leaves the transition reconcilable rather than repeated, and a request replaying a
 * claim the journal already proved is answered from that journal without touching the invitation.
 */
export const commercePortalAuthEnrollmentClaimInvitation = Effect.fn(
  'CommercePortalAuthEnrollmentHttp.claimInvitation',
)(function* claimInvitationRouteEffect(
  portalEnrollmentAttemptId: typeof EnrollmentAttemptIdSchema.Type,
  payload: Schema.Codec.Encoded<typeof CommercePortalAuthEnrollmentClaimInvitationInputSchema>,
  idempotencyKey: string | undefined,
  request: HttpServerRequest.HttpServerRequest,
) {
  yield* noStoreHeaders;
  yield* requireTrustedOrigin(request.headers, () => commercePortalAuthEnrollmentUntrustedOriginProblem);
  const input = yield* Schema.decodeEffect(CommercePortalAuthEnrollmentClaimInvitationInputSchema, {
    onExcessProperty: 'error',
  })(payload).pipe(Effect.mapError(commercePortalAuthEnrollmentInvalidProblem));
  // Ahead of every durable phase on purpose: the claim Action requires this key, and discovering it
  // missing after the secret was redeemed would journal a request defect as a refused invitation.
  const claimIdempotencyKey = yield* requiredIdempotencyKey(idempotencyKey);
  const principal = yield* authenticateOperationPrincipal(Redacted.make(request.headers['authorization']), {
    authentication: () => commercePortalAuthEnrollmentAuthenticationProblem,
    unavailable: () => commercePortalAuthEnrollmentUnavailableProblem(),
  });
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
  const crypto = yield* Crypto.Crypto;
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
  const { accountSubject, invitationId, targetLegalEntityId } = attempt;
  if (
    !commercePortalAuthEnrollmentClaimableAttempt(attempt) ||
    accountSubject === undefined ||
    invitationId === undefined ||
    targetLegalEntityId === undefined
  ) {
    // An Attempt of another journey, one that carries no invitation and one that is already
    // terminal are all answered exactly as an absent Attempt is.
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }
  if (principal.legalEntityId !== String(targetLegalEntityId)) {
    // The claim Action is Legal Entity scoped, and the only Legal Entity this Attempt may claim
    // into is the one its own intent named.
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }

  const operations = yield* Effect.forEach(
    [
      { ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY, transitionKey: RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY },
      { ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY, transitionKey: ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY },
      {
        ownerModuleKey: COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
        transitionKey: CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
      },
    ],
    ({ ownerModuleKey, transitionKey }) =>
      Schema.decodeEffect(ReadEnrollmentOwnerOperationInputSchema)({
        ownerModuleKey,
        portalEnrollmentAttemptId,
        tenantId,
        transitionKey,
      }).pipe(
        Effect.flatMap((identity) =>
          store.readOwnerOperation(identity).pipe(
            Effect.asSome,
            Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeedNone),
          ),
        ),
      ),
    // Three durable reads of the same Attempt, each in its own transaction.
    { concurrency: 3 },
  ).pipe(
    Effect.map((entries) => entries.flatMap((entry) => (Option.isNone(entry) ? [] : [entry.value]))),
    Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)),
  );
  if (!commercePortalAuthEnrollmentClaimantBinding(operations, principal.authBindingId)) {
    return yield* Effect.fail(commercePortalAuthEnrollmentNotFoundProblem());
  }
  const provider = yield* CommercePortalAuthService;
  const lifecycle = yield* CommercePortalAuthSessionLifecycle;
  const session = yield* commercePortalAuthEnrollmentSessionSubject(
    provider,
    lifecycle,
    requestHeaders(request.headers),
  );
  if (Option.isNone(session) || session.value.providerSubjectId !== accountSubject.providerSubjectId) {
    return yield* Effect.fail(commercePortalAuthEnrollmentAuthenticationProblem);
  }
  if (!commercePortalAuthEnrollmentBindingEstablished(operations)) {
    return yield* Effect.fail(commercePortalAuthEnrollmentBindingPendingProblem());
  }
  if (
    Option.isSome(
      succeededResultReference(
        operations,
        COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
        CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
      ),
    )
  ) {
    // The journal already proves this Attempt's one claim, so the replay is answered from it. The
    // driver cannot answer it once the completed journey made the Attempt terminal, and dispatching
    // again would spend a proof the redemption has already consumed.
    return commercePortalAuthEnrollmentAttemptProjection(attempt);
  }

  const runActionHttp = bindGovernedActionHttp({ authenticate: () => Effect.succeed(principal) });
  /**
   * The claim Action's own service graph, captured here rather than left in the dispatch's
   * requirements: the owner driver dispatches one external effect with nothing ambient behind it,
   * so the services this route was composed with travel into that effect explicitly.
   */
  const claimActionServices = yield* Effect.context<
    ActionRuntime | ContextAccess | CounterpartyInvitationProofDelivery | Crypto.Crypto | PrincipalEligibility
  >();
  const runClaimAction = (claimPayload: ClaimCounterpartyAccessInvitationPayload) =>
    runActionHttp({
      endpointHeaders: { idempotencyKey: claimIdempotencyKey, traceId: request.headers['x-trace-id'] },
      internalProblem: () => claimUnavailable('The Counterparty Access invitation claim could not be executed'),
      invalidCorrelationProblem: () =>
        claimUnavailable('The Counterparty Access invitation claim carried an unusable correlation'),
      mapError: claimActionFailure,
      payload: claimPayload,
      registration: claimCounterpartyAccessInvitationAction,
      requestHeaders: {
        authorization: Redacted.make(request.headers['authorization']),
        'x-correlation-id': request.headers['x-correlation-id'],
      },
    }).pipe(Effect.provideContext(claimActionServices));

  const claimCorrelation = `commerce-enrollment-invitation-claim:${portalEnrollmentAttemptId}`;
  const transition: CommerceEnrollmentOwnerTransition = yield* Schema.decodeEffect(
    CommerceEnrollmentOwnerTransitionSchema,
  )({
    actorPrincipalId,
    correlationId: claimCorrelation,
    expectedRevision: attempt.revision,
    ownerInvocationId: retailSelfEnrollmentEvidenceReference([
      CLAIM_INVOCATION_PURPOSE,
      String(tenantId),
      String(portalEnrollmentAttemptId),
      CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
    ]),
    ownerModuleKey: COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
    portalEnrollmentAttemptId,
    requestDigest: yield* Schema.decodeEffect(EnrollmentDigestSchema)(
      digestOf([
        COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
        CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
        String(portalEnrollmentAttemptId),
        String(invitationId),
      ]),
    ).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem)),
    tenantId,
    transitionKey: CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
  }).pipe(Effect.mapError(commercePortalAuthEnrollmentUnavailableProblem));

  const seams: ClaimSeams = {
    crypto,
    run: runner.run,
    trustedScope: {
      ...principal,
      correlationId: claimCorrelation,
      legalEntityId: String(targetLegalEntityId),
    },
  };
  const driver = commerceEnrollmentOwnerTransitionDriverFor({
    attempt: store,
    owner: {
      dispatch: () =>
        claimInvitationEffect(
          seams,
          {
            claimProofReference: input.claimProofReference,
            invitationId: String(invitationId),
            secret: input.invitationSecret,
          },
          runClaimAction,
        ),
      // Only the recipient holds the secret, so nothing may claim on its behalf — but the invitation
      // the claim commits against is durable, so a lapsed claim is settled by reading it.
      reconcile: counterpartyInvitationClaimReconciliationFor(runner.run, {
        boundPrincipalId: String(actorPrincipalId),
        invitationId: String(invitationId),
        legalEntityId: String(targetLegalEntityId),
        portalEnrollmentAttemptId,
        tenantId: String(tenantId),
      }),
    },
    required: true,
    workerId: () => `commerce.customer-context.invitation-claim:${portalEnrollmentAttemptId}`,
  });
  const executed = yield* claimWithReconciliation(driver, store, transition).pipe(
    Effect.mapError((failure) =>
      failure.retryable
        ? commercePortalAuthEnrollmentUnavailableProblem(failure)
        : commercePortalAuthEnrollmentRejectedProblem(failure),
    ),
  );
  if (executed.kind === 'LEASE_HELD') {
    return yield* Effect.fail(commercePortalAuthEnrollmentBindingPendingProblem());
  }
  if (executed.kind === 'REFUSED') {
    return yield* Effect.fail(claimRefusalProblem(executed.refusal));
  }
  const settled = yield* store
    .read({ portalEnrollmentAttemptId, tenantId })
    .pipe(Effect.mapError((failure) => commercePortalAuthEnrollmentUnavailableProblem(failure)));
  // Detached for the same reason the start route detaches: cancelling this request must never
  // cancel a claimed owner transition mid-flight.
  yield* continuation.advance({ portalEnrollmentAttemptId, tenantId }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Effect.annotateLogs(Effect.logWarning('The Commerce enrollment continuation did not advance this Attempt'), {
          cause: Cause.pretty(cause),
          portalEnrollmentAttemptId: String(portalEnrollmentAttemptId),
        }),
      onSuccess: () => Effect.void,
    }),
    Effect.forkDetach,
    Effect.asVoid,
  );
  return commercePortalAuthEnrollmentAttemptProjection(settled);
});
