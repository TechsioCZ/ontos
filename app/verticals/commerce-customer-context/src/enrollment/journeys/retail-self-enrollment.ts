import type { PartyRef } from '@app/party-registry/resources/party';
import { Context, Effect, Option, Schema } from 'effect';

import type { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import type {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentKeySchema,
  EnrollmentOwnerOperationSnapshot,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import { CommerceEnrollmentAttemptRejected } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerTransition,
  CommerceEnrollmentOwnerTransitionDriver,
} from '../orchestration/owner-transition-driver.ts';
import type { JourneyTransitionSpec } from './journey-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  isRetailSelfEnrollmentReconciliationOutcome,
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
  retailSelfEnrollmentStepPlan,
} from './retail-self-enrollment-contracts.ts';
import type { RetailSelfEnrollmentStepIntent } from './retail-self-enrollment-contracts.ts';

/**
 * Retail self-enrollment execution.
 *
 * Every step is dispatched through the generic owner-transition driver, so each one has its own
 * durable claim, its own stable transition key and its own request digest.  A partial journey is
 * never presented as a complete one; an owner timeout after a commit is INDETERMINATE and is
 * resolved by the driver's own reconcile phase (an exact owner read of the original invocation),
 * never by a second blind dispatch.
 */

type EnrollmentKey = typeof EnrollmentKeySchema.Type;
type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

/**
 * Everything the journey needs from application composition: one driver and one immutable owner
 * invocation per declared transition, plus the durable Attempt read used to refresh a revision
 * before a reconciliation phase.
 */
export interface RetailSelfEnrollmentOwnerSet {
  readonly driverFor: (step: JourneyTransitionSpec) => Option.Option<CommerceEnrollmentOwnerTransitionDriver>;
  /** Stable across equivalent retries: the driver replays instead of repeating the owner effect. */
  readonly ownerInvocationIdFor: (
    step: JourneyTransitionSpec,
  ) => Option.Option<typeof EnrollmentActionInvocationIdSchema.Type>;
  readonly readAttempt: CommerceEnrollmentOwnerAttemptStore['read'];
}

/** The owner drivers and Attempt read this journey dispatches through. */
export class RetailSelfEnrollmentOwners extends Context.Service<
  RetailSelfEnrollmentOwners,
  RetailSelfEnrollmentOwnerSet
>()('@app/commerce-customer-context/enrollment/journeys/retail-self-enrollment/RetailSelfEnrollmentOwners') {}

export interface RetailSelfEnrollmentPlanInput {
  readonly actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type;
  readonly expectedRevision: number;
  /** Digest of the Party candidate submitted to Party Registry; the candidate stays with its owner. */
  readonly partyCandidateDigest: string;
  readonly portalEnrollmentAttemptId: typeof EnrollmentAttemptIdSchema.Type;
  /**
   * The Tenant-scoped Principal established by the portal account-creation transition.  It is a
   * trusted input: the journey never derives a Principal from an email or a provider subject.
   */
  readonly principalRef: typeof RetailPortalPrincipalRefSchema.Type;
  readonly requestCorrelation: string;
  readonly sellingLegalEntityRef: typeof SellingLegalEntityRefSchema.Type;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}

export interface RetailSelfEnrollmentStepOutcome {
  readonly outcome: 'RECORDED' | 'RECONCILED' | 'REPLAYED';
  readonly outcomeCode: EnrollmentKey | undefined;
  readonly ownerModuleKey: string;
  readonly resultReference: EnrollmentResourceId | undefined;
  /** Attempt revision observed after this owner outcome was durably recorded. */
  readonly revision: number;
  readonly transitionKey: string;
}

export interface RetailSelfEnrollmentHalt {
  readonly outcomeCode: Option.Option<EnrollmentKey>;
  readonly ownerModuleKey: string;
  /**
   * `IN_FLIGHT` means another worker holds the lease; `RECONCILIATION_REQUIRED` is a typed
   * non-terminal halt (ambiguous Party, incomplete grant staging); `OWNER_REJECTED` is a recorded
   * owner refusal.  None of the three is a completed journey.
   */
  readonly reason: 'IN_FLIGHT' | 'OWNER_REJECTED' | 'RECONCILIATION_REQUIRED';
  readonly transitionKey: string;
}

