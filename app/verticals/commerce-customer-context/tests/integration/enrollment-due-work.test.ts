import { randomUUID } from 'node:crypto';

import { Effect, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import type { StartEnrollmentAttemptInput } from '../../shared/enrollment-contracts.ts';
import type { CommerceEnrollmentContinuationService } from '../../src/enrollment/continuation/enrollment-continuation.ts';
import type { DueEnrollmentAttempt } from '../../src/enrollment/attempts/attempt-persistence.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  retailPartyCandidateDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { commerceEnrollmentDueAttemptStoreForRun } from '../../src/enrollment/orchestration/owner-transition-production.ts';
import { PORTAL_ACCOUNT_CREATION_TRANSITION_KEY } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import {
  commerceEnrollmentContinuationSweeperFor,
  SWEEP_BUDGET,
} from '../../src/workers/enrollment-continuation-sweeper.ts';
import {
  advanceEnrollmentAcceptanceAttemptRevision,
  backdateEnrollmentAcceptanceAttempt,
  makeEnrollmentAcceptanceFixture,
  expireEnrollmentAcceptanceSweepClaim,
  readEnrollmentAcceptanceSweepCount,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  enrollmentContinuationForTenants,
  makeEnrollmentContinuationHarness,
} from '../support/enrollment-continuation-harness.ts';

/**
 * The cross-Tenant due-work surface itself, on real PostgreSQL: who may read it, and in what order
 * it hands work out.
 *
 * Both properties are invisible from one Attempt's journey. The first is a boundary — the listing
 * is the only Attempt surface that crosses Tenants, so it has to refuse everyone but a worker tick.
 * The second is an ordering under pressure: the listing is oldest-first, and the Attempts a sweep
 * budget already gave up on are always the oldest, so without paging they would be every page the
 * sweeper ever reads.
 *
 * Every Attempt here is one no owner effect is registered for, so an advance halts with
 * `NO_OWNER_EFFECT` and writes nothing — leaving the activity timestamp each test placed it at.
 */

/** Each test states its own position in the global activity order rather than racing the clock. */
const ANCIENT_ACTIVITY = ['2001-01-01T00:00:00Z', '2001-01-02T00:00:00Z', '2001-01-03T00:00:00Z'] as const;
const NEWER_ACTIVITY = '2001-01-04T00:00:00Z';

/** Long enough that a losing bid in the same tick can only be the claim refusing it. */
const CLAIM_WINDOW_MILLIS = 60_000;

const principalId = (value: string) => Schema.decodeSync(EnrollmentPrincipalIdSchema)(value);
const tenant = (value: string) => Schema.decodeSync(EnrollmentTenantIdSchema)(value);
const enrollmentKey = (value: string) => Schema.decodeSync(EnrollmentKeySchema)(value);
const digest = (value: string) => Schema.decodeSync(EnrollmentDigestSchema)(value);

const everyTransition = [
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
] as const;

const startInputFor = (
  tenantId: typeof EnrollmentTenantIdSchema.Type,
  actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type,
  intent: string,
): StartEnrollmentAttemptInput => ({
  actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
  actorPrincipalId,
  intentDigest: digest('a'.repeat(64)),
  intentKey: enrollmentKey(intent),
  journey: 'RETAIL_SELF_ENROLLMENT',
  tenantId,
});

/** One replica's bid for one Attempt's next sweep, at the claim length the scenario needs. */
const sweepFor = (
  attempt: {
    readonly portalEnrollmentAttemptId: typeof EnrollmentAttemptIdSchema.Type;
    readonly revision: number;
  },
  tenantId: typeof EnrollmentTenantIdSchema.Type,
  claimTtlMillis: number,
) => ({
  claimTtlMillis,
  maxSweeps: SWEEP_BUDGET,
  portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
  revision: attempt.revision,
  tenantId,
});

/** A continuation whose every journey transition halts, wired to the real durable listing. */
const haltingContinuationFor = Effect.fnUntraced(function* haltingContinuationFor(
  fixture: EnrollmentAcceptanceFixture,
  tenantId: typeof EnrollmentTenantIdSchema.Type,
  actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type,
) {
  const harness = yield* makeEnrollmentContinuationHarness(fixture.run, fixture.runWorker, {
    actorPrincipalId,
    answers: {},
    subject: {
      partyCandidateDigest: retailPartyCandidateDigest(['PERSON', 'due-work']),
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
    unregistered: everyTransition,
  });
  return enrollmentContinuationForTenants(harness.continuation, [tenantId]);
});

/** How many ticks a test may spend waiting for a sweep budget to run out before it gives up. */
const MAX_SWEEP_TICKS = 64;

it.live('advances a newer Attempt in one tick even when a whole page of older ones is exhausted', () =>
  Effect.scoped(
    Effect.gen(function* pagesPastExhaustedAttempts() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const scoped = yield* haltingContinuationFor(fixture, tenantId, actorPrincipalId);
      const advanced = yield* Ref.make<readonly string[]>([]);
      const continuation: CommerceEnrollmentContinuationService = {
        advance: (input) =>
          Ref.update(advanced, (ids) => [...ids, input.portalEnrollmentAttemptId]).pipe(
            Effect.flatMap(() => scoped.advance(input)),
          ),
        claimSweep: scoped.claimSweep,
        listDue: scoped.listDue,
      };
      // Two rows per page against three Attempts that cannot move: the page the listing starts with
      // is entirely theirs, which is the whole point of the scenario.
      const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
        continuation,
        pageLimit: 2,
        staleAfterMillis: 0,
      });

      yield* Effect.forEach(
        ANCIENT_ACTIVITY,
        (activity, index) =>
          startEnrollmentAcceptanceAttempt(
            fixture,
            startInputFor(tenantId, actorPrincipalId, `due-work-${index}`),
          ).pipe(
            Effect.flatMap((attempt) =>
              backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, activity),
            ),
          ),
        { concurrency: 1 },
      );

      // Tick until nothing moves any more: every Attempt the listing offered has spent its whole
      // sweep budget at the revision it is standing at, so the listing stops offering it.
      let settled = false;
      for (let tick = 0; tick < MAX_SWEEP_TICKS && !settled; tick += 1) {
        const sweep = yield* sweeper.sweep;
        settled = sweep.released === 0 && sweep.swept === 0;
      }
      expect(settled).toBe(true);
      const spent = (yield* Ref.get(advanced)).length;

      // A newer Attempt arrives behind them in the journal's oldest-first order. Were the spent rows
      // still offered they would be the tick's whole first page, and a tick that reads one page
      // would never reach this one.
      const fresh = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-fresh'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, fresh.portalEnrollmentAttemptId, NEWER_ACTIVITY);

      const sweep = yield* sweeper.sweep;

      expect(sweep.swept).toBe(1);
      expect((yield* Ref.get(advanced)).slice(spent)).toStrictEqual([fresh.portalEnrollmentAttemptId]);
    }),
  ),
);

