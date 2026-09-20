import { Context, DateTime, Effect, Layer, Option, Schema, Semaphore } from 'effect';

import {
  EnrollmentActionInvocationIdSchema,
  ReadEnrollmentOwnerOperationInputSchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import type {
  EnrollmentAttemptSnapshot,
  EnrollmentAttemptState,
  EnrollmentOwnerOperationSnapshot,
  ReadEnrollmentAttemptInput,
} from '../../../shared/enrollment-contracts.ts';
import type { ListStaleEnrollmentAttemptsInput, StaleEnrollmentAttempt } from '../attempts/attempt-persistence.ts';
import { attemptRejected } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { journeyTransitionIdentity, journeyTransitions } from '../journeys/journey-contracts.ts';
import type { JourneyTransitionSpec } from '../journeys/journey-contracts.ts';
import {
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
  retailSelfEnrollmentEvidenceReference,
} from '../journeys/retail-self-enrollment-contracts.ts';
import { enrollmentJourneyDefinitionForAttempt } from '../orchestration/completion.ts';
import { CommerceEnrollmentOwnerEffectRegistry } from '../orchestration/owner-effect-registry.ts';
import type { CommerceEnrollmentRegisteredOwnerEffect } from '../orchestration/owner-effect-registry.ts';
import {
  CommerceEnrollmentOwnerTransitionSchema,
  commerceEnrollmentOwnerTransitionDriverFor,
} from '../orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
  commerceEnrollmentStaleAttemptStoreForRun,
} from '../orchestration/owner-transition-production.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from '../orchestration/preparation-subject.ts';
import type { CommerceEnrollmentPreparationSubjectResolve } from '../orchestration/preparation-subject.ts';

/**
 * `POST /enrollment/start` commits one Attempt and the one provider account its claim authorizes;
 * every further transition is dispatched here, after that request committed and outside every
 * governed Action transaction.
 *
 * Every owner invocation identity is derived from the durable Attempt, so a re-run presents the
 * same claim and the journal replays the transition instead of repeating the external effect.
 */

const CONTINUATION_WORKER_PREFIX = 'commerce.customer-context.enrollment-continuation';
const CONTINUATION_INVOCATION_PURPOSE = 'commerce.portal-enrollment.continuation.owner-invocation';
const LEASE_DURATION_MS = 30_000;
/** Enrollment bursts queue here rather than flooding the owners a journey dispatches into. */
const CONTINUATION_CONCURRENCY = 8;
/** The longest journey's transition count, plus one pass to settle a reconciliation. */
const CONTINUATION_PASS_BUDGET = 8;

interface CommerceEnrollmentContinuationHalt {
  /**
   * `IN_FLIGHT`: another worker holds the transition's lease. `NO_OWNER_EFFECT`: this deployment
   * registers no owner effect that may dispatch it, so the Attempt is left exactly as it was.
   * `RECONCILIATION_REQUIRED`: an owner decision is pending. None of the six is a completed journey.
   */
  readonly reason:
    | 'ATTEMPT_TERMINAL'
    | 'IN_FLIGHT'
    | 'NO_OWNER_EFFECT'
    | 'OWNER_REJECTED'
    | 'RECONCILIATION_REQUIRED'
    | 'VERIFICATION_REQUIRED';
  /** `none` when the halt is about the Attempt itself rather than about one transition. */
  readonly transition: Option.Option<JourneyTransitionSpec>;
}

export type CommerceEnrollmentContinuationResult =
  | { readonly outcome: 'COMPLETE' }
  | { readonly halt: CommerceEnrollmentContinuationHalt; readonly outcome: 'HALTED' };