export type RetailSelfEnrollmentResult =
  | {
      readonly outcome: 'COMPLETED';
      readonly partyRef: PartyRef;
      readonly revision: number;
      readonly steps: readonly RetailSelfEnrollmentStepOutcome[];
    }
  | {
      readonly halt: RetailSelfEnrollmentHalt;
      readonly outcome: 'HALTED';
      readonly revision: number;
      readonly steps: readonly RetailSelfEnrollmentStepOutcome[];
    };

interface JourneyState {
  readonly halt: Option.Option<RetailSelfEnrollmentHalt>;
  readonly partyRef: Option.Option<PartyRef>;
  readonly revision: number;
  readonly steps: readonly RetailSelfEnrollmentStepOutcome[];
}

type StepResult =
  | { readonly kind: 'ADVANCED'; readonly outcome: RetailSelfEnrollmentStepOutcome }
  | { readonly halt: RetailSelfEnrollmentHalt; readonly kind: 'HALTED'; readonly revision: number };

const rejected = (
  input: RetailSelfEnrollmentPlanInput,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentAttemptRejected> => {
  const error = new CommerceEnrollmentAttemptRejected({
    attemptId: input.portalEnrollmentAttemptId,
    code: 'attempt_invalid',
    reason: reason.slice(0, 500),
    retryable: false,
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause });
};

const haltFor = (
  step: JourneyTransitionSpec,
  reason: RetailSelfEnrollmentHalt['reason'],
  outcomeCode: Option.Option<EnrollmentKey>,
): RetailSelfEnrollmentHalt => ({
  outcomeCode,
  ownerModuleKey: step.ownerModuleKey,
  reason,
  transitionKey: step.transitionKey,
});

/** A recorded owner failure is a reconciliation halt when the owner says the decision is pending. */
const recordedFailureHalt = (
  step: JourneyTransitionSpec,
  outcomeCode: EnrollmentKey | undefined,
): RetailSelfEnrollmentHalt =>
  haltFor(
    step,
    isRetailSelfEnrollmentReconciliationOutcome(outcomeCode) ? 'RECONCILIATION_REQUIRED' : 'OWNER_REJECTED',
    Option.fromNullishOr(outcomeCode),
  );

const advanced = (
  step: JourneyTransitionSpec,
  outcome: RetailSelfEnrollmentStepOutcome['outcome'],
  revision: number,
  outcomeCode: EnrollmentKey | undefined,
  resultReference: EnrollmentResourceId | undefined,
): StepResult => ({
  kind: 'ADVANCED',
  outcome: {
    outcome,
    outcomeCode,
    ownerModuleKey: step.ownerModuleKey,
    resultReference,
    revision,
    transitionKey: step.transitionKey,
  },
});

const fromOperationSnapshot = (
  step: JourneyTransitionSpec,
  operation: EnrollmentOwnerOperationSnapshot,
  revision: number,
): StepResult =>
  operation.status === 'SUCCEEDED'
    ? advanced(step, 'REPLAYED', revision, operation.outcomeCode, operation.resultReference)
    : { halt: recordedFailureHalt(step, operation.outcomeCode), kind: 'HALTED', revision };

const intentFor = (
  input: RetailSelfEnrollmentPlanInput,
  step: JourneyTransitionSpec,
  partyRef: Option.Option<PartyRef>,
): Effect.Effect<RetailSelfEnrollmentStepIntent, CommerceEnrollmentAttemptError> => {
  if (step.transitionKey === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY) {
    return Effect.succeed({
      partyCandidateDigest: input.partyCandidateDigest,
      sellingLegalEntityRef: input.sellingLegalEntityRef,
      step: 'PARTY_CANDIDATE' as const,
    });
  }
  if (step.transitionKey === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY) {
    return Option.isNone(partyRef)
      ? Effect.fail(rejected(input, 'The Retail Customer Profile transition requires an exact resolved Party'))
      : Effect.succeed({
          partyRef: partyRef.value,
          sellingLegalEntityRef: input.sellingLegalEntityRef,
          step: 'RETAIL_CUSTOMER_PROFILE' as const,
        });
  }
  if (step.transitionKey === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY) {
    return Option.isNone(partyRef)
      ? Effect.fail(rejected(input, 'The Retail Portal Profile Binding transition requires an exact resolved Party'))
      : Effect.succeed({
          partyRef: partyRef.value,
          principalRef: input.principalRef,
          sellingLegalEntityRef: input.sellingLegalEntityRef,
          step: 'RETAIL_PORTAL_BINDING' as const,
        });
  }
  return Effect.succeed({ sellingLegalEntityRef: input.sellingLegalEntityRef, step: 'PORTAL_ACCOUNT' as const });
};

interface OwnerTransitionRequest {
  readonly expectedRevision: number;
  readonly input: RetailSelfEnrollmentPlanInput;
  readonly intent: RetailSelfEnrollmentStepIntent;
  readonly ownerInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly step: JourneyTransitionSpec;
}

const ownerTransitionFor = (
  request: OwnerTransitionRequest,
): Effect.Effect<CommerceEnrollmentOwnerTransition, CommerceEnrollmentAttemptError> => {
  const { expectedRevision, input, intent, ownerInvocationId, step } = request;
  return Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: input.actorPrincipalId,
    correlationId: input.requestCorrelation,
    expectedRevision,
    ownerInvocationId,
    ownerModuleKey: step.ownerModuleKey,
    portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
    requestDigest: retailSelfEnrollmentRequestDigest({
      intent,
      ownerModuleKey: step.ownerModuleKey,
      portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
      transitionKey: step.transitionKey,
    }),
    tenantId: input.tenantId,
    transitionKey: step.transitionKey,
  }).pipe(
    Effect.mapError((cause) => rejected(input, 'The Retail self-enrollment transition identity is invalid', cause)),
  );
};

