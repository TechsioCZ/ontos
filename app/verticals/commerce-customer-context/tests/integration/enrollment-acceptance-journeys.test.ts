import { randomUUID } from 'node:crypto';

import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { StartEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';
import { journeyTransitionIdentity } from '../../src/enrollment/journeys/journey-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
  PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
  RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
  retailPartyCandidateDigest,
  retailSelfEnrollmentStepPlan,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  RetailSelfEnrollmentOwners,
  runRetailSelfEnrollment,
} from '../../src/enrollment/journeys/retail-self-enrollment.ts';
import type { RetailSelfEnrollmentPlanInput } from '../../src/enrollment/journeys/retail-self-enrollment.ts';
import { makeCommerceEnrollmentOwnerTransitionDriver } from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  expireEnrollmentAcceptanceLeases,
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import { makeEnrollmentAcceptanceScriptedOwner } from '../support/enrollment-acceptance-owner-script.ts';
import type {
  EnrollmentAcceptanceOwnerAnswer,
  EnrollmentAcceptanceOwnerResolution,
  EnrollmentAcceptanceScriptedOwner,
} from '../support/enrollment-acceptance-owner-script.ts';

/**
 * Retail self-enrollment journey acceptance, on real PostgreSQL: the production owner-transition
 * driver, owner store, Attempt service and SECURITY DEFINER routines all run for real, one
 * committed transaction per owner phase. Only the owner's answer on the far side of the dispatch
 * seam is scripted.
 */

const PARTY_RESOURCE_ID = 'retail-acceptance-party';
const PROFILE_RESOURCE_ID = 'retail-acceptance-profile';
const BINDING_RESOURCE_ID = 'retail-acceptance-binding';
const CORE_BINDING_RESOURCE_ID = 'retail-acceptance-core-binding';
const PORTAL_ACCOUNT_CREATED_OUTCOME_CODE = 'core_binding_activated';

const stepPlan = retailSelfEnrollmentStepPlan();
const principalId = (value: string) => Schema.decodeSync(EnrollmentPrincipalIdSchema)(value);
const tenant = (value: string) => Schema.decodeSync(EnrollmentTenantIdSchema)(value);
const invocation = (value: string) => Schema.decodeSync(EnrollmentActionInvocationIdSchema)(value);
const enrollmentKey = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const digest = (value: string) => Schema.decodeSync(EnrollmentDigestSchema)(value);

/**
 * One scenario's fixture identities. Owner invocation ids are minted once per scenario and reused
 * across every retry of that scenario: a retry that changes them would be a different intent, and
 * the durable journal would be right to treat it as a second owner effect.
 */
interface ScenarioIdentities {
  readonly actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type;
  readonly ownerInvocationIds: ReadonlyMap<string, typeof EnrollmentActionInvocationIdSchema.Type>;
  /** Everything of the plan that is known before the Attempt routine mints an Attempt id. */
  readonly planBase: Omit<RetailSelfEnrollmentPlanInput, 'expectedRevision' | 'portalEnrollmentAttemptId'>;
  readonly startInput: StartEnrollmentAttemptInput;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}

const makeScenarioIdentities = (): ScenarioIdentities => {
  const tenantId = tenant(randomUUID());
  const actorPrincipalId = principalId(randomUUID());
  const ownerInvocationIds = new Map(
    stepPlan.map((step) => [journeyTransitionIdentity(step), invocation(randomUUID())] as const),
  );
  const startInput: StartEnrollmentAttemptInput = {
    actionInvocationId: invocation(randomUUID()),
    actorPrincipalId,
    intentDigest: digest('a'.repeat(64)),
    intentKey: enrollmentKey('retail-acceptance-intent'),
    journey: 'RETAIL_SELF_ENROLLMENT',
    tenantId,
  };
  const planBase: ScenarioIdentities['planBase'] = {
    actorPrincipalId,
    partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'Jana Nova', 'jana@example.test']),
    principalRef: {
      moduleId: 'core.identity',
      resourceId: randomUUID(),
      resourceType: 'core.identity.principal',
      tenantId,
    },
    requestCorrelation: 'enrollment-acceptance-journeys',
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: randomUUID(),
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
    tenantId,
  };
  return { actorPrincipalId, ownerInvocationIds, planBase, startInput, tenantId };
};

const succeeded = (outcomeCode: string, resultReference: string): EnrollmentAcceptanceOwnerAnswer => ({
  kind: 'SUCCEEDED',
  outcomeCode,
  resultReference,
});