export interface CommerceEnrollmentContinuationService {
  /**
   * Advance one Attempt as far as its journey and its durable journal allow. Failure is always a
   * typed Attempt failure; a halt is an ordinary success that simply is not a completion.
   */
  readonly advance: (
    input: ReadEnrollmentAttemptInput,
  ) => Effect.Effect<CommerceEnrollmentContinuationResult, CommerceEnrollmentAttemptError>;
  /**
   * The Attempts of one Tenant the durable journal says are still owed a transition. It lives
   * beside `advance` because the sweeper is handed this service and nothing else, and its own
   * memory of what it started does not survive the process that built it.
   */
  readonly listStale: (
    input: ListStaleEnrollmentAttemptsInput & { readonly tenantId: ReadEnrollmentAttemptInput['tenantId'] },
  ) => Effect.Effect<readonly StaleEnrollmentAttempt[], CommerceEnrollmentAttemptError>;
}

export class CommerceEnrollmentContinuation extends Context.Service<
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationService
>()('@app/commerce-customer-context/enrollment/continuation/enrollment-continuation/CommerceEnrollmentContinuation') {}

type OwnerDispatch = CommerceEnrollmentOwnerEffect['dispatch'];

type PassResult =
  | { readonly kind: 'ADVANCED' }
  | { readonly halt: CommerceEnrollmentContinuationHalt; readonly kind: 'HALTED' }
  | { readonly attemptState: EnrollmentAttemptState; readonly kind: 'SETTLED' };

const advanced: PassResult = { kind: 'ADVANCED' };

const halted = (
  reason: CommerceEnrollmentContinuationHalt['reason'],
  transition?: JourneyTransitionSpec,
): PassResult => ({
  halt: { reason, transition: Option.fromNullishOr(transition) },
  kind: 'HALTED',
});

/**
 * A durable owner failure is a reconciliation halt when the owner said its decision is pending
 * rather than refused; owners speak that through the shared reconciliation failure code, so the
 * reading never depends on a journey's own outcome vocabulary.
 */
const failureHalt = (
  transition: JourneyTransitionSpec,
  failure: {
    readonly failureCode?: string;
    readonly nextState?: 'IN_PROGRESS' | 'RECONCILIATION_REQUIRED' | 'VERIFICATION_REQUIRED';
  },
): PassResult =>
  halted(
    failure.nextState === 'RECONCILIATION_REQUIRED' ||
      failure.failureCode === OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE
      ? 'RECONCILIATION_REQUIRED'
      : 'OWNER_REJECTED',
    transition,
  );

const leaseIsActive = (lease: EnrollmentOwnerOperationSnapshot['lease']): Effect.Effect<boolean> =>
  lease === undefined
    ? Effect.succeed(false)
    : DateTime.now.pipe(Effect.map((now) => DateTime.isLessThan(now, lease.leaseExpiresAt)));

/**
 * The owner invocation identity is derived, never minted: a re-run after a crash presents the
 * identical claim, so the durable journal replays rather than authorizing a second effect.
 */
const ownerInvocationIdFor = (
  attempt: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
): Effect.Effect<typeof EnrollmentActionInvocationIdSchema.Type, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(
    retailSelfEnrollmentEvidenceReference([
      CONTINUATION_INVOCATION_PURPOSE,
      attempt.tenantId,
      attempt.portalEnrollmentAttemptId,
      transition.ownerModuleKey,
      transition.transitionKey,
    ]),
  ).pipe(
    Effect.mapError((cause) =>
      attemptRejected(
        'The continuation could not derive a stable owner invocation identity for this transition',
        attempt.portalEnrollmentAttemptId,
        cause,
      ),
    ),
  );

const transitionFor = (
  attempt: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
  ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type,
  requestDigest: string,
): Effect.Effect<CommerceEnrollmentOwnerTransition, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: attempt.createdByPrincipalId,
    correlationId: `${CONTINUATION_WORKER_PREFIX}:${attempt.portalEnrollmentAttemptId}`,
    expectedRevision: attempt.revision,
    ownerInvocationId,
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    requestDigest,
    tenantId: attempt.tenantId,
    transitionKey: transition.transitionKey,
  }).pipe(
    Effect.mapError((cause) =>
      attemptRejected(
        'The continuation could not build the owner transition identity for this Attempt',
        attempt.portalEnrollmentAttemptId,
        cause,
      ),
    ),
  );

