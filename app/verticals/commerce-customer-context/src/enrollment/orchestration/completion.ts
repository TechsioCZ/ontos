import { Effect, Schema } from 'effect';

import type {
  DerivedEnrollmentAttemptState,
  EnrollmentAttemptSnapshot,
  EnrollmentOwnerOutcomeSignal,
  ReadEnrollmentOwnerOperationInput,
} from '../../../shared/enrollment-contracts.ts';
import { ReadEnrollmentOwnerOperationInputSchema } from '../../../shared/enrollment-contracts.ts';
import type {
  CommerceEnrollmentAttemptCompletionAuthority,
  CommerceEnrollmentAttemptPendingOutcome,
} from '../attempts/attempt-service.ts';
import type { CommerceEnrollmentAttemptPersistence } from '../attempts/attempt-persistence.ts';
import { CommerceEnrollmentAttemptNotFound, CommerceEnrollmentAttemptRejected } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { counterpartyInvitationJourneyDefinition } from '../journeys/counterparty-invitation.ts';
import { EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS, existingAccountStepPlan } from '../journeys/existing-account.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from '../journeys/journey-contracts.ts';
import { JourneyDefinitionSchema, journeyTransitionIdentity } from '../journeys/journey-contracts.ts';
import { retailSelfEnrollmentJourneyDefinition } from '../journeys/retail-self-enrollment-contracts.ts';

/**
 * Derived completion (issue #338 "Acceptance → an Attempt reaches COMPLETE only when its journey's
 * required transitions are proven").
 *
 * The Attempt's overall state is a *conclusion* about the durable owner journal, never a field an
 * owner hands in with its own outcome.  This module holds the whole conclusion: which transitions
 * a journey requires, what counts as proof for one of them, and what the Attempt's state therefore
 * is after the outcome being recorded lands.
 *
 * Nothing here performs an owner effect, reads a credential or writes: it reads the journal the
 * Attempt routines already keep and returns one state.  The PostgreSQL routines keep their own
 * independent completion gate, so a mistake here can only ever be *more* conservative than the
 * durable fence, never less.
 */

/**
 * What the durable journal knows about one owner transition of this Attempt.  `required` is the
 * flag persisted when the transition was claimed, so a transition the owner claimed as optional
 * cannot later prove a journey-required step.
 */
export interface EnrollmentTransitionProof {
  readonly ownerModuleKey: string;
  readonly required: boolean;
  readonly status: 'FAILED' | 'INDETERMINATE' | 'IN_PROGRESS' | 'RECONCILIATION_REQUIRED' | 'SUCCEEDED';
  readonly transitionKey: string;
}

export interface EnrollmentCompletionInput {
  /** The journey whose required transitions gate completion for this exact Attempt. */
  readonly definition: JourneyDefinition;
  /** The final status of the outcome being recorded right now. */
  readonly outcomeStatus: 'FAILED' | 'SUCCEEDED';
  /** Journal proof for every declared transition, with the pending outcome already applied. */
  readonly proofs: readonly EnrollmentTransitionProof[];
  /** The recording owner's own signal about its transition.  It can never name COMPLETE. */
  readonly signal?: EnrollmentOwnerOutcomeSignal;
}

const sameTransition = (proof: EnrollmentTransitionProof, transition: JourneyTransitionSpec): boolean =>
  proof.ownerModuleKey === transition.ownerModuleKey && proof.transitionKey === transition.transitionKey;

/** A required transition is proven only by a durable, final, required SUCCEEDED owner outcome. */
const isProven = (proofs: readonly EnrollmentTransitionProof[], transition: JourneyTransitionSpec): boolean =>
  proofs.some((proof) => sameTransition(proof, transition) && proof.required && proof.status === 'SUCCEEDED');

const awaitsReconciliation = (proof: EnrollmentTransitionProof): boolean =>
  proof.status === 'INDETERMINATE' || proof.status === 'RECONCILIATION_REQUIRED';