/** Longer than this test takes, so only the database's clock decides what is stale here. */
const POLL_STALE_WINDOW_MILLIS = 60_000;

/** How many times the waiting client polls its Attempt before the sweeper's next tick. */
const POLLS_BEFORE_A_TICK = [0, 1, 2] as const;

it.live('re-advances a durably stale Attempt a waiting client keeps polling', () =>
  Effect.scoped(
    Effect.gen(function* pollingDoesNotVetoTheDurableRow() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const scoped = yield* haltingContinuationFor(fixture, tenantId, actorPrincipalId);
      const advanced = yield* Ref.make<readonly string[]>([]);
      const continuation: CommerceEnrollmentContinuationService = {
        advance: (input) =>
          Ref.update(advanced, (ids) => [...ids, input.portalEnrollmentAttemptId]).pipe(
            Effect.flatMap(() => scoped.advance(input)),
          ),
        claimSweep: scoped.claimSweep,
        listDue: scoped.listDue,
      };
      const sweeper = yield* commerceEnrollmentContinuationSweeperFor({
        continuation,
        staleAfterMillis: POLL_STALE_WINDOW_MILLIS,
      });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-polled'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);

      // GET /enrollment/:id resumes a non-terminal Attempt through this very continuation. Each
      // poll halts without moving the Attempt's durable revision or its activity timestamp, and
      // each one refreshes what this process last recorded about it.
      yield* Effect.forEach(
        POLLS_BEFORE_A_TICK,
        () =>
          sweeper.continuation.advance({
            portalEnrollmentAttemptId: attempt.portalEnrollmentAttemptId,
            tenantId,
          }),
        { concurrency: 1 },
      );
      const polled = (yield* Ref.get(advanced)).length;
      expect(polled).toBe(POLLS_BEFORE_A_TICK.length);

      const sweep = yield* sweeper.sweep;

      // The Attempt is exactly as stale as the database says it is, so this tick owes it a sweep.
      // Letting the poll's fresh in-process entry veto the durable row leaves `swept` at 0 and this
      // slice empty: the one caller still waiting on the journey is what stops it advancing.
      expect(sweep.swept).toBe(1);
      expect((yield* Ref.get(advanced)).slice(polled)).toStrictEqual([attempt.portalEnrollmentAttemptId]);
    }),
  ),
);

