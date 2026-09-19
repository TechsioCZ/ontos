import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AttemptClaimedResult, AttemptRecordResult } from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  CommerceEnrollmentAttemptConflict,
  CommerceEnrollmentAttemptIndeterminate,
} from '../../src/enrollment/attempts/errors.ts';
import {
  JourneyDefinitionSchema,
  defineJourneyDefinition,
  journeyCatalogIssue,
  journeyDefinitionFor,
  journeyDefinitionIssue,
  journeyRequiresTransition,
  journeyTransitionFor,
  journeyTransitionIdentity,
  journeyTransitions,
} from '../../src/enrollment/journeys/journey-contracts.ts';
import type { JourneyTransitionSpec } from '../../src/enrollment/journeys/journey-contracts.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
  PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
  RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
  isRetailSelfEnrollmentReconciliationOutcome,
  retailPartyCandidateDigest,
  retailPartyRefFor,
  retailSelfEnrollmentEvidenceReference,
  retailSelfEnrollmentJourneyDefinition,
  retailSelfEnrollmentRequestDigest,
  retailSelfEnrollmentStepPlan,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  RetailSelfEnrollmentOwners,
  runRetailSelfEnrollment,
} from '../../src/enrollment/journeys/retail-self-enrollment.ts';
import type {
  RetailSelfEnrollmentHalt,
  RetailSelfEnrollmentPlanInput,
  RetailSelfEnrollmentStepOutcome,
} from '../../src/enrollment/journeys/retail-self-enrollment.ts';
import type {
  CommerceEnrollmentOwnerTransition,
  CommerceEnrollmentOwnerTransitionDriver,
} from '../../src/enrollment/orchestration/owner-transition-driver.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentLeaseTokenSchema,
  EnrollmentModuleKeySchema,
  EnrollmentOwnerOperationIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentResourceIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
} from '../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot, EnrollmentOwnerOperationSnapshot } from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const attemptId = Schema.decodeSync(EnrollmentAttemptIdSchema)('20000000-0000-4000-8000-000000000001');
const actorPrincipalId = Schema.decodeSync(EnrollmentPrincipalIdSchema)('40000000-0000-4000-8000-000000000001');
const operationId = Schema.decodeSync(EnrollmentOwnerOperationIdSchema)('50000000-0000-4000-8000-000000000001');
const leaseToken = Schema.decodeSync(EnrollmentLeaseTokenSchema)('60000000-0000-4000-8000-000000000001');
const reconciliationRef = Schema.decodeSync(EnrollmentEvidenceReferenceSchema)('70000000-0000-4000-8000-000000000001');
const workerId = Schema.decodeSync(EnrollmentKeySchema)('retail-journey-worker');
const at = DateTime.makeUnsafe('2026-09-19T10:00:00.000Z');
const activeUntil = DateTime.makeUnsafe('2099-09-19T10:00:00.000Z');

const partyResourceId = 'party-resource-1';
const profileResourceId = 'retail-profile-1';
const bindingResourceId = 'retail-binding-1';

const principalRef = {
  moduleId: 'core.identity',
  resourceId: '80000000-0000-4000-8000-000000000001',
  resourceType: 'core.identity.principal',
  tenantId,
} as const;

const sellingLegalEntityRef = {
  moduleId: 'core.identity',
  resourceId: 'selling-legal-entity-1',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;

const planInput: RetailSelfEnrollmentPlanInput = {
  actorPrincipalId,
  expectedRevision: 1,
  partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'Jana Nova']),
  portalEnrollmentAttemptId: attemptId,
  principalRef,
  requestCorrelation: 'retail-journey-unit',
  sellingLegalEntityRef,
  tenantId,
};

const stepPlan = retailSelfEnrollmentStepPlan();
const stepIdentity = (step: JourneyTransitionSpec): string => journeyTransitionIdentity(step);
const identityAt = (index: number): string => {
  const step = stepPlan[index];
  return step === undefined ? `missing-${String(index)}` : stepIdentity(step);
};

