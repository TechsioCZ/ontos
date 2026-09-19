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
import type {
  CommerceEnrollmentOwnerEffectContext,
  CommerceEnrollmentRegisteredOwnerEffect,
} from '../orchestration/owner-effect-registry.ts';
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
} from '../orchestration/owner-transition-production.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from '../orchestration/preparation-subject.ts';
import type { CommerceEnrollmentPreparationSubjectResolve } from '../orchestration/preparation-subject.ts';

/**
 * The server-side enrollment continuation.
 *
 * `POST /enrollment/start` commits one Attempt and the one provider account that Attempt's claim
 * authorizes; every further transition the journey requires is dispatched here, after that request
 * has committed and outside every governed Action transaction.
 *
 * The continuation owns no business rule of its own.  It reads the durable Attempt, asks the
 * journey definition which required transition the owner journal has not proven, asks the
 * owner-effect registry who owns it, and hands the whole thing to the generic owner-transition
 * driver — whose durable claim remains the only authority that can record an owner outcome.
 *
 * It is safe to run twice and safe to run after a crash.  Every owner invocation identity it uses
 * is derived from the Attempt, so a re-run presents the very same claim and the journal replays the
 * transition instead of repeating the external effect.  An owner whose answer was lost is settled
 * exactly once through the driver's own reconcile phase — an authoritative read of the original
 * invocation, never a second dispatch.
 */

const CONTINUATION_WORKER_PREFIX = 'commerce.customer-context.enrollment-continuation';
const CONTINUATION_INVOCATION_PURPOSE = 'commerce.portal-enrollment.continuation.owner-invocation';
const LEASE_DURATION_MS = 30_000;
/** Enrollment bursts queue here rather than flooding the owners a journey dispatches into. */
const CONTINUATION_CONCURRENCY = 8;
/** The longest journey's transition count, plus one pass to settle a reconciliation. */
const CONTINUATION_PASS_BUDGET = 8;

interface CommerceEnrollmentContinuationStep {
  readonly outcome: 'RECONCILED' | 'RECORDED' | 'REPLAYED';
  readonly ownerModuleKey: string;
  /** The Attempt revision observed after this owner outcome was durably recorded. */
  readonly revision: number;
  readonly transitionKey: string;
}

interface CommerceEnrollmentContinuationHalt {
  /**
   * `ATTEMPT_TERMINAL`: the Attempt was terminated, so no owner effect remains to run.
   * `IN_FLIGHT`: another worker holds the transition's lease.  `NO_OWNER_EFFECT`: this deployment
   * registers no owner effect that may dispatch the transition, so the Attempt is left exactly as
   * it was.  `OWNER_REJECTED`: a durable owner refusal.  `RECONCILIATION_REQUIRED`: an owner
   * decision is pending — an ambiguous Party, an incomplete grant staging, or an owner answer that
   * never arrived.  `VERIFICATION_REQUIRED`: every required transition is proven but the Attempt's
   * own derived state still asks for verification.  None of the six is a completed journey.
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
  | {
      readonly outcome: 'COMPLETE';
      readonly revision: number;
      readonly steps: readonly CommerceEnrollmentContinuationStep[];
    }
  | {
      readonly halt: CommerceEnrollmentContinuationHalt;
      readonly outcome: 'HALTED';
      readonly revision: number;
      readonly steps: readonly CommerceEnrollmentContinuationStep[];
    };

export interface CommerceEnrollmentContinuationService {
  /**
   * Advance one Attempt as far as its journey and its durable journal allow.  Failure is always a
   * typed Attempt failure; a halt is an ordinary success that simply is not a completion.
   */
  readonly advance: (
    input: ReadEnrollmentAttemptInput,
  ) => Effect.Effect<CommerceEnrollmentContinuationResult, CommerceEnrollmentAttemptError>;
}

export class CommerceEnrollmentContinuation extends Context.Service<
  CommerceEnrollmentContinuation,
  CommerceEnrollmentContinuationService
>()('@app/commerce-customer-context/enrollment/continuation/enrollment-continuation/CommerceEnrollmentContinuation') {}

type OwnerDispatch = CommerceEnrollmentOwnerEffect['dispatch'];

interface ContinuationState {
  readonly attemptState: EnrollmentAttemptState;
  readonly halt: Option.Option<CommerceEnrollmentContinuationHalt>;
  readonly progressed: boolean;
  readonly revision: number;
  readonly steps: readonly CommerceEnrollmentContinuationStep[];
}