it.live('the due-work listing answers a worker tick and refuses a caller with a verified Tenant', () =>
  Effect.scoped(
    Effect.gen(function* workerScopeIsRequired() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-scope'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);
      const query = { after: Option.none(), limit: 500, maxSweeps: SWEEP_BUDGET, staleAfterMillis: 0 };
      const ofScenario = (rows: readonly DueEnrollmentAttempt[]) => rows.filter((row) => row.tenantId === tenantId);

      // A worker tick installs no scope at all, and that is the whole credential the routine wants.
      const listed = yield* commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker).listDue(query);
      expect(ofScenario(listed).map((row) => row.portalEnrollmentAttemptId)).toStrictEqual([
        attempt.portalEnrollmentAttemptId,
      ]);

      // The same statement, the same role, the same runtime pool — with the verified Tenant every
      // request installs. Without the guard this reads every other Tenant's Attempts too.
      const refusal = yield* commerceEnrollmentDueAttemptStoreForRun(fixture.runRequestScoped)
        .listDue(query)
        .pipe(Effect.flip);
      expect(refusal.code).toBe('attempt_unavailable');
    }),
  ),
);

it.live('the sweep accounting answers a worker tick and refuses a caller with a verified Tenant', () =>
  Effect.scoped(
    Effect.gen(function* sweepAccountingWorkerScopeIsRequired() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-sweep-scope'),
      );
      const sweep = sweepFor(attempt, tenantId, 0);

      // The accounting writes to the one Attempt surface that answers before any Tenant is known,
      // so it takes the listing's credential: a transaction with no operational scope installed.
      expect(yield* commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker).claimSweep(sweep)).toStrictEqual(
        Option.some(1),
      );

      // The same statement with the verified Tenant every request installs. Without the guard, a
      // request could spend another Tenant's sweep budget and take its Attempts off the listing.
      const refusal = yield* commerceEnrollmentDueAttemptStoreForRun(fixture.runRequestScoped)
        .claimSweep(sweep)
        .pipe(Effect.flip);
      expect(refusal.code).toBe('attempt_unavailable');
    }),
  ),
);

it.live('stops listing an Attempt once its sweep budget is spent, and lists it again once it moves', () =>
  Effect.scoped(
    Effect.gen(function* durableSweepBudgetHoldsAndReleases() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-budget'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);
      const store = commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker);
      const query = { after: Option.none(), limit: 500, maxSweeps: SWEEP_BUDGET, staleAfterMillis: 0 };
      const ofScenario = (rows: readonly DueEnrollmentAttempt[]) => rows.filter((row) => row.tenantId === tenantId);
      // A zero-length claim is released the instant it is taken, so these passes queue rather than
      // contend: this test is about the budget, and the claim has its own tests below.
      const sweep = sweepFor(attempt, tenantId, 0);
      expect(ofScenario(yield* store.listDue(query)).map((row) => row.revision)).toStrictEqual([attempt.revision]);

      // Exactly the budget, every sweep charged against the revision the Attempt is standing at.
      const counted = yield* Effect.forEach(
        Array.from({ length: SWEEP_BUDGET }, (_unused, index) => index),
        () => store.claimSweep(sweep),
        { concurrency: 1 },
      );
      expect(counted).toStrictEqual(Array.from({ length: SWEEP_BUDGET }, (_unused, index) => Option.some(index + 1)));

      // The budget is spent, so the claim itself refuses now rather than charging a ninth pass.
      expect(yield* store.claimSweep(sweep)).toStrictEqual(Option.none());

      // The journal itself withholds the Attempt now. Held in a worker's memory instead, this count
      // would die with the process and the very next listing would hand the budget back in full.
      expect(ofScenario(yield* store.listDue(query))).toStrictEqual([]);

      // Anything that moves the Attempt is the journal's own word that the halt is not the same
      // halt any more, so the budget starts over without a rule that has to predict the movement.
      yield* advanceEnrollmentAcceptanceAttemptRevision(fixture, attempt.portalEnrollmentAttemptId);
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);

      expect(ofScenario(yield* store.listDue(query)).map((row) => row.revision)).toStrictEqual([attempt.revision + 1]);
    }),
  ),
);