const ownerInvocationIds = new Map(
  stepPlan.map((step, index) => [
    stepIdentity(step),
    Schema.decodeSync(EnrollmentActionInvocationIdSchema)(`3000000${String(index)}-0000-4000-8000-000000000001`),
  ]),
);

const attemptSnapshot = (revision: number): EnrollmentAttemptSnapshot => ({
  createdAt: at,
  createdByPrincipalId: actorPrincipalId,
  intentDigest: 'b'.repeat(64),
  intentKey: Schema.decodeSync(EnrollmentKeySchema)('retail-intent-1'),
  journey: 'RETAIL_SELF_ENROLLMENT',
  lease: { leaseExpiresAt: activeUntil, leaseToken, workerId },
  portalEnrollmentAttemptId: attemptId,
  revision,
  state: 'IN_PROGRESS',
  tenantId,
  updatedAt: at,
});

const key = (value: string): typeof EnrollmentKeySchema.Type => Schema.decodeSync(EnrollmentKeySchema)(value);
const resourceId = (value: string): typeof EnrollmentResourceIdSchema.Type =>
  Schema.decodeSync(EnrollmentResourceIdSchema)(value);

/** What a step's owner is scripted to do when the journey dispatches it. */
interface StepScript {
  readonly kind: 'CONFLICT' | 'FAILED' | 'INDETERMINATE_THEN_RECONCILED' | 'LEASE_HELD' | 'REPLAYED' | 'SUCCEEDED';
  readonly outcomeCode: string;
  readonly resultReference: string | null;
}

const script = (kind: StepScript['kind'], outcomeCode: string, resultReference: string | null = null): StepScript => ({
  kind,
  outcomeCode,
  resultReference,
});

const defaultScripts: Readonly<Record<string, StepScript>> = Object.freeze({
  [identityAt(0)]: script('SUCCEEDED', 'core_binding_activated', 'core-binding-1'),
  [identityAt(1)]: script('SUCCEEDED', PARTY_CANDIDATE_MATCHED_OUTCOME_CODE, partyResourceId),
  [identityAt(2)]: script('SUCCEEDED', RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE, profileResourceId),
  [identityAt(3)]: script('SUCCEEDED', RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE, bindingResourceId),
});

const withScript = (index: number, replacement: StepScript) => ({
  ...defaultScripts,
  [identityAt(index)]: replacement,
});

const outcomeCodesOf = (steps: readonly RetailSelfEnrollmentStepOutcome[]): readonly (string | undefined)[] =>
  steps.map((step) => step.outcomeCode);

const haltSummary = (halt: RetailSelfEnrollmentHalt): readonly string[] => [
  halt.ownerModuleKey,
  halt.transitionKey,
  halt.reason,
];

const transitionIdentityOf = (
  transitions: readonly CommerceEnrollmentOwnerTransition[],
): readonly (readonly string[])[] =>
  transitions.map((transition) => [
    transition.ownerModuleKey,
    transition.transitionKey,
    transition.requestDigest,
    transition.ownerInvocationId,
  ]);

interface Harness {
  readonly dispatched: CommerceEnrollmentOwnerTransition[];
  readonly reconciled: CommerceEnrollmentOwnerTransition[];
  readonly run: Effect.Effect<
    Effect.Success<ReturnType<typeof runRetailSelfEnrollment>>,
    Effect.Error<ReturnType<typeof runRetailSelfEnrollment>>
  >;
}