/** The four owner answers of a journey that runs clean end to end. */
const happyAnswers: Readonly<Record<string, EnrollmentAcceptanceOwnerAnswer>> = Object.freeze({
  [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY]: succeeded(RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE, BINDING_RESOURCE_ID),
  [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY]: succeeded(
    RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
    PROFILE_RESOURCE_ID,
  ),
  [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: succeeded(PARTY_CANDIDATE_CREATED_OUTCOME_CODE, PARTY_RESOURCE_ID),
  [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY]: succeeded(PORTAL_ACCOUNT_CREATED_OUTCOME_CODE, CORE_BINDING_RESOURCE_ID),
});

const withAnswer = (transitionKey: string, answer: EnrollmentAcceptanceOwnerAnswer) => ({
  ...happyAnswers,
  [transitionKey]: answer,
});

interface JourneyRun {
  readonly owner: EnrollmentAcceptanceScriptedOwner;
  readonly result: Effect.Effect<
    Effect.Success<ReturnType<typeof runRetailSelfEnrollment>>,
    Effect.Error<ReturnType<typeof runRetailSelfEnrollment>>
  >;
}

/**
 * Assemble one journey run against the durable fixture. The driver, the store and the Attempt
 * routines are production code; the owner answers are the scenario.
 */
const journeyRun = (
  fixture: EnrollmentAcceptanceFixture,
  identities: ScenarioIdentities,
  input: RetailSelfEnrollmentPlanInput,
  answers: Readonly<Record<string, EnrollmentAcceptanceOwnerAnswer>>,
  resolutions?: Readonly<Record<string, EnrollmentAcceptanceOwnerResolution>>,
): JourneyRun => {
  const owner = makeEnrollmentAcceptanceScriptedOwner(
    resolutions === undefined
      ? { actorPrincipalId: identities.actorPrincipalId, answers }
      : { actorPrincipalId: identities.actorPrincipalId, answers, resolutions },
  );
  const driverFor = (step: JourneyTransitionSpec) =>
    Option.some(
      makeCommerceEnrollmentOwnerTransitionDriver({
        attempt: fixture.ownerStore,
        leaseDurationMs: 30_000,
        owner: owner.effect,
        required: step.required,
      }),
    );
  const result = runRetailSelfEnrollment(input).pipe(
    Effect.provideService(RetailSelfEnrollmentOwners, {
      driverFor,
      ownerInvocationIdFor: (step) =>
        Option.fromNullishOr(identities.ownerInvocationIds.get(journeyTransitionIdentity(step))),
      readAttempt: fixture.ownerStore.read,
    }),
  );
  return { owner, result };
};

/**
 * Create the durable Attempt and return the plan input that names it. Nothing derives an Attempt
 * id: the routine mints it, exactly as the start-enrollment Action does.
 */
const startedPlanInput = Effect.fnUntraced(function* startedPlanInput(
  fixture: EnrollmentAcceptanceFixture,
  identities: ScenarioIdentities,
): Effect.fn.Return<RetailSelfEnrollmentPlanInput, Effect.Error<ReturnType<typeof startEnrollmentAcceptanceAttempt>>> {
  const attempt = yield* startEnrollmentAcceptanceAttempt(fixture, identities.startInput);
  return {
    ...identities.planBase,
    expectedRevision: attempt.revision,
    portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
  };
});

const scenario = Effect.fnUntraced(function* scenario(identities: ScenarioIdentities) {
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId: identities.tenantId });
  const input = yield* startedPlanInput(fixture, identities);
  return { fixture, input };
});

const operationSummary = (
  rows: readonly { readonly outcome_code: string | null; readonly status: string; readonly transition_key: string }[],
) => rows.map((row) => [row.transition_key, row.status, row.outcome_code] as const);