const haltFor = (
  reason: CommerceEnrollmentContinuationHalt['reason'],
  transition: JourneyTransitionSpec,
): CommerceEnrollmentContinuationHalt => ({ reason, transition: Option.some(transition) });

const attemptHalt = (reason: CommerceEnrollmentContinuationHalt['reason']): CommerceEnrollmentContinuationHalt => ({
  reason,
  transition: Option.none(),
});

/**
 * A durable owner failure is a reconciliation halt when the owner said its decision is pending
 * rather than refused.  Owners speak that through the shared reconciliation failure code — an
 * ambiguous Party, an incompletely staged grant baseline — so the reading is journey-neutral and
 * never depends on a journey's own outcome vocabulary.
 */
const failureHalt = (
  transition: JourneyTransitionSpec,
  failure: {
    readonly failureCode?: string;
    readonly nextState?: 'IN_PROGRESS' | 'RECONCILIATION_REQUIRED' | 'VERIFICATION_REQUIRED';
  },
): CommerceEnrollmentContinuationHalt =>
  haltFor(
    failure.nextState === 'RECONCILIATION_REQUIRED' ||
      failure.failureCode === OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE
      ? 'RECONCILIATION_REQUIRED'
      : 'OWNER_REJECTED',
    transition,
  );

/** Whether an owner operation's lease still grants its holder exclusive ownership. */
const leaseIsActive = (lease: EnrollmentOwnerOperationSnapshot['lease']): Effect.Effect<boolean> =>
  lease === undefined
    ? Effect.succeed(false)
    : DateTime.now.pipe(Effect.map((now) => DateTime.isLessThan(now, lease.leaseExpiresAt)));

const stepFor = (
  transition: JourneyTransitionSpec,
  outcome: CommerceEnrollmentContinuationStep['outcome'],
  revision: number,
): CommerceEnrollmentContinuationStep => ({
  outcome,
  ownerModuleKey: transition.ownerModuleKey,
  revision,
  transitionKey: transition.transitionKey,
});

/**
 * The owner invocation identity for one transition of one Attempt.  It is derived, never minted:
 * a re-run after a crash presents the identical claim, so the durable journal replays the owner
 * operation rather than authorizing a second external effect.
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

type StepResult =
  | { readonly kind: 'ADVANCED'; readonly step: CommerceEnrollmentContinuationStep }
  | { readonly halt: CommerceEnrollmentContinuationHalt; readonly kind: 'HALTED'; readonly revision: number };

/**
 * A reconciliation phase never dispatches, so the reconcile-only driver is handed a dispatch that
 * cannot be reached rather than a second live effect.
 */
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
 * Settle one already dispatched transition whose answer never arrived.  This is the only path that
 * may resolve an INDETERMINATE owner operation, and the identity it reconciles under is read back
 * from the immutable journal entry — never re-derived — so a transition first dispatched by the
 * start route is reconciled as that route's invocation, not as the continuation's.
 */
const reconcileStep = Effect.fn('CommerceEnrollmentContinuation.reconcile')(function* reconcileStepEffect(
  input: StepInput,
  operation: EnrollmentOwnerOperationSnapshot,
): Effect.fn.Return<StepResult, CommerceEnrollmentAttemptError> {
  const transition = yield* transitionFor(
    input.attempt,
    input.transition,
    operation.ownerInvocationId,
    operation.requestDigest,
  );
  const reconciled = yield* driverFor(input, unreachableDispatch).reconcile(transition);
  if (reconciled.outcome !== 'RECORDED') {
    return reconciled.operation.status === 'SUCCEEDED'
      ? { kind: 'ADVANCED', step: stepFor(input.transition, 'REPLAYED', reconciled.attempt.revision) }
      : {
          halt: failureHalt(input.transition, reconciled.operation),
          kind: 'HALTED',
          revision: reconciled.attempt.revision,
        };
  }
  const { recorded, resolution } = reconciled;
  return resolution.status === 'SUCCEEDED'
    ? { kind: 'ADVANCED', step: stepFor(input.transition, 'RECONCILED', recorded.attempt.revision) }
    : {
        halt: failureHalt(input.transition, resolution),
        kind: 'HALTED',
        revision: recorded.attempt.revision,
      };
});