/**
 * Run one declared step.  An INDETERMINATE result is never treated as a failure and never leads to
 * a second dispatch: the Attempt revision is refreshed and the driver's reconcile phase performs
 * the exact owner read for the original invocation.
 */
const runStep = Effect.fn('RetailSelfEnrollment.runStep')(function* runRetailStep(
  input: RetailSelfEnrollmentPlanInput,
  step: JourneyTransitionSpec,
  intent: RetailSelfEnrollmentStepIntent,
  expectedRevision: number,
): Effect.fn.Return<StepResult, CommerceEnrollmentAttemptError, RetailSelfEnrollmentOwners> {
  const owners = yield* RetailSelfEnrollmentOwners;
  const installed = owners.driverFor(step);
  const invocation = owners.ownerInvocationIdFor(step);
  if (Option.isNone(installed) || Option.isNone(invocation)) {
    return yield* rejected(input, 'No owner driver is installed for a declared Retail self-enrollment transition');
  }
  const driver = installed.value;
  const transition = yield* ownerTransitionFor({
    expectedRevision,
    input,
    intent,
    ownerInvocationId: invocation.value,
    step,
  });
  const dispatched = yield* driver.execute(transition).pipe(
    Effect.map((value) => ({ kind: 'EXECUTED' as const, value })),
    Effect.catchTag('CommerceEnrollmentAttemptIndeterminate', () => Effect.succeed({ kind: 'INDETERMINATE' as const })),
  );

  if (dispatched.kind === 'INDETERMINATE') {
    const attempt = yield* owners.readAttempt({
      portalEnrollmentAttemptId: input.portalEnrollmentAttemptId,
      tenantId: input.tenantId,
    });
    const reconciled = yield* driver.reconcile({ ...transition, expectedRevision: attempt.revision });
    if (reconciled.outcome !== 'RECORDED') {
      return fromOperationSnapshot(step, reconciled.operation, reconciled.attempt.revision);
    }
    const { recorded, resolution } = reconciled;
    return resolution.status === 'SUCCEEDED'
      ? advanced(step, 'RECONCILED', recorded.attempt.revision, resolution.outcomeCode, resolution.resultReference)
      : {
          halt: recordedFailureHalt(step, resolution.outcomeCode),
          kind: 'HALTED',
          revision: recorded.attempt.revision,
        };
  }

  const execution = dispatched.value;
  if (execution.outcome === 'LEASE_HELD') {
    return {
      halt: haltFor(step, 'IN_FLIGHT', Option.none()),
      kind: 'HALTED',
      revision: execution.claim.attempt.revision,
    };
  }
  if (execution.outcome === 'REPLAYED') {
    return fromOperationSnapshot(step, execution.claim.operation, execution.claim.attempt.revision);
  }
  const { ownerOutcome, recorded } = execution;
  return ownerOutcome.status === 'SUCCEEDED'
    ? advanced(step, 'RECORDED', recorded.attempt.revision, ownerOutcome.outcomeCode, ownerOutcome.resultReference)
    : {
        halt: recordedFailureHalt(step, ownerOutcome.outcomeCode),
        kind: 'HALTED',
        revision: recorded.attempt.revision,
      };
});

