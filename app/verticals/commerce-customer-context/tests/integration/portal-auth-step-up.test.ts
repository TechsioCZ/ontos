import { Config, DateTime, Effect, Option, Redacted, Result } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { stepUpChallenge, stepUpChallengeAttempt } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { portalAuthAuditEvent } from '../../src/portal-auth/audit/audit-tables.ts';
import { writeCommercePortalAuthAuditRow } from '../../src/portal-auth/audit/audit-transaction.ts';
import type { CommercePortalAuthAuditEvent } from '../../src/portal-auth/audit/audit-contracts.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthStepUpChallengeStore } from '../../api/portal-auth/provider/step-up/index.ts';
import type { CommercePortalAuthStepUpChallengeStore } from '../../api/portal-auth/provider/step-up/index.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);

type ProviderDatabase = (typeof CommercePortalAuthDatabase)['Service'];

interface StepUpStoreFixture {
  readonly challengeHash: string;
  readonly database: ProviderDatabase;
  readonly expiresAt: Date;
  readonly now: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
  readonly store: CommercePortalAuthStepUpChallengeStore;
}

const cleanupChallenge = (fixture: StepUpStoreFixture) =>
  fixture.database.executor.transaction((transaction) =>
    Effect.gen(function* cleanupChallengeEffect() {
      yield* transaction
        .delete(stepUpChallengeAttempt)
        .where(eq(stepUpChallengeAttempt.challengeIdHash, fixture.challengeHash));
      yield* transaction.delete(stepUpChallenge).where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      yield* transaction
        .delete(portalAuthAuditEvent)
        .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.providerSubjectId));
    }),
  );

/**
 * A NUL byte is not representable in a PostgreSQL text value, so the server refuses this row at
 * execution — a real database refusal of the audit insert, raised from inside the same transaction
 * as the challenge mutation, rather than a fault injected into the store's own code.
 */
const REFUSED_BY_POSTGRES = 'step-up-audit-refused\u0000';

const auditEvent = (
  fixture: Pick<StepUpStoreFixture, 'now' | 'providerSubjectId' | 'sessionId'>,
  eventType: CommercePortalAuthAuditEvent['eventType'],
  outcome: CommercePortalAuthAuditEvent['outcome'],
  subjectDigest?: string,
): CommercePortalAuthAuditEvent => {
  const event: CommercePortalAuthAuditEvent = {
    eventType,
    occurredAt: fixture.now,
    operation: 'step-up-test',
    outcome,
    providerSubjectId: fixture.providerSubjectId,
    sessionRef: fixture.sessionId,
  };
  return subjectDigest === undefined ? event : { ...event, subjectDigest };
};

const auditRowsForSubject = (fixture: StepUpStoreFixture) =>
  fixture.database.executor
    .select({ eventType: portalAuthAuditEvent.eventType, outcome: portalAuthAuditEvent.outcome })
    .from(portalAuthAuditEvent)
    .where(eq(portalAuthAuditEvent.providerSubjectId, fixture.providerSubjectId));

const makeFixture = Effect.fn('CommercePortalAuthStepUpIntegration.makeFixture')(function* makeFixtureEffect(
  caseName: string,
): Effect.fn.Return<StepUpStoreFixture, unknown, Scope.Scope> {
  const connectionString = yield* DATABASE_URL;
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(connectionString),
    COMMERCE_PORTAL_AUTH_SECRET: SECRET,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  const database = yield* makeCommercePortalAuthDatabase(configuration);
  const now = yield* DateTime.nowAsDate;
  const fixture: StepUpStoreFixture = {
    challengeHash: `step-up-${caseName}-${randomUUID()}`,
    database,
    expiresAt: new Date(now.getTime() + 60_000),
    now,
    providerSubjectId: `step-up-subject-${randomUUID()}`,
    sessionId: `step-up-session-${randomUUID()}`,
    store: yield* makeCommercePortalAuthStepUpChallengeStore(database.executor),
  };
  yield* Effect.addFinalizer(() => cleanupChallenge(fixture).pipe(Effect.orDie));
  return fixture;
});