/** The durable owner journal entry for one declared transition, or `none` when never claimed. */
const readOperation = (
  store: CommerceEnrollmentOwnerAttemptStore,
  attempt: EnrollmentAttemptSnapshot,
  transition: JourneyTransitionSpec,
): Effect.Effect<Option.Option<EnrollmentOwnerOperationSnapshot>, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(ReadEnrollmentOwnerOperationInputSchema)({
    ownerModuleKey: transition.ownerModuleKey,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
    tenantId: attempt.tenantId,
    transitionKey: transition.transitionKey,
  }).pipe(
    Effect.mapError((cause) =>
      attemptRejected(
        'A declared journey transition is not addressable in the durable owner journal',
        attempt.portalEnrollmentAttemptId,
        cause,
      ),
    ),
    Effect.flatMap((identity) =>
      store.readOwnerOperation(identity).pipe(
        Effect.asSome,
        Effect.catchTag('CommerceEnrollmentAttemptNotFound', () => Effect.succeedNone),
      ),
    ),
  );

const readJournal = (
  store: CommerceEnrollmentOwnerAttemptStore,
  attempt: EnrollmentAttemptSnapshot,
  transitions: readonly JourneyTransitionSpec[],
): Effect.Effect<readonly EnrollmentOwnerOperationSnapshot[], CommerceEnrollmentAttemptError> =>
  Effect.forEach(transitions, (transition) => readOperation(store, attempt, transition), { concurrency: 4 }).pipe(
    Effect.map((entries) => entries.flatMap((entry) => (Option.isNone(entry) ? [] : [entry.value]))),
  );

interface ContinuationSeams {
  readonly registry: CommerceEnrollmentOwnerEffectRegistry['Service'];
  readonly resolveSubject: CommerceEnrollmentPreparationSubjectResolve;
  readonly store: (attempt: ReadEnrollmentAttemptInput) => CommerceEnrollmentOwnerAttemptStore;
}

interface StepInput {
  readonly attempt: EnrollmentAttemptSnapshot;
  readonly operation: Option.Option<EnrollmentOwnerOperationSnapshot>;
  readonly owner: CommerceEnrollmentRegisteredOwnerEffect;
  readonly store: CommerceEnrollmentOwnerAttemptStore;
  readonly transition: JourneyTransitionSpec;
}

/** A reconciliation phase never dispatches, so the driver is handed an unreachable dispatch. */
const unreachableDispatch: OwnerDispatch = () =>
  Effect.die('The enrollment continuation does not dispatch while reconciling an owner operation');

const driverFor = (input: StepInput, dispatch: OwnerDispatch) =>
  commerceEnrollmentOwnerTransitionDriverFor({
    attempt: input.store,
    leaseDurationMs: LEASE_DURATION_MS,
    owner: { dispatch, reconcile: input.owner.reconcile },
    required: input.transition.required,
    workerId: (transition) => `${CONTINUATION_WORKER_PREFIX}:${transition.ownerInvocationId}`,
  });

/**
 * Settle one already dispatched transition whose answer never arrived. The identity it reconciles
 * under is read back from the immutable journal entry — never re-derived — so a transition first
 * dispatched by the start route is reconciled as that route's invocation.
 */
const reconcileStep = Effect.fn('CommerceEnrollmentContinuation.reconcile')(function* reconcileStepEffect(
  input: StepInput,
  operation: EnrollmentOwnerOperationSnapshot,
): Effect.fn.Return<PassResult, CommerceEnrollmentAttemptError> {
  const transition = yield* transitionFor(
    input.attempt,
    input.transition,
    operation.ownerInvocationId,
    operation.requestDigest,
  );
  const reconciled = yield* driverFor(input, unreachableDispatch).reconcile(transition);
  const settled = reconciled.outcome === 'RECORDED' ? reconciled.resolution : reconciled.operation;
  return settled.status === 'SUCCEEDED' ? advanced : failureHalt(input.transition, settled);
});