const makeHarness = (
  scripts: Readonly<Record<string, StepScript>> = defaultScripts,
  input: RetailSelfEnrollmentPlanInput = planInput,
): Harness => {
  const dispatched: CommerceEnrollmentOwnerTransition[] = [];
  const reconciled: CommerceEnrollmentOwnerTransition[] = [];
  let revision = input.expectedRevision;

  const operationSnapshot = (
    transition: CommerceEnrollmentOwnerTransition,
    status: EnrollmentOwnerOperationSnapshot['status'],
    outcome: StepScript | null,
  ): EnrollmentOwnerOperationSnapshot => {
    const base: EnrollmentOwnerOperationSnapshot = {
      actorPrincipalId,
      createdAt: at,
      ownerInvocationId: transition.ownerInvocationId,
      ownerModuleKey: transition.ownerModuleKey,
      portalEnrollmentAttemptId: attemptId,
      portalEnrollmentOwnerOperationId: operationId,
      requestDigest: transition.requestDigest,
      required: true,
      revision: 2,
      status,
      tenantId,
      transitionKey: transition.transitionKey,
      updatedAt: at,
    };
    if (outcome === null) {
      return base;
    }
    if (outcome.resultReference === null) {
      return { ...base, outcomeCode: key(outcome.outcomeCode) };
    }
    return {
      ...base,
      outcomeCode: key(outcome.outcomeCode),
      resultReference: resourceId(outcome.resultReference),
    };
  };

  const recordResult = (
    transition: CommerceEnrollmentOwnerTransition,
    status: 'FAILED' | 'SUCCEEDED',
  ): AttemptRecordResult => {
    revision += 2;
    return {
      attempt: attemptSnapshot(revision),
      operation: operationSnapshot(transition, status, null),
      outcome: 'RECORDED',
    };
  };

  const claimResult = (
    transition: CommerceEnrollmentOwnerTransition,
    outcome: AttemptClaimedResult['outcome'],
    status: EnrollmentOwnerOperationSnapshot['status'],
    replayed: StepScript | null,
  ): AttemptClaimedResult => ({
    attempt: attemptSnapshot(revision + 1),
    operation: operationSnapshot(transition, status, replayed),
    outcome,
  });

  const ownerOutcomeOf = (current: StepScript, status: 'FAILED' | 'SUCCEEDED') => {
    const outcomeCode = key(current.outcomeCode);
    if (status === 'FAILED') {
      return {
        failureCode: key('owner_reconciliation_required'),
        failureReason: 'scripted owner failure',
        outcomeCode,
        status,
      };
    }
    return current.resultReference === null
      ? { outcomeCode, status }
      : { outcomeCode, resultReference: resourceId(current.resultReference), status };
  };

  const driverFor = (step: JourneyTransitionSpec): CommerceEnrollmentOwnerTransitionDriver => {
    const current = scripts[stepIdentity(step)] ?? script('LEASE_HELD', 'lease_held');
    return {
      execute: (transition) => {
        dispatched.push(transition);
        if (current.kind === 'CONFLICT') {
          return Effect.fail(
            new CommerceEnrollmentAttemptConflict({
              attemptId,
              code: 'attempt_revision_conflict',
              reason: 'The Attempt revision is stale',
              retryable: true,
            }),
          );
        }
        if (current.kind === 'INDETERMINATE_THEN_RECONCILED') {
          return Effect.fail(
            new CommerceEnrollmentAttemptIndeterminate({
              attemptId,
              code: 'attempt_indeterminate',
              ownerInvocationId: transition.ownerInvocationId,
              reason: 'The owner timed out after a possible commit',
              retryable: true,
            }),
          );
        }
        if (current.kind === 'LEASE_HELD') {
          return Effect.succeed({
            claim: claimResult(transition, 'ALREADY_CLAIMED', 'IN_PROGRESS', null),
            outcome: 'LEASE_HELD' as const,
          });
        }
        if (current.kind === 'REPLAYED') {
          return Effect.succeed({
            claim: claimResult(transition, 'REPLAYED', 'SUCCEEDED', current),
            outcome: 'REPLAYED' as const,
          });
        }
        const status = current.kind === 'SUCCEEDED' ? ('SUCCEEDED' as const) : ('FAILED' as const);
        return Effect.succeed({
          claim: claimResult(transition, 'CLAIMED', 'IN_PROGRESS', null),
          outcome: 'RECORDED' as const,
          ownerOutcome: ownerOutcomeOf(current, status),
          recorded: recordResult(transition, status),
        });
      },
      reconcile: (transition) => {
        reconciled.push(transition);
        if (current.kind !== 'INDETERMINATE_THEN_RECONCILED') {
          return Effect.fail(
            new CommerceEnrollmentAttemptConflict({
              attemptId,
              code: 'attempt_conflict',
              reason: 'Unexpected reconciliation',
              retryable: false,
            }),
          );
        }
        const resolution =
          current.resultReference === null
            ? {
                actorPrincipalId,
                outcomeCode: key(current.outcomeCode),
                reconciliationRef,
                status: 'SUCCEEDED' as const,
              }
            : {
                actorPrincipalId,
                outcomeCode: key(current.outcomeCode),
                reconciliationRef,
                resultReference: resourceId(current.resultReference),
                status: 'SUCCEEDED' as const,
              };
        return Effect.succeed({
          outcome: 'RECORDED' as const,
          recorded: recordResult(transition, 'SUCCEEDED'),
          resolution,
        });
      },
    };
  };

  const run = runRetailSelfEnrollment(input).pipe(
    Effect.provideService(RetailSelfEnrollmentOwners, {
      driverFor: (step) => Option.some(driverFor(step)),
      ownerInvocationIdFor: (step) => Option.fromNullishOr(ownerInvocationIds.get(stepIdentity(step))),
      readAttempt: () => Effect.succeed(attemptSnapshot(revision + 1)),
    }),
  );

  return { dispatched, reconciled, run };
};

