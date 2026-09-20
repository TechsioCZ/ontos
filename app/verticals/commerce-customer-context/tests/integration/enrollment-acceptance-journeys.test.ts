import { randomUUID } from 'node:crypto';

import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { commercePortalAuthEnrollmentResumeOnRead } from '../../api/portal-auth/enrollment/http.ts';
import { commerceEnrollmentContinuationSweeperFor } from '../../src/workers/enrollment-continuation-sweeper.ts';
import {
  ClaimEnrollmentTransitionInputSchema,
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  RecordEnrollmentOutcomeInputSchema,
} from '../../shared/enrollment-contracts.ts';
import type { StartEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import type { RetailSelfEnrollmentPreparationSubject } from '../../src/enrollment/journeys/retail-self-enrollment-preparation.ts';
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
  retailPartyRefFor,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  expireEnrollmentAcceptanceLeases,
  makeEnrollmentAcceptanceFixture,
  readEnrollmentAcceptanceAttempt,
  readEnrollmentAcceptanceOperations,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceOwnerAnswer } from '../support/enrollment-acceptance-owner-script.ts';
import {
  enrollmentOperationSummary,
  makeEnrollmentContinuationHarness,
} from '../support/enrollment-continuation-harness.ts';
import type { EnrollmentContinuationScript } from '../support/enrollment-continuation-harness.ts';

/**
 * Retail self-enrollment through the server-side continuation, on real PostgreSQL.
 *
 * The continuation, the production owner-transition driver, the owner store, the Attempt service
 * and the SECURITY DEFINER routines all run for real, one committed transaction per owner phase.
 * Only the owner's answer on the far side of the dispatch seam is scripted: Party Registry and Core
 * identity are HTTP owners that are not reachable from this sandbox, so their clients are exactly
 * where the script sits.
 *
 * The portal account-creation transition is reconcile-only for a continuation — its dispatch
 * belongs to the enrollment start route, which is the only caller that ever holds the credential —
 * so every scenario seeds that transition's durable outcome the way the start route commits it.
 */

const PARTY_RESOURCE_ID = 'retail-acceptance-party';
const PROFILE_RESOURCE_ID = 'retail-acceptance-profile';
const BINDING_RESOURCE_ID = 'retail-acceptance-binding';
const PORTAL_ACCOUNT_CREATED_OUTCOME_CODE = 'provider_account_created';

const principalId = (value: string) => Schema.decodeSync(EnrollmentPrincipalIdSchema)(value);
const tenant = (value: string) => Schema.decodeSync(EnrollmentTenantIdSchema)(value);
const enrollmentKey = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const digest = (value: string) => Schema.decodeSync(EnrollmentDigestSchema)(value);

interface ScenarioIdentities {
  readonly actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type;
  readonly startInput: StartEnrollmentAttemptInput;
  readonly subject: RetailSelfEnrollmentPreparationSubject;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}

const makeScenarioIdentities = (): ScenarioIdentities => {
  const tenantId = tenant(randomUUID());
  const actorPrincipalId = principalId(randomUUID());
  return {
    actorPrincipalId,
    startInput: {
      actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
      actorPrincipalId,
      intentDigest: digest('a'.repeat(64)),
      intentKey: enrollmentKey('retail-acceptance-intent'),
      journey: 'RETAIL_SELF_ENROLLMENT',
      tenantId,
    },
    subject: {
      partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'retail-acceptance']),
      partyRef: Option.none(),
      portalEnrollmentAttemptId: Schema.decodeSync(EnrollmentAttemptIdSchema)(randomUUID()),
      principalRef: {
        moduleId: 'core.identity',
        resourceId: randomUUID(),
        resourceType: 'core.identity.principal',
        tenantId,
      },
      sellingLegalEntityRef: {
        moduleId: 'core.identity',
        resourceId: randomUUID(),
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
    },
    tenantId,
  };
};

const succeeded = (outcomeCode: string, resultReference: string): EnrollmentAcceptanceOwnerAnswer => ({
  kind: 'SUCCEEDED',
  outcomeCode,
  resultReference,
});

/** The three continuation-dispatched owner answers of a journey that runs clean end to end. */
const happyAnswers: Readonly<Record<string, EnrollmentAcceptanceOwnerAnswer>> = Object.freeze({
  [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY]: succeeded(RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE, BINDING_RESOURCE_ID),
  [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY]: succeeded(
    RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
    PROFILE_RESOURCE_ID,
  ),
  [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: succeeded(PARTY_CANDIDATE_CREATED_OUTCOME_CODE, PARTY_RESOURCE_ID),
});

const withAnswer = (transitionKey: string, answer: EnrollmentAcceptanceOwnerAnswer) => ({
  ...happyAnswers,
  [transitionKey]: answer,
});

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'retail-acceptance-subject',
  subjectType: 'user',
});