const reservationInput = (fixture: StepUpStoreFixture, reservationId: string) => ({
  challengeIdHash: fixture.challengeHash,
  now: fixture.now,
  providerSubjectId: fixture.providerSubjectId,
  reservationId,
  sessionId: fixture.sessionId,
});

it.live('serializes concurrent reservations before any verifier could run', () =>
  Effect.scoped(
    Effect.gen(function* concurrentReservationProof() {
      const fixture = yield* makeFixture('reserve');
      yield* fixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });

      const inputs = [reservationInput(fixture, 'reservation-a'), reservationInput(fixture, 'reservation-b')];
      const results = yield* Effect.all(
        inputs.map((input) => fixture.store.reserveAttempt(input)),
        { concurrency: 2 },
      );
      expect(results.filter(Boolean)).toHaveLength(1);

      const challengeRows = yield* fixture.database.executor
        .select({ attemptsRemaining: stepUpChallenge.attemptsRemaining })
        .from(stepUpChallenge)
        .where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      expect(challengeRows.at(0)?.attemptsRemaining).toBe(0);

      const reservationRows = yield* fixture.database.executor
        .select({ reservationId: stepUpChallengeAttempt.reservationId })
        .from(stepUpChallengeAttempt)
        .where(eq(stepUpChallengeAttempt.challengeIdHash, fixture.challengeHash));
      expect(reservationRows).toHaveLength(1);

      const winnerIndex = results[0] ? 0 : 1;
      const winner = inputs[winnerIndex];
      if (winner === undefined) {
        return yield* Effect.fail(new Error('Reservation result did not identify a winner'));
      }
      expect(
        yield* fixture.store.recordFailure({
          ...winner,
          audit: auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'authentication_failed'),
        }),
      ).toBe(true);
      const afterFailure = yield* fixture.store.findByChallengeIdHash(fixture.challengeHash);
      expect(Option.isSome(afterFailure)).toBe(true);
      if (Option.isSome(afterFailure)) {
        expect(afterFailure.value.attemptsRemaining).toBe(0);
      }
      return yield* Effect.void;
    }),
  ),
);