it('declares the four required Retail self-enrollment owner transitions in dispatch order', () => {
  expect(retailSelfEnrollmentJourneyDefinition.kind).toBe('RETAIL_SELF_ENROLLMENT');
  expect(retailSelfEnrollmentJourneyDefinition.optionalTransitions).toHaveLength(0);
  expect(journeyDefinitionIssue(retailSelfEnrollmentJourneyDefinition)).toBeUndefined();
  expect(Schema.is(JourneyDefinitionSchema)(retailSelfEnrollmentJourneyDefinition)).toBe(true);
  expect(stepPlan.map((step) => [step.ownerModuleKey, step.transitionKey])).toStrictEqual([
    [PORTAL_AUTH_OWNER_MODULE_KEY, PORTAL_ACCOUNT_CREATION_TRANSITION_KEY],
    [PARTY_REGISTRY_OWNER_MODULE_KEY, PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY],
    [COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY],
    [COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY, BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY],
  ]);
  expect(journeyTransitions(retailSelfEnrollmentJourneyDefinition)).toHaveLength(4);
  expect(
    journeyRequiresTransition(
      retailSelfEnrollmentJourneyDefinition,
      COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
      BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
    ),
  ).toBe(true);
  expect(
    journeyTransitionFor(retailSelfEnrollmentJourneyDefinition, PARTY_REGISTRY_OWNER_MODULE_KEY, 'not-declared'),
  ).toBeUndefined();
});

it('rejects a declaration that misplaces or repeats a transition', () => {
  expect(
    journeyDefinitionIssue({
      optionalTransitions: [],
      requiredTransitions: [{ ownerModuleKey: 'core.identity', required: false, transitionKey: 'x' }],
    }),
  ).toBeDefined();
  expect(journeyDefinitionIssue({ optionalTransitions: [], requiredTransitions: [] })).toBeDefined();
  expect(
    journeyDefinitionIssue({
      optionalTransitions: [],
      requiredTransitions: [
        { ownerModuleKey: 'core.identity', required: true, transitionKey: 'x' },
        { ownerModuleKey: 'core.identity', required: true, transitionKey: 'x' },
      ],
    }),
  ).toBeDefined();
});

it('resolves a journey declaration by kind and rejects a catalog that repeats one kind', () => {
  const other = defineJourneyDefinition({
    kind: 'EXISTING_ACCOUNT',
    optionalTransitions: [],
    requiredTransitions: [
      { ownerModuleKey: 'core.identity', required: true, transitionKey: 'reserve-principal-binding' },
    ],
  });
  const catalog = [retailSelfEnrollmentJourneyDefinition, other];
  expect(journeyDefinitionFor(catalog, 'RETAIL_SELF_ENROLLMENT')).toBe(retailSelfEnrollmentJourneyDefinition);
  expect(journeyDefinitionFor(catalog, 'COUNTERPARTY_INVITATION')).toBeUndefined();
  expect(journeyCatalogIssue(catalog)).toBeUndefined();
  expect(journeyCatalogIssue([other, other])).toBeDefined();
});