it.live('a lost response replays the same durable owner pair instead of preparing a second one', () =>
  Effect.scoped(
    Effect.gen(function* lostResponse() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const first = journeyRun(fixture, identities, input, happyAnswers);
      const firstResult = yield* first.result;
      expect(firstResult.outcome).toBe('COMPLETED');
      expect(first.owner.log.dispatched).toStrictEqual([
        PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
        PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
        ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
        BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
      ]);

      const settled = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);

      const replayedStart = yield* startEnrollmentAcceptanceAttempt(fixture, identities.startInput);
      expect(replayedStart.portalEnrollmentAttemptId).toBe(input.portalEnrollmentAttemptId);

      const attemptAfterFirst = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      const second = journeyRun(
        fixture,
        identities,
        { ...input, expectedRevision: attemptAfterFirst.revision },
        happyAnswers,
      );
      const refusal = yield* Effect.flip(second.result);
      expect(refusal.code).toBe('attempt_terminal');
      expect(refusal.retryable).toBe(false);
      expect(second.owner.log.dispatched).toStrictEqual([]);
      expect(second.owner.log.reconciled).toStrictEqual([]);

      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      expect(operations).toStrictEqual(settled);
      expect(operationSummary(operations)).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'SUCCEEDED', PARTY_CANDIDATE_CREATED_OUTCOME_CODE],
        [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE],
        [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE],
      ]);
    }),
  ),
);

it.live('a committed creation whose activation times out is INDETERMINATE, then reconciles once', () =>
  Effect.scoped(
    Effect.gen(function* indeterminateThenReconcile() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const timingOut = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
      );
      const stalled = yield* Effect.flip(timingOut.result);
      // A missing answer is never treated as a denial: halt is typed retryable, not terminal.
      expect(stalled.retryable).toBe(true);
      expect(stalled.code).not.toBe('attempt_terminal');
      expect(timingOut.owner.log.dispatched).toStrictEqual([
        PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
        PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
      ]);
      expect(
        timingOut.owner.log.dispatched.filter((key) => key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
      ).toHaveLength(1);
      const stalledAttempt = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      expect(stalledAttempt.state).not.toBe('COMPLETE');

      yield* expireEnrollmentAcceptanceLeases(fixture, input.portalEnrollmentAttemptId);
      const afterLapse = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      const recovery = journeyRun(
        fixture,
        identities,
        { ...input, expectedRevision: afterLapse.revision },
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
            outcomeCode: PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
            reconciliationRef: randomUUID(),
            resultReference: PARTY_RESOURCE_ID,
            status: 'SUCCEEDED',
          },
        },
      );
      const recovered = yield* recovery.result;

      expect(recovered.outcome).toBe('COMPLETED');
      expect(recovery.owner.log.dispatched).not.toContain(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(recovery.owner.log.reconciled).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
      expect(recovery.owner.log.dispatched).toStrictEqual([
        ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
        BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
      ]);

      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      expect(operations).toHaveLength(4);
      const party = operations.find((row) => row.transition_key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(party?.status).toBe('SUCCEEDED');
      expect(party?.result_reference).toBe(PARTY_RESOURCE_ID);
      expect(party?.reconciliation_ref).not.toBeNull();
    }),
  ),
);

it.live('2-of-3 committed transitions then a timeout: the retry converges without duplicating an effect', () =>
  Effect.scoped(
    Effect.gen(function* partialThenConverge() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const stalling = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
      );
      yield* Effect.flip(stalling.result);
      expect(stalling.owner.log.dispatched).toHaveLength(4);

      yield* expireEnrollmentAcceptanceLeases(fixture, input.portalEnrollmentAttemptId);
      const afterLapse = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      const retry = journeyRun(
        fixture,
        identities,
        { ...input, expectedRevision: afterLapse.revision },
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY]: {
            outcomeCode: RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
            reconciliationRef: randomUUID(),
            resultReference: BINDING_RESOURCE_ID,
            status: 'SUCCEEDED',
          },
        },
      );
      const converged = yield* retry.result;
      expect(converged.outcome).toBe('COMPLETED');
      expect(retry.owner.log.dispatched).toStrictEqual([]);

      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      expect(operations).toHaveLength(4);
      expect(operations.every((row) => row.status === 'SUCCEEDED')).toBe(true);
    }),
  ),
);

it.live('equal-email Party candidates halt into reconciliation instead of choosing a Party', () =>
  Effect.scoped(
    Effect.gen(function* ambiguousPartyCandidate() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const run = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, {
          failureCode: 'owner_reconciliation_required',
          kind: 'FAILED',
          outcomeCode: PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
        }),
      );
      const result = yield* run.result;

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('RECONCILIATION_REQUIRED');
        expect(result.halt.transitionKey).toBe(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      }
      expect(run.owner.log.dispatched).toStrictEqual([
        PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
        PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
      ]);
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      expect(operationSummary(operations)).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'FAILED', PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE],
      ]);
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      expect(attempt.state).not.toBe('COMPLETE');
    }),
  ),
);