const partyRefFromStep = (
  input: RetailSelfEnrollmentPlanInput,
  outcome: RetailSelfEnrollmentStepOutcome,
): Effect.Effect<PartyRef, CommerceEnrollmentAttemptError> => {
  const { resultReference } = outcome;
  return resultReference === undefined
    ? Effect.fail(rejected(input, 'The Party Registry transition recorded no exact Party reference'))
    : Effect.succeed(retailPartyRefFor(input.tenantId, resultReference));
};

const advanceState = Effect.fn('RetailSelfEnrollment.advanceState')(function* advanceJourneyState(
  input: RetailSelfEnrollmentPlanInput,
  state: JourneyState,
  step: JourneyTransitionSpec,
): Effect.fn.Return<JourneyState, CommerceEnrollmentAttemptError, RetailSelfEnrollmentOwners> {
  const intent = yield* intentFor(input, step, state.partyRef);
  const result = yield* runStep(input, step, intent, state.revision);
  if (result.kind === 'HALTED') {
    return { halt: Option.some(result.halt), partyRef: state.partyRef, revision: result.revision, steps: state.steps };
  }
  const partyRef =
    step.transitionKey === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY
      ? Option.some(yield* partyRefFromStep(input, result.outcome))
      : state.partyRef;
  return {
    halt: Option.none(),
    partyRef,
    revision: result.outcome.revision,
    steps: [...state.steps, result.outcome],
  };
});

/**
 * Compose Retail self-enrollment: portal account creation, Party Registry candidate submission,
 * Retail Customer Profile ensure, and the Retail Portal Profile Binding that durably stages the
 * reviewed #332 Retail Portal Self-Service Permission intents.
 *
 * A halt returns the steps that did commit and stops the plan there.  A stale Attempt revision
 * authorizes nothing: the first durable claim rejects it and no later transition is dispatched.
 */
export const runRetailSelfEnrollment = Effect.fn('RetailSelfEnrollment.run')(function* runRetailSelfEnrollmentEffect(
  input: RetailSelfEnrollmentPlanInput,
): Effect.fn.Return<RetailSelfEnrollmentResult, CommerceEnrollmentAttemptError, RetailSelfEnrollmentOwners> {
  const initial: JourneyState = {
    halt: Option.none(),
    partyRef: Option.none(),
    revision: input.expectedRevision,
    steps: [],
  };
  const final = yield* Effect.reduce(
    retailSelfEnrollmentStepPlan(),
    () => initial,
    (state, step) => (Option.isNone(state.halt) ? advanceState(input, state, step) : Effect.succeed(state)),
  );

  const { halt, partyRef } = final;
  if (Option.isSome(halt)) {
    return { halt: halt.value, outcome: 'HALTED', revision: final.revision, steps: final.steps };
  }
  if (Option.isNone(partyRef)) {
    return yield* rejected(input, 'Retail self-enrollment completed without an exact Retail Party');
  }
  return { outcome: 'COMPLETED', partyRef: partyRef.value, revision: final.revision, steps: final.steps };
});