it('derives a stable request digest per transition and a distinct one per exact subject', () => {
  const partyRefA = retailPartyRefFor(tenantId, partyResourceId);
  const partyRefB = retailPartyRefFor(tenantId, 'party-resource-2');
  const digestFor = (partyRef: typeof partyRefA): string =>
    retailSelfEnrollmentRequestDigest({
      intent: { partyRef, sellingLegalEntityRef, step: 'RETAIL_CUSTOMER_PROFILE' },
      ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
      portalEnrollmentAttemptId: attemptId,
      transitionKey: ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
    });
  expect(digestFor(partyRefA)).toBe(digestFor(partyRefA));
  expect(digestFor(partyRefA)).not.toBe(digestFor(partyRefB));
  expect(isRetailSelfEnrollmentReconciliationOutcome(PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE)).toBe(true);
  expect(isRetailSelfEnrollmentReconciliationOutcome('owner_rejected')).toBe(false);
  expect(retailSelfEnrollmentEvidenceReference(['a', 'b'])).toBe(retailSelfEnrollmentEvidenceReference(['a', 'b']));
  expect(Schema.is(EnrollmentEvidenceReferenceSchema)(retailSelfEnrollmentEvidenceReference(['a', 'b']))).toBe(true);
});

it.effect('completes the happy path and records every owner outcome in dispatch order', () =>
  Effect.gen(function* happyPath() {
    const harness = makeHarness();
    const result = yield* harness.run;
    expect(result.outcome).toBe('COMPLETED');
    if (result.outcome !== 'COMPLETED') {
      return;
    }
    expect(result.partyRef.resourceId).toBe(partyResourceId);
    expect(result.steps.map((step) => step.transitionKey)).toStrictEqual(stepPlan.map((step) => step.transitionKey));
    expect(outcomeCodesOf(result.steps)).toStrictEqual([
      'core_binding_activated',
      PARTY_CANDIDATE_MATCHED_OUTCOME_CODE,
      RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
      RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
    ]);
    expect(harness.dispatched).toHaveLength(4);
    expect(new Set(harness.dispatched.map((transition) => transition.requestDigest)).size).toBe(4);
  }),
);

it.effect('halts into reconciliation on an ambiguous Party and never dispatches a later owner', () =>
  Effect.gen(function* ambiguousParty() {
    const harness = makeHarness(withScript(1, script('FAILED', PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE)));
    const result = yield* harness.run;
    expect(result.outcome).toBe('HALTED');
    if (result.outcome !== 'HALTED') {
      return;
    }
    expect(haltSummary(result.halt)).toStrictEqual([
      PARTY_REGISTRY_OWNER_MODULE_KEY,
      PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
      'RECONCILIATION_REQUIRED',
    ]);
    expect(result.steps).toHaveLength(1);
    expect(harness.dispatched).toHaveLength(2);
  }),
);

it.effect('halts into reconciliation when the binding commits without the complete grant baseline', () =>
  Effect.gen(function* partialGrants() {
    const harness = makeHarness(withScript(3, script('FAILED', RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE)));
    const result = yield* harness.run;
    expect(result.outcome).toBe('HALTED');
    if (result.outcome !== 'HALTED') {
      return;
    }
    expect(result.halt.reason).toBe('RECONCILIATION_REQUIRED');
    expect(Option.getOrNull(result.halt.outcomeCode)).toBe(RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE);
    expect(result.steps).toHaveLength(3);
  }),
);

it.effect('rejects a recorded owner refusal that is not reconcilable', () =>
  Effect.gen(function* ownerRejected() {
    const harness = makeHarness(withScript(2, script('FAILED', 'retail_customer_profile_not_active')));
    const result = yield* harness.run;
    expect(result.outcome).toBe('HALTED');
    if (result.outcome === 'HALTED') {
      expect(result.halt.reason).toBe('OWNER_REJECTED');
    }
  }),
);