it.live('a Party created before a failing profile ensure keeps its committed partial state', () =>
  Effect.scoped(
    Effect.gen(function* partialStateRetained() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const run = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, {
          code: 'retail_profile_precondition_failed',
          kind: 'REJECTED',
          reason: 'The Retail Customer Profile owner refused the ensure request',
        }),
      );
      const result = yield* run.result;

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('OWNER_REJECTED');
        expect(result.halt.transitionKey).toBe(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY);
      }
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      const party = operations.find((row) => row.transition_key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(party?.status).toBe('SUCCEEDED');
      expect(party?.result_reference).toBe(PARTY_RESOURCE_ID);
      const profile = operations.find((row) => row.transition_key === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY);
      expect(profile?.status).toBe('FAILED');
      expect(profile?.outcome_code).toBe('retail_profile_precondition_failed');
      expect(operations.some((row) => row.transition_key === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY)).toBe(false);
    }),
  ),
);

it.live('a retail binding that commits without its grant baseline halts as RECONCILIATION_REQUIRED', () =>
  Effect.scoped(
    Effect.gen(function* incompleteGrants() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const run = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, {
          failureCode: 'owner_reconciliation_required',
          kind: 'FAILED',
          outcomeCode: RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
        }),
      );
      const result = yield* run.result;

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('RECONCILIATION_REQUIRED');
        expect(result.halt.transitionKey).toBe(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY);
      }
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, input.portalEnrollmentAttemptId);
      expect(operationSummary(operations)).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'SUCCEEDED', PARTY_CANDIDATE_CREATED_OUTCOME_CODE],
        [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE],
        [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, 'FAILED', RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE],
      ]);
    }),
  ),
);

it.live('authority revoked mid-flight is a typed halt, never a completed journey', () =>
  Effect.scoped(
    Effect.gen(function* authorityRevokedMidFlight() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const run = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, {
          code: 'principal_binding_revoked',
          kind: 'REJECTED',
          reason: 'The Principal Auth Binding was revoked while the journey was in flight',
        }),
      );
      const result = yield* run.result;

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('OWNER_REJECTED');
        expect(Option.getOrUndefined(result.halt.outcomeCode)).toBe('principal_binding_revoked');
      }
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      expect(attempt.state).not.toBe('COMPLETE');
    }),
  ),
);

it.live('a support Actor may not resume another Actor’s owner operation under that Actor’s identity', () =>
  Effect.scoped(
    Effect.gen(function* supportResume() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const stalling = journeyRun(
        fixture,
        identities,
        input,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
      );
      yield* Effect.flip(stalling.result);
      yield* expireEnrollmentAcceptanceLeases(fixture, input.portalEnrollmentAttemptId);
      const afterLapse = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);

      // The durable owner operation is immutable and recorded for the customer's Actor, so resuming
      // it under a different Actor's identity is refused rather than silently reattributed.
      const supportActorPrincipalId = principalId(randomUUID());
      const support = journeyRun(
        fixture,
        { ...identities, actorPrincipalId: supportActorPrincipalId },
        { ...input, actorPrincipalId: supportActorPrincipalId, expectedRevision: afterLapse.revision },
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
            outcomeCode: PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
            reconciliationRef: randomUUID(),
            resultReference: PARTY_RESOURCE_ID,
            status: 'SUCCEEDED',
          },
        },
      );
      const refusal = yield* Effect.flip(support.result);
      expect(refusal.code).toBe('attempt_invalid');
      expect(support.owner.log.reconciled).toStrictEqual([]);

      const recovery = journeyRun(
        fixture,
        identities,
        { ...input, expectedRevision: afterLapse.revision },
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
            outcomeCode: PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
            reconciliationRef: randomUUID(),
            resultReference: PARTY_RESOURCE_ID,
            status: 'SUCCEEDED',
          },
        },
      );
      expect((yield* recovery.result).outcome).toBe('COMPLETED');
    }),
  ),
);

it.live('derives COMPLETE from the declared required transitions rather than from an owner claim', () =>
  Effect.scoped(
    Effect.gen(function* derivedCompletion() {
      const identities = makeScenarioIdentities();
      const { fixture, input } = yield* scenario(identities);

      const run = journeyRun(fixture, identities, input, happyAnswers);
      expect((yield* run.result).outcome).toBe('COMPLETED');

      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, input.portalEnrollmentAttemptId);
      expect(attempt.state).toBe('COMPLETE');
    }),
  ),
);