/**
 * Commit the portal account-creation transition exactly as the start route does: one durable claim
 * under its own owner invocation, then one recorded outcome carrying the account subject. Every
 * scenario starts from here, because a continuation may never dispatch that transition itself.
 */
const seedPortalAccountTransition = Effect.fnUntraced(function* seedPortalAccountTransition(
  fixture: EnrollmentAcceptanceFixture,
  identities: ScenarioIdentities,
  portalEnrollmentAttemptId: string,
  expectedRevision: number,
) {
  const ownerInvocationId = randomUUID();
  const claimed = yield* fixture.ownerStore.claimTransition(
    Schema.decodeUnknownSync(ClaimEnrollmentTransitionInputSchema)({
      actorPrincipalId: identities.actorPrincipalId,
      expectedRevision,
      leaseDurationMs: 30_000,
      ownerInvocationId,
      ownerModuleKey: 'commerce.portal-auth',
      portalEnrollmentAttemptId,
      requestDigest: digest('b'.repeat(64)),
      required: true,
      tenantId: identities.tenantId,
      transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
      workerId: 'commerce.portal-auth.enrollment-start',
    }),
  );
  if (claimed.outcome !== 'CLAIMED' || claimed.operation.lease === undefined) {
    return yield* Effect.die('The fixture could not claim the portal account-creation transition');
  }
  yield* fixture.ownerStore.recordOutcome(
    Schema.decodeUnknownSync(RecordEnrollmentOutcomeInputSchema)({
      accountSubject,
      actorPrincipalId: identities.actorPrincipalId,
      expectedRevision: claimed.attempt.revision,
      leaseToken: claimed.operation.lease.leaseToken,
      outcomeCode: PORTAL_ACCOUNT_CREATED_OUTCOME_CODE,
      ownerInvocationId,
      ownerModuleKey: 'commerce.portal-auth',
      portalEnrollmentAttemptId,
      resultReference: 'retail-acceptance-portal-account',
      status: 'SUCCEEDED',
      tenantId: identities.tenantId,
      transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
      workerId: 'commerce.portal-auth.enrollment-start',
    }),
  );
  return yield* Effect.void;
});

const scenario = Effect.fnUntraced(function* scenario(identities: ScenarioIdentities) {
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId: identities.tenantId });
  const attempt = yield* startEnrollmentAcceptanceAttempt(fixture, identities.startInput);
  yield* seedPortalAccountTransition(fixture, identities, attempt.portalEnrollmentAttemptId, attempt.revision);
  return { fixture, portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId };
});

const harnessFor = (
  fixture: EnrollmentAcceptanceFixture,
  identities: ScenarioIdentities,
  answers: EnrollmentContinuationScript['answers'],
  overrides?: Partial<Pick<EnrollmentContinuationScript, 'resolutions' | 'subject' | 'unregistered'>>,
) =>
  makeEnrollmentContinuationHarness(fixture.run, {
    actorPrincipalId: identities.actorPrincipalId,
    answers,
    subject: identities.subject,
    ...overrides,
  });

/** The subject the continuation sees once the Party transition has durably resolved a Party. */
const subjectWithParty = (identities: ScenarioIdentities): RetailSelfEnrollmentPreparationSubject => ({
  ...identities.subject,
  partyRef: Option.some(retailPartyRefFor(identities.tenantId, PARTY_RESOURCE_ID)),
});

it.live('advances a started Attempt to derived COMPLETE through every declared transition', () =>
  Effect.scoped(
    Effect.gen(function* advancesToComplete() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);
      const harness = yield* harnessFor(fixture, identities, happyAnswers, { subject: subjectWithParty(identities) });

      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('COMPLETE');
      expect(harness.owner.log.dispatched).toStrictEqual([
        PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
        ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
        BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
      ]);
      // Removing the derived-completion gate leaves this Attempt IN_PROGRESS with four SUCCEEDED
      // owner rows, and this assertion fails.
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(attempt.state).toBe('COMPLETE');
      expect(
        enrollmentOperationSummary(yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId)),
      ).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'SUCCEEDED', PARTY_CANDIDATE_CREATED_OUTCOME_CODE],
        [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE],
        [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE],
      ]);
    }),
  ),
);