it.live('consumes one concurrent valid reservation and releases only its exact outage reservation', () =>
  Effect.scoped(
    Effect.gen(function* concurrentConsumeAndReleaseProof() {
      const fixture = yield* makeFixture('consume');
      yield* fixture.store.create({
        attemptsRemaining: 2,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      const first = reservationInput(fixture, 'reservation-c');
      const second = reservationInput(fixture, 'reservation-d');
      expect(yield* fixture.store.reserveAttempt(first)).toBe(true);
      expect(yield* fixture.store.reserveAttempt(second)).toBe(true);

      const consumeAudit = auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'success');
      const consumed = yield* Effect.all(
        [
          fixture.store.consume({ ...first, audit: consumeAudit }),
          fixture.store.consume({ ...second, audit: consumeAudit }),
        ],
        {
          concurrency: 2,
        },
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
      expect(consumed.filter((value) => !value)).toHaveLength(1);

      const challengeRows = yield* fixture.database.executor
        .select({ attemptsRemaining: stepUpChallenge.attemptsRemaining, consumedAt: stepUpChallenge.consumedAt })
        .from(stepUpChallenge)
        .where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      expect(challengeRows.at(0)?.attemptsRemaining).toBe(0);
      expect(challengeRows.at(0)?.consumedAt).not.toBeNull();

      const reservationsAfterConsume = yield* fixture.database.executor
        .select({ reservationId: stepUpChallengeAttempt.reservationId })
        .from(stepUpChallengeAttempt)
        .where(eq(stepUpChallengeAttempt.challengeIdHash, fixture.challengeHash));
      expect(reservationsAfterConsume).toHaveLength(0);

      const releaseFixture = yield* makeFixture('release');
      yield* releaseFixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(releaseFixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: releaseFixture.challengeHash,
        expiresAt: releaseFixture.expiresAt,
        now: releaseFixture.now,
        providerSubjectId: releaseFixture.providerSubjectId,
        sessionId: releaseFixture.sessionId,
      });
      const release = reservationInput(releaseFixture, 'reservation-e');
      expect(yield* releaseFixture.store.reserveAttempt(release)).toBe(true);
      expect(
        yield* releaseFixture.store.releaseAttempt({
          ...release,
          providerSubjectId: `${release.providerSubjectId}-wrong`,
        }),
      ).toBe(false);
      expect(yield* releaseFixture.store.releaseAttempt(release)).toBe(true);
      const released = yield* releaseFixture.store.findByChallengeIdHash(releaseFixture.challengeHash);
      expect(Option.isSome(released)).toBe(true);
      if (Option.isSome(released)) {
        expect(released.value.attemptsRemaining).toBe(1);
      }
    }),
  ),
);

it.live('rolls a challenge creation back when PostgreSQL refuses its audit row', () =>
  Effect.scoped(
    Effect.gen(function* createRollsBackWithoutEvidence() {
      const fixture = yield* makeFixture('create-audit-refused');

      const refused = yield* Effect.result(
        fixture.store.create({
          attemptsRemaining: 1,
          audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success', REFUSED_BY_POSTGRES),
          challengeIdHash: fixture.challengeHash,
          expiresAt: fixture.expiresAt,
          now: fixture.now,
          providerSubjectId: fixture.providerSubjectId,
          sessionId: fixture.sessionId,
        }),
      );
      if (!Result.isFailure(refused)) {
        throw new Error('A challenge creation whose audit row was refused must not report success');
      }
      expect(refused.failure.operation).toBe('challenge-create-audit');

      const challengeRows = yield* fixture.database.executor
        .select({ challengeIdHash: stepUpChallenge.challengeIdHash })
        .from(stepUpChallenge)
        .where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      expect(challengeRows).toStrictEqual([]);
      expect(yield* auditRowsForSubject(fixture)).toStrictEqual([]);
    }),
  ),
);

it.live('rolls a recorded failure back when PostgreSQL refuses its audit row', () =>
  Effect.scoped(
    Effect.gen(function* recordFailureRollsBackWithoutEvidence() {
      const fixture = yield* makeFixture('failure-audit-refused');
      yield* fixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      const reservation = reservationInput(fixture, 'reservation-failure-refused');
      expect(yield* fixture.store.reserveAttempt(reservation)).toBe(true);

      const refused = yield* Effect.result(
        fixture.store.recordFailure({
          ...reservation,
          audit: auditEvent(
            fixture,
            'commerce.portal-auth.step-up-verified.v1',
            'authentication_failed',
            REFUSED_BY_POSTGRES,
          ),
        }),
      );
      if (!Result.isFailure(refused)) {
        throw new Error('A recorded failure whose audit row was refused must not report success');
      }
      expect(refused.failure.operation).toBe('challenge-failure-audit');

      // Nothing committed: the reservation is still there and no evidence was left behind.
      const reservationRows = yield* fixture.database.executor
        .select({ reservationId: stepUpChallengeAttempt.reservationId })
        .from(stepUpChallengeAttempt)
        .where(eq(stepUpChallengeAttempt.challengeIdHash, fixture.challengeHash));
      expect(reservationRows).toStrictEqual([{ reservationId: reservation.reservationId }]);
      expect(yield* auditRowsForSubject(fixture)).toStrictEqual([
        { eventType: 'commerce.portal-auth.step-up-issued.v1', outcome: 'success' },
      ]);
    }),
  ),
);

it.live('rolls a consume back when PostgreSQL refuses its audit row', () =>
  Effect.scoped(
    Effect.gen(function* consumeRollsBackWithoutEvidence() {
      const fixture = yield* makeFixture('consume-audit-refused');
      yield* fixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      const reservation = reservationInput(fixture, 'reservation-consume-refused');
      expect(yield* fixture.store.reserveAttempt(reservation)).toBe(true);

      const refused = yield* Effect.result(
        fixture.store.consume({
          ...reservation,
          audit: auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'success', REFUSED_BY_POSTGRES),
        }),
      );
      if (!Result.isFailure(refused)) {
        throw new Error('A consume whose audit row was refused must not report success');
      }
      expect(refused.failure.operation).toBe('challenge-consume-audit');

      // Nothing committed: the challenge is still unconsumed and its reservation is still live.
      const challengeRows = yield* fixture.database.executor
        .select({ consumedAt: stepUpChallenge.consumedAt })
        .from(stepUpChallenge)
        .where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      expect(challengeRows.at(0)?.consumedAt).toBeNull();
      const reservationRows = yield* fixture.database.executor
        .select({ reservationId: stepUpChallengeAttempt.reservationId })
        .from(stepUpChallengeAttempt)
        .where(eq(stepUpChallengeAttempt.challengeIdHash, fixture.challengeHash));
      expect(reservationRows).toStrictEqual([{ reservationId: reservation.reservationId }]);
      expect(yield* auditRowsForSubject(fixture)).toStrictEqual([
        { eventType: 'commerce.portal-auth.step-up-issued.v1', outcome: 'success' },
      ]);
    }),
  ),
);