for (const [index, step] of stepPlan.entries()) {
  it.effect(`reconciles by exact owner read after a timeout on ${step.transitionKey}`, () =>
    Effect.gen(function* timeoutAfterCommit() {
      const base = defaultScripts[stepIdentity(step)] ?? script('SUCCEEDED', 'owner_recovered');
      const harness = makeHarness(
        withScript(index, script('INDETERMINATE_THEN_RECONCILED', base.outcomeCode, base.resultReference)),
      );
      const result = yield* harness.run;
      expect(result.outcome).toBe('COMPLETED');
      if (result.outcome !== 'COMPLETED') {
        return;
      }
      expect(result.steps[index]?.outcome).toBe('RECONCILED');
      expect(harness.reconciled).toHaveLength(1);
      // A timeout is reconciled by one exact owner read of the original invocation, not a re-dispatch.
      expect(harness.reconciled[0]?.ownerInvocationId).toBe(harness.dispatched[index]?.ownerInvocationId);
      expect(harness.dispatched.filter((transition) => transition.transitionKey === step.transitionKey)).toHaveLength(
        1,
      );
    }),
  );
}

it.effect('replays an equivalent retry with identical transition keys, digests and owner invocations', () =>
  Effect.gen(function* retryWithoutDuplicates() {
    const first = makeHarness();
    yield* first.run;
    const replayScripts = Object.fromEntries(
      stepPlan.map((step) => {
        const base = defaultScripts[stepIdentity(step)] ?? script('REPLAYED', 'replayed');
        return [stepIdentity(step), script('REPLAYED', base.outcomeCode, base.resultReference)];
      }),
    );
    const second = makeHarness(replayScripts);
    const result = yield* second.run;
    expect(result.outcome).toBe('COMPLETED');
    expect(transitionIdentityOf(second.dispatched)).toStrictEqual(transitionIdentityOf(first.dispatched));
    if (result.outcome === 'COMPLETED') {
      expect(result.steps.every((outcome) => outcome.outcome === 'REPLAYED')).toBe(true);
    }
  }),
);

it.effect('authorizes nothing from a stale Attempt revision', () =>
  Effect.gen(function* staleAttempt() {
    const harness = makeHarness(withScript(0, script('CONFLICT', 'stale')));
    const error = yield* Effect.flip(harness.run);
    expect(Schema.is(CommerceEnrollmentAttemptConflict)(error)).toBe(true);
    expect(harness.dispatched).toHaveLength(1);
    expect(harness.reconciled).toHaveLength(0);
  }),
);

it.effect('halts without dispatching a later owner while another worker holds the lease', () =>
  Effect.gen(function* leaseHeld() {
    const harness = makeHarness(withScript(2, script('LEASE_HELD', 'lease_held')));
    const result = yield* harness.run;
    expect(result.outcome).toBe('HALTED');
    if (result.outcome === 'HALTED') {
      expect(result.halt.reason).toBe('IN_FLIGHT');
      expect(Option.isNone(result.halt.outcomeCode)).toBe(true);
    }
    expect(harness.dispatched).toHaveLength(3);
  }),
);

it.effect('rejects a journey step with no installed owner driver', () =>
  Effect.gen(function* missingDriver() {
    const error = yield* runRetailSelfEnrollment(planInput).pipe(
      Effect.provideService(RetailSelfEnrollmentOwners, {
        driverFor: Option.none,
        ownerInvocationIdFor: Option.none,
        readAttempt: () => Effect.succeed(attemptSnapshot(2)),
      }),
      Effect.flip,
    );
    expect(error.code).toBe('attempt_invalid');
  }),
);

it('keeps the enrollment vocabulary decodable at the Attempt boundary', () => {
  expect(Schema.decodeSync(EnrollmentModuleKeySchema)(PARTY_REGISTRY_OWNER_MODULE_KEY)).toBe(
    PARTY_REGISTRY_OWNER_MODULE_KEY,
  );
  expect(Schema.decodeSync(EnrollmentTransitionKeySchema)(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY)).toBe(
    BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  );
});