it.live('a crash after the Party step re-runs onto the same Party without duplicating an effect', () =>
  Effect.scoped(
    Effect.gen(function* crashThenRerun() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      // The profile owner never answers, so the continuation stops right after the Party step.
      const crashed = yield* harnessFor(
        fixture,
        identities,
        withAnswer(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        { subject: subjectWithParty(identities) },
      );
      const halted = yield* crashed.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });
      expect(halted.outcome).toBe('HALTED');
      const afterCrash = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);
      const partyAfterCrash = afterCrash.find(
        (row) => row.transition_key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
      );
      expect(partyAfterCrash?.result_reference).toBe(PARTY_RESOURCE_ID);

      // The lease of the abandoned profile transition lapses, exactly as a killed worker's would.
      yield* expireEnrollmentAcceptanceLeases(fixture, portalEnrollmentAttemptId);
      const rerun = yield* harnessFor(
        fixture,
        identities,
        withAnswer(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          resolutions: {
            [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY]: {
              outcomeCode: RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
              reconciliationRef: randomUUID(),
              resultReference: PROFILE_RESOURCE_ID,
              status: 'SUCCEEDED',
            },
          },
          subject: subjectWithParty(identities),
        },
      );
      yield* rerun.continuation.advance({ portalEnrollmentAttemptId, tenantId: identities.tenantId });

      // The Party transition is never dispatched a second time: its durable SUCCEEDED row is proof.
      expect(rerun.owner.log.dispatched).not.toContain(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(rerun.owner.log.reconciled).toStrictEqual([ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY]);
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);
      // One row per transition, and the Party still names the very same resource. Removing the
      // derived owner-invocation identity mints a fresh one on the re-run, the claim no longer
      // replays, and this length assertion fails with a duplicated Party row.
      expect(operations).toHaveLength(4);
      const party = operations.find((row) => row.transition_key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(party?.result_reference).toBe(PARTY_RESOURCE_ID);
      expect(party?.status).toBe('SUCCEEDED');
      const profile = operations.find((row) => row.transition_key === ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY);
      expect(profile?.status).toBe('SUCCEEDED');
      expect(profile?.reconciliation_ref).not.toBeNull();
    }),
  ),
);

it.live('an owner answer that never arrives is reconciled once, never dispatched twice', () =>
  Effect.scoped(
    Effect.gen(function* indeterminateThenReconcile() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      const timingOut = yield* harnessFor(
        fixture,
        identities,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
      );
      const stalled = yield* timingOut.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });
      expect(stalled.outcome).toBe('HALTED');
      if (stalled.outcome === 'HALTED') {
        expect(stalled.halt.reason).toBe('RECONCILIATION_REQUIRED');
      }
      expect(
        timingOut.owner.log.dispatched.filter((key) => key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
      ).toHaveLength(1);
      const stalledAttempt = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(stalledAttempt.state).not.toBe('COMPLETE');

      yield* expireEnrollmentAcceptanceLeases(fixture, portalEnrollmentAttemptId);
      const recovery = yield* harnessFor(
        fixture,
        identities,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }),
        {
          resolutions: {
            [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
              outcomeCode: PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
              reconciliationRef: randomUUID(),
              resultReference: PARTY_RESOURCE_ID,
              status: 'SUCCEEDED',
            },
          },
          subject: subjectWithParty(identities),
        },
      );
      const recovered = yield* recovery.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(recovered.outcome).toBe('COMPLETE');
      // The recovered run reads the owner rather than dispatching again; dropping the INDETERMINATE
      // branch in `runTransition` re-dispatches and this assertion fails.
      expect(recovery.owner.log.dispatched).not.toContain(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(recovery.owner.log.reconciled).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);
      expect(operations).toHaveLength(4);
      const party = operations.find((row) => row.transition_key === PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY);
      expect(party?.result_reference).toBe(PARTY_RESOURCE_ID);
      expect(party?.reconciliation_ref).not.toBeNull();
    }),
  ),
);

it.live('equal-email Party candidates halt into reconciliation instead of choosing a Party', () =>
  Effect.scoped(
    Effect.gen(function* ambiguousPartyCandidate() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      const harness = yield* harnessFor(
        fixture,
        identities,
        withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, {
          failureCode: 'owner_reconciliation_required',
          kind: 'FAILED',
          outcomeCode: PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE,
        }),
      );
      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('RECONCILIATION_REQUIRED');
        expect(result.halt.transition.pipe(Option.map((transition) => transition.transitionKey))).toStrictEqual(
          Option.some(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
        );
      }
      // The journey stops at the ambiguous Party: no profile and no binding are ever dispatched.
      expect(harness.owner.log.dispatched).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
      expect(
        enrollmentOperationSummary(yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId)),
      ).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'FAILED', PARTY_CANDIDATE_AMBIGUOUS_OUTCOME_CODE],
      ]);
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(attempt.state).not.toBe('COMPLETE');
    }),
  ),
);