it.live('charges exactly one of two replicas bidding for the same sweep', () =>
  Effect.scoped(
    Effect.gen(function* oneClaimPerPass() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-claim-race'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);
      const store = commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker);
      // Both replicas read the same due row and bid for it at the same moment; each bid is its own
      // worker transaction on the shared pool, so they contend on the Attempt row itself.
      const sweep = sweepFor(attempt, tenantId, CLAIM_WINDOW_MILLIS);

      const bids = yield* Effect.forEach([0, 1], () => store.claimSweep(sweep), { concurrency: 2 });

      // Charging before ownership is exactly the defect: two bids would read as two fruitless
      // sweeps and a handful of replicas would exhaust the budget of an Attempt swept once.
      expect(bids.filter(Option.isSome)).toStrictEqual([Option.some(1)]);
      expect(bids.filter(Option.isNone)).toHaveLength(1);
      expect(yield* readEnrollmentAcceptanceSweepCount(fixture, attempt.portalEnrollmentAttemptId)).toBe(1);
    }),
  ),
);

it.live('withholds a claimed Attempt from every listing until the claim expires, then lets it be re-taken', () =>
  Effect.scoped(
    Effect.gen(function* claimHoldsAndExpires() {
      const tenantId = tenant(randomUUID());
      const actorPrincipalId = principalId(randomUUID());
      const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId });
      const attempt = yield* startEnrollmentAcceptanceAttempt(
        fixture,
        startInputFor(tenantId, actorPrincipalId, 'due-work-claim-window'),
      );
      yield* backdateEnrollmentAcceptanceAttempt(fixture, attempt.portalEnrollmentAttemptId, ANCIENT_ACTIVITY[0]);
      const store = commerceEnrollmentDueAttemptStoreForRun(fixture.runWorker);
      const query = { after: Option.none(), limit: 500, maxSweeps: SWEEP_BUDGET, staleAfterMillis: 0 };
      const ofScenario = (rows: readonly DueEnrollmentAttempt[]) => rows.filter((row) => row.tenantId === tenantId);
      expect(ofScenario(yield* store.listDue(query)).map((row) => row.revision)).toStrictEqual([attempt.revision]);

      expect(yield* store.claimSweep(sweepFor(attempt, tenantId, CLAIM_WINDOW_MILLIS))).toStrictEqual(Option.some(1));

      // While the claim stands the row is nobody else's work: it leaves the listing, and a second
      // bid is refused rather than charged.
      expect(ofScenario(yield* store.listDue(query))).toStrictEqual([]);
      expect(yield* store.claimSweep(sweepFor(attempt, tenantId, CLAIM_WINDOW_MILLIS))).toStrictEqual(Option.none());
      expect(yield* readEnrollmentAcceptanceSweepCount(fixture, attempt.portalEnrollmentAttemptId)).toBe(1);

      // The replica holding a claim may be the process that just died, so the claim expires against
      // the database's own clock; the Attempt comes back and the next pass is charged as the second
      // sweep, not the first.
      yield* expireEnrollmentAcceptanceSweepClaim(fixture, attempt.portalEnrollmentAttemptId);

      expect(ofScenario(yield* store.listDue(query)).map((row) => row.revision)).toStrictEqual([attempt.revision]);
      expect(yield* store.claimSweep(sweepFor(attempt, tenantId, CLAIM_WINDOW_MILLIS))).toStrictEqual(Option.some(2));
    }),
  ),
);