it.live('leaves an issued row, a requested row, and a completion row for a full issue-verify-rotate cycle', () =>
  Effect.scoped(
    Effect.gen(function* issueThenVerifyLeavesExactlyOneRowEach() {
      const fixture = yield* makeFixture('issue-verify-cycle');
      yield* fixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      const reservation = reservationInput(fixture, 'reservation-cycle');
      expect(yield* fixture.store.reserveAttempt(reservation)).toBe(true);
      // Mirrors step-up.ts: consume only ever records the intent (code verified, elevation
      // pending). The completion row below stands in for the session store's rotation
      // transaction, which is the only place a `success` row is ever allowed to commit.
      expect(
        yield* fixture.store.consume({
          ...reservation,
          audit: auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'requested'),
        }),
      ).toBe(true);
      yield* fixture.database.executor.transaction((transaction) =>
        writeCommercePortalAuthAuditRow(
          transaction,
          auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'success'),
        ),
      );

      expect(yield* auditRowsForSubject(fixture)).toStrictEqual([
        { eventType: 'commerce.portal-auth.step-up-issued.v1', outcome: 'success' },
        { eventType: 'commerce.portal-auth.step-up-verified.v1', outcome: 'requested' },
        { eventType: 'commerce.portal-auth.step-up-verified.v1', outcome: 'success' },
      ]);
    }),
  ),
);

it.live('leaves the challenge consumed with only a requested row when the rotation never commits its completion', () =>
  Effect.scoped(
    Effect.gen(function* rotationNeverCommittedLeavesOnlyRequested() {
      const fixture = yield* makeFixture('issue-verify-no-rotation');
      yield* fixture.store.create({
        attemptsRemaining: 1,
        audit: auditEvent(fixture, 'commerce.portal-auth.step-up-issued.v1', 'success'),
        challengeIdHash: fixture.challengeHash,
        expiresAt: fixture.expiresAt,
        now: fixture.now,
        providerSubjectId: fixture.providerSubjectId,
        sessionId: fixture.sessionId,
      });
      const reservation = reservationInput(fixture, 'reservation-no-rotation');
      expect(yield* fixture.store.reserveAttempt(reservation)).toBe(true);
      // The challenge is spent the moment consume commits, independent of whatever the caller
      // does next — this is exactly the state left behind when a rotation fails after consume.
      expect(
        yield* fixture.store.consume({
          ...reservation,
          audit: auditEvent(fixture, 'commerce.portal-auth.step-up-verified.v1', 'requested'),
        }),
      ).toBe(true);

      const challengeRows = yield* fixture.database.executor
        .select({ consumedAt: stepUpChallenge.consumedAt })
        .from(stepUpChallenge)
        .where(eq(stepUpChallenge.challengeIdHash, fixture.challengeHash));
      expect(challengeRows.at(0)?.consumedAt).not.toBeNull();
      expect(yield* auditRowsForSubject(fixture)).toStrictEqual([
        { eventType: 'commerce.portal-auth.step-up-issued.v1', outcome: 'success' },
        { eventType: 'commerce.portal-auth.step-up-verified.v1', outcome: 'requested' },
      ]);
    }),
  ),
);