it.live('a Party created before a failing profile ensure keeps its committed partial state', () =>
  Effect.scoped(
    Effect.gen(function* partialStateRetained() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      const harness = yield* harnessFor(
        fixture,
        identities,
        withAnswer(ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, {
          code: 'retail_profile_precondition_failed',
          kind: 'REJECTED',
          reason: 'The Retail Customer Profile owner refused the ensure request',
        }),
        { subject: subjectWithParty(identities) },
      );
      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('OWNER_REJECTED');
      }
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);
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
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      const harness = yield* harnessFor(
        fixture,
        identities,
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, {
          failureCode: 'owner_reconciliation_required',
          kind: 'FAILED',
          outcomeCode: RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
        }),
        { subject: subjectWithParty(identities) },
      );
      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('RECONCILIATION_REQUIRED');
        expect(result.halt.transition.pipe(Option.map((transition) => transition.transitionKey))).toStrictEqual(
          Option.some(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY),
        );
      }
      expect(
        enrollmentOperationSummary(yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId)),
      ).toStrictEqual([
        [PORTAL_ACCOUNT_CREATION_TRANSITION_KEY, 'SUCCEEDED', PORTAL_ACCOUNT_CREATED_OUTCOME_CODE],
        [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, 'SUCCEEDED', PARTY_CANDIDATE_CREATED_OUTCOME_CODE],
        [ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY, 'SUCCEEDED', RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE],
        [BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, 'FAILED', RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE],
      ]);
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(attempt.state).not.toBe('COMPLETE');
    }),
  ),
);

it.live('authority revoked mid-flight is a typed halt, never a completed journey', () =>
  Effect.scoped(
    Effect.gen(function* authorityRevokedMidFlight() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);

      const harness = yield* harnessFor(
        fixture,
        identities,
        withAnswer(BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY, {
          code: 'principal_binding_revoked',
          kind: 'REJECTED',
          reason: 'The Principal Auth Binding was revoked while the journey was in flight',
        }),
        { subject: subjectWithParty(identities) },
      );
      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('OWNER_REJECTED');
      }
      const operations = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);
      const binding = operations.find((row) => row.transition_key === BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY);
      expect(binding?.outcome_code).toBe('principal_binding_revoked');
      const attempt = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(attempt.state).not.toBe('COMPLETE');
    }),
  ),
);

it.live('a transition no owner effect is registered for halts with the Attempt untouched', () =>
  Effect.scoped(
    Effect.gen(function* unregisteredTransition() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);
      const before = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);

      const harness = yield* harnessFor(fixture, identities, happyAnswers, {
        unregistered: [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY],
      });
      const result = yield* harness.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(result.outcome).toBe('HALTED');
      if (result.outcome === 'HALTED') {
        expect(result.halt.reason).toBe('NO_OWNER_EFFECT');
        expect(result.halt.transition.pipe(Option.map((transition) => transition.transitionKey))).toStrictEqual(
          Option.some(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY),
        );
      }
      // Nothing is claimed, nothing is dispatched, and the Attempt's revision does not move.
      // Turning the registry miss into a wildcard would move the revision and fail this.
      expect(harness.owner.log.dispatched).toStrictEqual([]);
      const after = yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId);
      expect(after.revision).toBe(before.revision);
      expect(yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId)).toHaveLength(1);
    }),
  ),
);

it.live('a second advance of a COMPLETE Attempt dispatches nothing at all', () =>
  Effect.scoped(
    Effect.gen(function* idempotentReRun() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);
      const first = yield* harnessFor(fixture, identities, happyAnswers, { subject: subjectWithParty(identities) });
      expect(
        (yield* first.continuation.advance({ portalEnrollmentAttemptId, tenantId: identities.tenantId })).outcome,
      ).toBe('COMPLETE');
      const settled = yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId);

      const second = yield* harnessFor(fixture, identities, happyAnswers, { subject: subjectWithParty(identities) });
      const replay = yield* second.continuation.advance({
        portalEnrollmentAttemptId,
        tenantId: identities.tenantId,
      });

      expect(replay.outcome).toBe('COMPLETE');
      expect(second.owner.log.dispatched).toStrictEqual([]);
      expect(second.owner.log.reconciled).toStrictEqual([]);
      // Byte-identical journal: a re-run of a settled Attempt must change nothing.
      expect(yield* readEnrollmentAcceptanceOperations(fixture, portalEnrollmentAttemptId)).toStrictEqual(settled);
    }),
  ),
);