/**
 * The single completion rule.
 *
 * An unresolved owner effect outranks everything: while any declared transition is indeterminate,
 * the Attempt cannot be described as progressing or finished, only as needing reconciliation.  A
 * failed outcome never completes a journey even when every required transition is already proven,
 * because the Attempt's last word would then contradict its own state.  Otherwise the Attempt is
 * COMPLETE exactly when every required transition the journey declares carries proof, and stays
 * IN_PROGRESS — or VERIFICATION_REQUIRED, when the owner asked for it — while one does not.
 */
export const deriveEnrollmentAttemptState = ({
  definition,
  outcomeStatus,
  proofs,
  signal,
}: EnrollmentCompletionInput): DerivedEnrollmentAttemptState => {
  if (signal === 'RECONCILIATION_REQUIRED' || proofs.some(awaitsReconciliation)) {
    return 'RECONCILIATION_REQUIRED';
  }
  if (
    outcomeStatus === 'SUCCEEDED' &&
    definition.requiredTransitions.every((transition) => isProven(proofs, transition))
  ) {
    return 'COMPLETE';
  }
  return signal === 'VERIFICATION_REQUIRED' ? 'VERIFICATION_REQUIRED' : 'IN_PROGRESS';
};

const invalid = (reason: string, cause: unknown): CommerceEnrollmentAttemptError =>
  Object.defineProperty(
    new CommerceEnrollmentAttemptRejected({ code: 'attempt_invalid', reason: reason.slice(0, 500), retryable: false }),
    'cause',
    { enumerable: false, value: cause },
  );

const existingAccountCoreIdentity = new Set(EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS.map(journeyTransitionIdentity));

/**
 * Existing-account declares the second Tenant's Principal Auth Binding steps itself, and a target
 * journey may declare the very same activation step under the very same transition key — that is
 * deliberate, so one owner-effect case serves both.  A journey may name a transition only once, so
 * the target's own copy of a step Existing-account already declares is dropped before composing:
 * the step still gates completion, just once rather than twice.
 */
const existingAccountTarget = (
  target: JourneyDefinition,
): Effect.Effect<JourneyDefinition, CommerceEnrollmentAttemptError> => {
  const undeclared = (transition: JourneyTransitionSpec): boolean =>
    !existingAccountCoreIdentity.has(journeyTransitionIdentity(transition));
  return Schema.decodeEffect(JourneyDefinitionSchema)({
    kind: target.kind,
    optionalTransitions: target.optionalTransitions.filter(undeclared),
    requiredTransitions: target.requiredTransitions.filter(undeclared),
  }).pipe(
    Effect.mapError((cause) =>
      invalid('The target journey declares no step an Existing-account Attempt could continue as', cause),
    ),
  );
};

/**
 * Existing-account's own composed step plan, read back as the definition that gates completion.
 * The plan already carries each step's `required` flag, so re-shaping it into a declaration is a
 * lossless view of what the journey module composed rather than a second copy of its rule.
 */
const existingAccountDefinition = (
  target: JourneyDefinition,
): Effect.Effect<JourneyDefinition, CommerceEnrollmentAttemptError> =>
  existingAccountStepPlan(target).pipe(
    Effect.flatMap((plan) =>
      Schema.decodeEffect(JourneyDefinitionSchema)({
        kind: 'EXISTING_ACCOUNT',
        optionalTransitions: plan.filter((transition) => !transition.required),
        requiredTransitions: plan.filter((transition) => transition.required),
      }),
    ),
    Effect.mapError((cause) =>
      invalid('The Existing-account Attempt does not compose a journey definition that can gate completion', cause),
    ),
  );

/**
 * The journey definition that gates one exact Attempt.
 *
 * Existing-account enrollment has no fixed required set: it continues an already-authenticated
 * subject into a second Tenant as whichever journey that Tenant's enrollment is, so its definition
 * is composed from the target journey.  The Attempt's own immutable intent selects that target —
 * an `invitationId` means the second Tenant is being entered through a Counterparty invitation.
 */