/** Claim, dispatch outside every transaction, record.  The driver owns all three phases. */
const dispatchStep = Effect.fn('CommerceEnrollmentContinuation.dispatch')(function* dispatchStepEffect(
  input: StepInput,
  dispatch: OwnerDispatch,
  requestDigest: string,
): Effect.fn.Return<StepResult, CommerceEnrollmentAttemptError> {
  const ownerInvocationId = yield* ownerInvocationIdFor(input.attempt, input.transition);
  const transition = yield* transitionFor(input.attempt, input.transition, ownerInvocationId, requestDigest);
  const executed = yield* driverFor(input, dispatch)
    .execute(transition)
    .pipe(
      Effect.map((value) => ({ kind: 'EXECUTED' as const, value })),
      Effect.catchTag('CommerceEnrollmentAttemptIndeterminate', () => Effect.succeed({ kind: 'PENDING' as const })),
    );
  if (executed.kind === 'PENDING') {
    // The owner's answer is unknown. Nothing is recorded and nothing is dispatched a second time:
    // the next `advance` observes an INDETERMINATE operation and settles it by reading the owner.
    return {
      halt: haltFor('RECONCILIATION_REQUIRED', input.transition),
      kind: 'HALTED',
      revision: input.attempt.revision,
    };
  }
  const execution = executed.value;
  if (execution.outcome === 'LEASE_HELD') {
    return {
      halt: haltFor('IN_FLIGHT', input.transition),
      kind: 'HALTED',
      revision: execution.claim.attempt.revision,
    };
  }
  if (execution.outcome === 'REPLAYED') {
    return { kind: 'ADVANCED', step: stepFor(input.transition, 'REPLAYED', execution.claim.attempt.revision) };
  }
  const { ownerOutcome, recorded } = execution;
  return ownerOutcome.status === 'SUCCEEDED'
    ? { kind: 'ADVANCED', step: stepFor(input.transition, 'RECORDED', recorded.attempt.revision) }
    : {
        halt: failureHalt(input.transition, ownerOutcome),
        kind: 'HALTED',
        revision: recorded.attempt.revision,
      };
});

/** The verdict for one declared transition, decided from the durable journal before anything runs. */
const runTransition = Effect.fn('CommerceEnrollmentContinuation.runTransition')(function* runTransitionEffect(
  input: StepInput,
): Effect.fn.Return<StepResult, CommerceEnrollmentAttemptError> {
  const { operation } = input;
  if (Option.isSome(operation)) {
    const { status } = operation.value;
    if (status === 'INDETERMINATE' || status === 'RECONCILIATION_REQUIRED') {
      return yield* reconcileStep(input, operation.value);
    }
    if (status === 'FAILED') {
      return {
        halt: failureHalt(input.transition, operation.value),
        kind: 'HALTED',
        revision: input.attempt.revision,
      };
    }
    if (status === 'IN_PROGRESS') {
      // A dispatch is either still running under a live lease, or its worker disappeared. Only the
      // lease holder may finish it; once the lease lapses the transition is settled by reading the
      // owner — the driver's reconcile phase fences the stale row first — never by dispatching a
      // second time.
      return (yield* leaseIsActive(operation.value.lease))
        ? { halt: haltFor('IN_FLIGHT', input.transition), kind: 'HALTED', revision: input.attempt.revision }
        : yield* reconcileStep(input, operation.value);
    }
  }
  const { dispatch } = input.owner;
  if (Option.isNone(dispatch)) {
    // Either the transition's dispatch belongs to another caller, or an owner operation is still
    // leased and only its owner may finish it. Either way the Attempt is left exactly as it was:
    // no claim, no lease, no revision change.
    return {
      halt: haltFor(Option.isSome(operation) ? 'IN_FLIGHT' : 'NO_OWNER_EFFECT', input.transition),
      kind: 'HALTED',
      revision: input.attempt.revision,
    };
  }
  return yield* dispatchStep(input, dispatch.value.effect, dispatch.value.requestDigest);
});

const ownerContextFor = Effect.fn('CommerceEnrollmentContinuation.context')(function* ownerContextForEffect(
  seams: ContinuationSeams,
  store: CommerceEnrollmentOwnerAttemptStore,
  attempt: EnrollmentAttemptSnapshot,
  transitions: readonly JourneyTransitionSpec[],
): Effect.fn.Return<CommerceEnrollmentOwnerEffectContext, CommerceEnrollmentAttemptError> {
  const { operations, subject } = yield* Effect.all(
    {
      operations: readJournal(store, attempt, transitions),
      subject: seams.resolveSubject({
        portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
        tenantId: attempt.tenantId,
      }),
    },
    { concurrency: 2 },
  );
  return {
    attempt,
    operations,
    requestCorrelation: `${CONTINUATION_WORKER_PREFIX}:${attempt.portalEnrollmentAttemptId}`,
    subject,
  };
});