/** Claim, dispatch outside every transaction, record. The driver owns all three phases. */
const dispatchStep = Effect.fn('CommerceEnrollmentContinuation.dispatch')(function* dispatchStepEffect(
  input: StepInput,
  dispatch: OwnerDispatch,
  requestDigest: string,
): Effect.fn.Return<PassResult, CommerceEnrollmentAttemptError> {
  const ownerInvocationId = yield* ownerInvocationIdFor(input.attempt, input.transition);
  const transition = yield* transitionFor(input.attempt, input.transition, ownerInvocationId, requestDigest);
  const executed = yield* driverFor(input, dispatch)
    .execute(transition)
    .pipe(
      Effect.asSome,
      // The owner's answer is unknown. Nothing is recorded and nothing is dispatched a second time:
      // the next `advance` observes an INDETERMINATE operation and settles it by reading the owner.
      Effect.catchTag('CommerceEnrollmentAttemptIndeterminate', () => Effect.succeedNone),
    );
  if (Option.isNone(executed)) {
    return halted('RECONCILIATION_REQUIRED', input.transition);
  }
  const execution = executed.value;
  if (execution.outcome === 'LEASE_HELD') {
    return halted('IN_FLIGHT', input.transition);
  }
  if (execution.outcome === 'REPLAYED') {
    return advanced;
  }
  return execution.ownerOutcome.status === 'SUCCEEDED'
    ? advanced
    : failureHalt(input.transition, execution.ownerOutcome);
});

/** The verdict for one declared transition, decided from the durable journal before anything runs. */
const runTransition = Effect.fn('CommerceEnrollmentContinuation.runTransition')(function* runTransitionEffect(
  input: StepInput,
): Effect.fn.Return<PassResult, CommerceEnrollmentAttemptError> {
  const { operation } = input;
  if (Option.isSome(operation)) {
    const { status } = operation.value;
    if (status === 'INDETERMINATE' || status === 'RECONCILIATION_REQUIRED') {
      return yield* reconcileStep(input, operation.value);
    }
    if (status === 'FAILED') {
      return failureHalt(input.transition, operation.value);
    }
    if (status === 'IN_PROGRESS') {
      // Only the lease holder may finish a running dispatch; once the lease lapses the transition is
      // settled by reading the owner — the driver's reconcile phase fences the stale row first.
      return (yield* leaseIsActive(operation.value.lease))
        ? halted('IN_FLIGHT', input.transition)
        : yield* reconcileStep(input, operation.value);
    }
  }
  const { dispatch } = input.owner;
  if (Option.isNone(dispatch)) {
    // Either the transition's dispatch belongs to another caller, or an owner operation is still
    // leased. Either way the Attempt is left exactly as it was: no claim, no lease, no revision.
    return halted(Option.isSome(operation) ? 'IN_FLIGHT' : 'NO_OWNER_EFFECT', input.transition);
  }
  return yield* dispatchStep(input, dispatch.value.effect, dispatch.value.requestDigest);
});

/**
 * One pass over the journey: re-read the Attempt, find the first required transition the journal
 * has not proven, and run exactly that one. `advance` loops the pass, so every step sees a fresh
 * Attempt revision and a freshly resolved subject.
 */
const advancePass = Effect.fn('CommerceEnrollmentContinuation.pass')(function* advancePassEffect(
  seams: ContinuationSeams,
  input: ReadEnrollmentAttemptInput,
): Effect.fn.Return<PassResult, CommerceEnrollmentAttemptError> {
  const store = seams.store(input);
  const attempt = yield* store.read(input);
  if (isEnrollmentAttemptTerminal(attempt.state)) {
    return { attemptState: attempt.state, kind: 'SETTLED' };
  }
  const definition = yield* enrollmentJourneyDefinitionForAttempt(attempt);
  const { operations, subject } = yield* Effect.all(
    {
      operations: readJournal(store, attempt, journeyTransitions(definition)),
      subject: seams.resolveSubject({
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        tenantId: attempt.tenantId,
      }),
    },
    { concurrency: 2 },
  );
  const proven = new Set(
    operations.flatMap((operation) => (operation.status === 'SUCCEEDED' ? [journeyTransitionIdentity(operation)] : [])),
  );
  const next = definition.requiredTransitions.find((transition) => !proven.has(journeyTransitionIdentity(transition)));
  if (next === undefined) {
    return { attemptState: attempt.state, kind: 'SETTLED' };
  }
  const owner = yield* seams.registry.resolve(next, {
    attempt,
    operations,
    requestCorrelation: `${CONTINUATION_WORKER_PREFIX}:${attempt.portalEnrollmentAttemptId}`,
    subject,
  });
  if (Option.isNone(owner)) {
    return halted('NO_OWNER_EFFECT', next);
  }
  const operation = Option.fromNullishOr(
    operations.find(
      (candidate) => candidate.ownerModuleKey === next.ownerModuleKey && candidate.transitionKey === next.transitionKey,
    ),
  );
  return yield* runTransition({ attempt, operation, owner: owner.value, store, transition: next });
});