export const enrollmentJourneyDefinitionForAttempt = (
  attempt: EnrollmentAttemptSnapshot,
): Effect.Effect<JourneyDefinition, CommerceEnrollmentAttemptError> => {
  if (attempt.journey === 'RETAIL_SELF_ENROLLMENT') {
    return Effect.succeed(retailSelfEnrollmentJourneyDefinition);
  }
  if (attempt.journey === 'COUNTERPARTY_INVITATION') {
    return Effect.succeed(counterpartyInvitationJourneyDefinition);
  }
  const target =
    attempt.invitationId === undefined
      ? retailSelfEnrollmentJourneyDefinition
      : counterpartyInvitationJourneyDefinition;
  return existingAccountTarget(target).pipe(Effect.flatMap(existingAccountDefinition));
};

const readInputFor = (
  attempt: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
): Effect.Effect<ReadEnrollmentOwnerOperationInput, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(ReadEnrollmentOwnerOperationInputSchema)({
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    tenantId: attempt.tenantId,
    transitionKey: transition.transitionKey,
  }).pipe(Effect.mapError((cause) => invalid('A declared journey transition identity is invalid', cause)));

const isNotFound = Schema.is(CommerceEnrollmentAttemptNotFound);

/**
 * Journal proof for one declared transition, as a list so that absence is data rather than a hole.
 * A transition that was never claimed has no journal row at all, which is proof of absence rather
 * than a failure: it simply is not proven yet.
 */
const proofFor = (
  persistence: CommerceEnrollmentAttemptPersistence,
  attempt: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
): Effect.Effect<readonly EnrollmentTransitionProof[], CommerceEnrollmentAttemptError> =>
  readInputFor(attempt, transition).pipe(
    Effect.flatMap((input) => persistence.readOperation(input)),
    Effect.map((operation): readonly EnrollmentTransitionProof[] => [
      {
        ownerModuleKey: operation.ownerModuleKey,
        required: operation.required,
        status: operation.status,
        transitionKey: operation.transitionKey,
      },
    ]),
    Effect.catchIf(isNotFound, () => Effect.succeed([])),
  );

/** The pending outcome is authoritative for its own transition: it has not been journalled yet. */
const applyPendingOutcome = (
  proofs: readonly EnrollmentTransitionProof[],
  outcome: CommerceEnrollmentAttemptPendingOutcome,
): readonly EnrollmentTransitionProof[] =>
  proofs.map((proof) =>
    proof.ownerModuleKey === outcome.ownerModuleKey && proof.transitionKey === outcome.transitionKey
      ? { ...proof, status: outcome.status }
      : proof,
  );

const completionInputFor = (
  definition: JourneyDefinition,
  outcome: CommerceEnrollmentAttemptPendingOutcome,
  proofs: readonly EnrollmentTransitionProof[],
): EnrollmentCompletionInput => {
  const applied = applyPendingOutcome(proofs, outcome);
  const base = { definition, outcomeStatus: outcome.status, proofs: applied };
  return outcome.signal === undefined ? base : { ...base, signal: outcome.signal };
};

const deriveForDefinition = (
  persistence: CommerceEnrollmentAttemptPersistence,
  attempt: EnrollmentAttemptSnapshot,
  outcome: CommerceEnrollmentAttemptPendingOutcome,
  definition: JourneyDefinition,
): Effect.Effect<DerivedEnrollmentAttemptState, CommerceEnrollmentAttemptError> =>
  Effect.forEach(definition.requiredTransitions, (transition) => proofFor(persistence, attempt, transition), {
    concurrency: 1,
  }).pipe(
    Effect.map((journalled) => completionInputFor(definition, outcome, journalled.flat())),
    Effect.map(deriveEnrollmentAttemptState),
  );

/**
 * Bind the completion rule to one Attempt transaction.  The reads run through the same durable
 * façade as every other Attempt phase, so the derivation sees exactly the journal the routine is
 * about to update and never a value the caller supplied.
 */
export const commerceEnrollmentCompletionAuthorityForPersistence = (
  persistence: CommerceEnrollmentAttemptPersistence,
): CommerceEnrollmentAttemptCompletionAuthority => ({
  derive: (attempt, outcome) =>
    enrollmentJourneyDefinitionForAttempt(attempt).pipe(
      Effect.flatMap((definition) => deriveForDefinition(persistence, attempt, outcome, definition)),
    ),
});