/**
 * Durable retry for a journey the detached start fork abandoned.
 *
 * `advance` is the only thing that moves a journey, and its only caller is a fork of a request that
 * has already answered. A halt — a lost owner answer, another worker's lease, an unavailable
 * owner — therefore leaves the Attempt non-terminal with nothing scheduled to touch it again. Two
 * things come back for it: a read of the Attempt, and the sweeper.
 */

/** The owner whose answer never arrives on the first pass and is read back on the second. */
const reconcilingPartyHarness = (fixture: EnrollmentAcceptanceFixture, identities: ScenarioIdentities) =>
  harnessFor(fixture, identities, withAnswer(PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY, { kind: 'TIMED_OUT' }), {
    resolutions: {
      [PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]: {
        outcomeCode: PARTY_CANDIDATE_CREATED_OUTCOME_CODE,
        reconciliationRef: randomUUID(),
        resultReference: PARTY_RESOURCE_ID,
        status: 'SUCCEEDED',
      },
    },
    subject: subjectWithParty(identities),
  });

it.live('a read resumes a halted Attempt once its lease has lapsed, and never before', () =>
  Effect.scoped(
    Effect.gen(function* readResumesAStalledAttempt() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);
      const harness = yield* reconcilingPartyHarness(fixture, identities);
      const identity = { portalEnrollmentAttemptId, tenantId: identities.tenantId };

      const halted = yield* harness.continuation.advance(identity);
      expect(halted.outcome).toBe('HALTED');

      // While the abandoned claim's lease is still live it owns the transition, so a read must not
      // touch it: resuming here would race a worker that may still answer.
      const leased = yield* commercePortalAuthEnrollmentResumeOnRead(
        harness.continuation,
        yield* fixture.ownerStore.read(identity),
      );
      expect(Option.isNone(leased)).toBe(true);

      // The lease lapses exactly as a killed worker's would, and now the read is the only signal
      // that anyone is still waiting on this Attempt.
      yield* expireEnrollmentAcceptanceLeases(fixture, portalEnrollmentAttemptId);
      const resumed = yield* commercePortalAuthEnrollmentResumeOnRead(
        harness.continuation,
        yield* fixture.ownerStore.read(identity),
      );

      expect(resumed.pipe(Option.map((result) => result.outcome))).toStrictEqual(Option.some('COMPLETE'));
      // The lost Party answer is read back rather than dispatched again, and the journey finishes.
      expect(harness.owner.log.reconciled).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
      expect(yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId)).toMatchObject({
        state: 'COMPLETE',
      });

      // A settled Attempt has nothing to resume, so a later read dispatches and reconciles nothing.
      const settled = yield* commercePortalAuthEnrollmentResumeOnRead(
        harness.continuation,
        yield* fixture.ownerStore.read(identity),
      );
      expect(Option.isNone(settled)).toBe(true);
      expect(harness.owner.log.reconciled).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
    }),
  ),
);

it.live('the sweeper re-advances a stale halted Attempt nobody ever reads', () =>
  Effect.scoped(
    Effect.gen(function* sweeperResumesAStaleAttempt() {
      const identities = makeScenarioIdentities();
      const { fixture, portalEnrollmentAttemptId } = yield* scenario(identities);
      const harness = yield* reconcilingPartyHarness(fixture, identities);
      // The stale window is zero here so the scenario decides when an Attempt is due rather than
      // the wall clock; in the deployment it is the continuation's own lease window.
      const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
        continuation: harness.continuation,
        staleAfterMillis: 0,
      });
      const identity = { portalEnrollmentAttemptId, tenantId: identities.tenantId };

      // The journey halts inside the swept continuation, which is the only place the Attempt is
      // registered: no caller has to remember to enrol it.
      const halted = yield* sweeper.continuation.advance(identity);
      expect(halted.outcome).toBe('HALTED');
      yield* expireEnrollmentAcceptanceLeases(fixture, portalEnrollmentAttemptId);

      const sweep = yield* sweeper.sweep;

      expect(sweep.swept).toBe(1);
      // Without a sweeper this Attempt stays IN_PROGRESS for good: nothing else ever calls advance.
      expect(yield* readEnrollmentAcceptanceAttempt(fixture, portalEnrollmentAttemptId)).toMatchObject({
        state: 'COMPLETE',
      });
      expect(harness.owner.log.reconciled).toStrictEqual([PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY]);
      // A completed journey is released, so the sweeper does not keep re-reading a settled Attempt.
      expect(sweep.tracked).toBe(0);
      expect((yield* sweeper.sweep).swept).toBe(0);
    }),
  ),
);