const settledResult = (attemptState: EnrollmentAttemptState): CommerceEnrollmentContinuationResult =>
  attemptState === 'COMPLETE'
    ? { outcome: 'COMPLETE' }
    : {
        halt: {
          reason: attemptState === 'TERMINATED' ? 'ATTEMPT_TERMINAL' : 'VERIFICATION_REQUIRED',
          transition: Option.none(),
        },
        outcome: 'HALTED',
      };

/**
 * A journey declares a finite transition list and every pass either proves one more transition or
 * stops, so the loop is bounded by that list. The bound is enforced rather than trusted.
 */
const advanceLoop = (
  seams: ContinuationSeams,
  input: ReadEnrollmentAttemptInput,
  remaining: number,
): Effect.Effect<CommerceEnrollmentContinuationResult, CommerceEnrollmentAttemptError> =>
  advancePass(seams, input).pipe(
    Effect.flatMap((pass) => {
      if (pass.kind === 'HALTED') {
        return Effect.succeed<CommerceEnrollmentContinuationResult>({ halt: pass.halt, outcome: 'HALTED' });
      }
      if (pass.kind === 'SETTLED') {
        return Effect.succeed(settledResult(pass.attemptState));
      }
      return remaining <= 1 ? Effect.succeed(settledResult('IN_PROGRESS')) : advanceLoop(seams, input, remaining - 1);
    }),
  );

export const CommerceEnrollmentContinuationLive = Layer.effect(
  CommerceEnrollmentContinuation,
  Effect.gen(function* makeCommerceEnrollmentContinuation() {
    const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
    const registry = yield* CommerceEnrollmentOwnerEffectRegistry;
    const resolver = yield* CommerceEnrollmentPreparationSubjectResolver;
    const permits = yield* Semaphore.make(CONTINUATION_CONCURRENCY);
    const seams: ContinuationSeams = {
      registry,
      resolveSubject: resolver.resolve,
      store: (attempt) => commerceEnrollmentOwnerAttemptStoreForRun({ tenantId: attempt.tenantId }, runner.run),
    };
    return {
      advance: (input) => permits.withPermit(advanceLoop(seams, input, CONTINUATION_PASS_BUDGET)),
      // Reading the journal dispatches nothing, so it takes no permit: the permits exist to keep
      // enrollment bursts from flooding the owners, and a listing reaches no owner at all.
      listStale: (input) =>
        commerceEnrollmentStaleAttemptStoreForRun({ tenantId: input.tenantId }, runner.run).listStale(input),
    };
  }),
);

/**
 * A deployment without the enrollment realm cannot advance a journey, and refusing is the only safe
 * answer: the Attempt stays exactly where the start route left it.
 */
export const commerceEnrollmentContinuationUnavailableLive = Layer.succeed(CommerceEnrollmentContinuation, {
  advance: (input) =>
    Effect.fail(
      attemptRejected(
        'The Commerce enrollment continuation is not installed in this deployment',
        input.portalEnrollmentAttemptId,
      ),
    ),
  // Empty rather than refused: a deployment without the enrollment realm has no journey to be owed
  // a transition, so the sweeper that reads this has nothing due, not an error to report each tick.
  listStale: () => Effect.succeed([]),
});