const settled = (state: ContinuationState, attempt: EnrollmentAttemptSnapshot): ContinuationState => ({
  attemptState: attempt.state,
  halt: Option.none(),
  progressed: false,
  revision: attempt.revision,
  steps: state.steps,
});

/**
 * One pass over the journey: re-read the Attempt, find the first required transition the journal
 * has not proven, and run exactly that one.  `advance` loops the pass, so every step sees a fresh
 * Attempt revision and a freshly resolved subject — the Party the previous step created, the
 * profile the one before it ensured.
 */
const advancePass = Effect.fn('CommerceEnrollmentContinuation.pass')(function* advancePassEffect(
  seams: ContinuationSeams,
  input: ReadEnrollmentAttemptInput,
  state: ContinuationState,
): Effect.fn.Return<ContinuationState, CommerceEnrollmentAttemptError> {
  const store = seams.store(input);
  const attempt = yield* store.read(input);
  if (isEnrollmentAttemptTerminal(attempt.state)) {
    return settled(state, attempt);
  }
  const definition = yield* enrollmentJourneyDefinitionForAttempt(attempt);
  const context = yield* ownerContextFor(seams, store, attempt, journeyTransitions(definition));
  const proven = new Set(
    context.operations.flatMap((operation) =>
      operation.status === 'SUCCEEDED' ? [journeyTransitionIdentity(operation)] : [],
    ),
  );
  const next = definition.requiredTransitions.find((transition) => !proven.has(journeyTransitionIdentity(transition)));
  if (next === undefined) {
    return settled(state, attempt);
  }
  const owner = yield* seams.registry.resolve(next, context);
  if (Option.isNone(owner)) {
    return {
      attemptState: attempt.state,
      halt: Option.some(haltFor('NO_OWNER_EFFECT', next)),
      progressed: false,
      revision: attempt.revision,
      steps: state.steps,
    };
  }
  const operation = Option.fromNullishOr(
    context.operations.find(
      (candidate) => candidate.ownerModuleKey === next.ownerModuleKey && candidate.transitionKey === next.transitionKey,
    ),
  );
  const result = yield* runTransition({ attempt, operation, owner: owner.value, store, transition: next });
  return result.kind === 'HALTED'
    ? {
        attemptState: attempt.state,
        halt: Option.some(result.halt),
        progressed: false,
        revision: result.revision,
        steps: state.steps,
      }
    : {
        attemptState: attempt.state,
        halt: Option.none(),
        progressed: true,
        revision: result.step.revision,
        steps: [...state.steps, result.step],
      };
});

/**
 * A journey declares a finite transition list, and every pass either proves one more transition or
 * stops, so the loop is bounded by that list.  The bound is enforced rather than trusted: a pass
 * that neither advanced nor halted would otherwise spin.
 */
const finish = (state: ContinuationState): CommerceEnrollmentContinuationResult => {
  const { halt, revision, steps } = state;
  if (Option.isSome(halt)) {
    return { halt: halt.value, outcome: 'HALTED', revision, steps };
  }
  if (state.attemptState === 'COMPLETE') {
    return { outcome: 'COMPLETE', revision, steps };
  }
  return {
    halt: attemptHalt(state.attemptState === 'TERMINATED' ? 'ATTEMPT_TERMINAL' : 'VERIFICATION_REQUIRED'),
    outcome: 'HALTED',
    revision,
    steps,
  };
};

const advanceLoop = (
  seams: ContinuationSeams,
  input: ReadEnrollmentAttemptInput,
  state: ContinuationState,
  remaining: number,
): Effect.Effect<CommerceEnrollmentContinuationResult, CommerceEnrollmentAttemptError> =>
  remaining <= 0
    ? Effect.succeed(finish(state))
    : advancePass(seams, input, state).pipe(
        Effect.flatMap((next) =>
          next.progressed ? advanceLoop(seams, input, next, remaining - 1) : Effect.succeed(finish(next)),
        ),
      );

const initialState: ContinuationState = {
  attemptState: 'IN_PROGRESS',
  halt: Option.none(),
  progressed: false,
  revision: 0,
  steps: [],
};

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
      advance: (input) => permits.withPermit(advanceLoop(seams, input, initialState, CONTINUATION_PASS_BUDGET)),
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
});
