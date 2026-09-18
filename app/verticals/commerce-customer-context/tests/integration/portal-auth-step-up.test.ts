import { Config, DateTime, Effect, Option, Redacted } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import type { CommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { stepUpChallenge, stepUpChallengeAttempt } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { makeCommercePortalAuthStepUpChallengeStore } from '../../api/portal-auth/provider/step-up/index.ts';
import type { CommercePortalAuthStepUpChallengeStore } from '../../api/portal-auth/provider/step-up/index.ts';

const ORIGIN = 'https://portal.example.test';
const SECRET = 's'.repeat(64);
const DATABASE_URL = Config.redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.redacted('DATABASE_URL')),
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
    }),
  );

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
      expect(yield* fixture.store.recordFailure(winner)).toBe(true);
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

      const consumed = yield* Effect.all([fixture.store.consume(first), fixture.store.consume(second)], {
        concurrency: 2,
      });
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
