import { and, eq, isNull } from 'drizzle-orm';
import { DateTime, Effect, Layer, Option } from 'effect';

import type { CommercePortalAuthStepUpChallengeRecord } from '../../../api/portal-auth/provider/step-up/contracts.ts';
import { CommercePortalAuthStepUpChallengeStoreService } from '../../../api/portal-auth/provider/step-up/challenge-store-service.ts';
import type { CommercePortalAuthStepUpChallengeStore } from '../../../api/portal-auth/provider/step-up/challenge-store-service.ts';
import type { CommercePortalAuthStepUpUnavailable } from '../../../api/portal-auth/provider/step-up/unavailable.ts';
import { CommercePortalAuthStepUpUnavailable as StepUpUnavailable } from '../../../api/portal-auth/provider/step-up/unavailable.ts';
import { COMMERCE_PORTAL_AUTH_POLICY } from '../../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthDatabase } from './portal-auth-database.ts';
import type { CommercePortalAuthDatabaseExecutor } from './portal-auth-database-types.ts';
import { stepUpChallenge, stepUpChallengeAttempt } from './portal-auth-tables.ts';

const withCause = <TError extends object>(error: TError, cause: unknown): TError =>
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });

const unavailable = (operation: string, cause: unknown): CommercePortalAuthStepUpUnavailable =>
  withCause(
    new StepUpUnavailable({
      operation,
      reason: `Commerce portal step-up ${operation} could not complete`,
    }),
    cause,
  );

const epochMillis = (value: Date): number => {
  const date = DateTime.make(value);
  return Option.isSome(date) ? DateTime.toEpochMillis(date.value) : Number.NaN;
};

const exactChallengeBinding = (
  input: Readonly<{
    readonly challengeIdHash: string;
    readonly providerSubjectId: string;
    readonly sessionId: string;
  }>,
) =>
  and(
    eq(stepUpChallenge.challengeIdHash, input.challengeIdHash),
    eq(stepUpChallenge.providerSubjectId, input.providerSubjectId),
    eq(stepUpChallenge.sessionId, input.sessionId),
  );

const exactReservation = (
  input: Readonly<{
    readonly challengeIdHash: string;
    readonly providerSubjectId: string;
    readonly reservationId: string;
    readonly sessionId: string;
  }>,
) =>
  and(
    eq(stepUpChallengeAttempt.reservationId, input.reservationId),
    eq(stepUpChallengeAttempt.challengeIdHash, input.challengeIdHash),
    eq(stepUpChallengeAttempt.providerSubjectId, input.providerSubjectId),
    eq(stepUpChallengeAttempt.sessionId, input.sessionId),
  );

const isActiveChallenge = (
  challenge: Readonly<{
    readonly consumedAt: Date | null;
    readonly expiresAt: Date;
  }>,
  now: Date,
): boolean => challenge.consumedAt === null && epochMillis(challenge.expiresAt) > epochMillis(now);

const selectChallenge = (executor: CommercePortalAuthDatabaseExecutor, challengeIdHash: string) =>
  executor
    .select({
      attemptsRemaining: stepUpChallenge.attemptsRemaining,
      challengeIdHash: stepUpChallenge.challengeIdHash,
      consumedAt: stepUpChallenge.consumedAt,
      expiresAt: stepUpChallenge.expiresAt,
      providerSubjectId: stepUpChallenge.providerSubjectId,
      sessionId: stepUpChallenge.sessionId,
    })
    .from(stepUpChallenge)
    .where(eq(stepUpChallenge.challengeIdHash, challengeIdHash))
    .limit(1);

const toChallengeRecord = (row: {
  readonly attemptsRemaining: number;
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
  readonly providerSubjectId: string;
  readonly sessionId: string;
}): CommercePortalAuthStepUpChallengeRecord => ({
  attemptsRemaining: row.attemptsRemaining,
  consumedAt: row.consumedAt,
  expiresAt: row.expiresAt,
  providerSubjectId: row.providerSubjectId,
  sessionId: row.sessionId,
});

export const makeCommercePortalAuthStepUpChallengeStore = Effect.fn('CommercePortalAuthStepUpChallengeStore.make')(
  function* makeCommercePortalAuthStepUpChallengeStoreEffect(
    database: CommercePortalAuthDatabaseExecutor,
  ): Effect.fn.Return<CommercePortalAuthStepUpChallengeStore> {
    const consume = Effect.fn('CommercePortalAuthStepUpChallengeStore.consume')(function* consumeEffect(input: {
      readonly challengeIdHash: string;
      readonly now: Date;
      readonly providerSubjectId: string;
      readonly reservationId: string;
      readonly sessionId: string;
    }): Effect.fn.Return<boolean, CommercePortalAuthStepUpUnavailable> {
      return yield* database
        .transaction(
          Effect.fn('CommercePortalAuthStepUpChallengeStore.consume.transaction')(
            function* consumeTransaction(transaction) {
              const challenges = yield* transaction
                .select({
                  attemptsRemaining: stepUpChallenge.attemptsRemaining,
                  consumedAt: stepUpChallenge.consumedAt,
                  expiresAt: stepUpChallenge.expiresAt,
                  providerSubjectId: stepUpChallenge.providerSubjectId,
                  sessionId: stepUpChallenge.sessionId,
                })
                .from(stepUpChallenge)
                .where(eq(stepUpChallenge.challengeIdHash, input.challengeIdHash))
                .limit(1)
                .for('update');
              const challenge = challenges.at(0);
              const reservations = yield* Effect.succeed(challenges).pipe(
                Effect.andThen(
                  transaction
                    .select({ reservationId: stepUpChallengeAttempt.reservationId })
                    .from(stepUpChallengeAttempt)
                    .where(exactReservation(input))
                    .limit(1)
                    .for('update'),
                ),
              );
              if (reservations.length === 0) {
                return false;
              }

              const valid =
                challenge !== undefined &&
                challenge.providerSubjectId === input.providerSubjectId &&
                challenge.sessionId === input.sessionId &&
                isActiveChallenge(challenge, input.now);
              const consumed = valid
                ? yield* transaction
                    .update(stepUpChallenge)
                    .set({ consumedAt: input.now, updatedAt: input.now })
                    .where(and(exactChallengeBinding(input), isNull(stepUpChallenge.consumedAt)))
                    .returning({ challengeIdHash: stepUpChallenge.challengeIdHash })
                : [];
              yield* transaction
                .delete(stepUpChallengeAttempt)
                .where(eq(stepUpChallengeAttempt.reservationId, input.reservationId));
              return consumed.length === 1;
            },
          ),
        )
        .pipe(Effect.mapError((cause) => unavailable('challenge-consume', cause)));
    });

    const create = Effect.fn('CommercePortalAuthStepUpChallengeStore.create')(function* createEffect(input: {
      readonly attemptsRemaining: number;
      readonly challengeIdHash: string;
      readonly expiresAt: Date;
      readonly now: Date;
      readonly providerSubjectId: string;
      readonly sessionId: string;
    }): Effect.fn.Return<void, CommercePortalAuthStepUpUnavailable> {
      // At most one challenge is live per session: a freshly minted challenge supersedes every
      // unconsumed predecessor of the same subject and session, so a caller cannot hold several
      // concurrent challenges — each with its own attempt budget — against one session.
      yield* database
        .transaction(
          Effect.fn('CommercePortalAuthStepUpChallengeStore.create.transaction')(
            function* createTransaction(transaction) {
              yield* transaction
                .delete(stepUpChallenge)
                .where(
                  and(
                    eq(stepUpChallenge.providerSubjectId, input.providerSubjectId),
                    eq(stepUpChallenge.sessionId, input.sessionId),
                    isNull(stepUpChallenge.consumedAt),
                  ),
                );
              yield* transaction.insert(stepUpChallenge).values({
                attemptsRemaining: input.attemptsRemaining,
                challengeIdHash: input.challengeIdHash,
                consumedAt: null,
                createdAt: input.now,
                expiresAt: input.expiresAt,
                providerSubjectId: input.providerSubjectId,
                sessionId: input.sessionId,
                updatedAt: input.now,
              });
            },
          ),
        )
        .pipe(Effect.mapError((cause) => unavailable('challenge-create', cause)));
    });

    const findByChallengeIdHash = Effect.fn('CommercePortalAuthStepUpChallengeStore.findByChallengeIdHash')(
      function* findByChallengeIdHashEffect(
        challengeIdHash: string,
      ): Effect.fn.Return<Option.Option<CommercePortalAuthStepUpChallengeRecord>, CommercePortalAuthStepUpUnavailable> {
        const rows = yield* selectChallenge(database, challengeIdHash).pipe(
          Effect.mapError((cause) => unavailable('challenge-read', cause)),
        );
        const row = rows.at(0);
        return row === undefined ? Option.none() : Option.some(toChallengeRecord(row));
      },
    );

    const recordFailure = Effect.fn('CommercePortalAuthStepUpChallengeStore.recordFailure')(
      function* recordFailureEffect(input: {
        readonly challengeIdHash: string;
        readonly now: Date;
        readonly providerSubjectId: string;
        readonly reservationId: string;
        readonly sessionId: string;
      }): Effect.fn.Return<boolean, CommercePortalAuthStepUpUnavailable> {
        return yield* database
          .delete(stepUpChallengeAttempt)
          .where(exactReservation(input))
          .returning({ reservationId: stepUpChallengeAttempt.reservationId })
          .pipe(
            Effect.map((rows) => rows.length === 1),
            Effect.mapError((cause) => unavailable('challenge-failure', cause)),
          );
      },
    );

    const releaseAttempt = Effect.fn('CommercePortalAuthStepUpChallengeStore.releaseAttempt')(
      function* releaseAttemptEffect(input: {
        readonly challengeIdHash: string;
        readonly now: Date;
        readonly providerSubjectId: string;
        readonly reservationId: string;
        readonly sessionId: string;
      }): Effect.fn.Return<boolean, CommercePortalAuthStepUpUnavailable> {
        return yield* database
          .transaction(
            Effect.fn('CommercePortalAuthStepUpChallengeStore.releaseAttempt.transaction')(
              function* releaseAttemptTransaction(transaction) {
                const challenges = yield* transaction
                  .select({
                    attemptsRemaining: stepUpChallenge.attemptsRemaining,
                    consumedAt: stepUpChallenge.consumedAt,
                    expiresAt: stepUpChallenge.expiresAt,
                    providerSubjectId: stepUpChallenge.providerSubjectId,
                    sessionId: stepUpChallenge.sessionId,
                  })
                  .from(stepUpChallenge)
                  .where(eq(stepUpChallenge.challengeIdHash, input.challengeIdHash))
                  .limit(1)
                  .for('update');
                const reservations = yield* Effect.succeed(challenges).pipe(
                  Effect.andThen(
                    transaction
                      .select({ reservationId: stepUpChallengeAttempt.reservationId })
                      .from(stepUpChallengeAttempt)
                      .where(exactReservation(input))
                      .limit(1)
                      .for('update'),
                  ),
                );
                if (reservations.length === 0) {
                  return false;
                }
                yield* transaction
                  .delete(stepUpChallengeAttempt)
                  .where(eq(stepUpChallengeAttempt.reservationId, input.reservationId));
                const challenge = challenges.at(0);
                if (
                  challenge === undefined ||
                  challenge.providerSubjectId !== input.providerSubjectId ||
                  challenge.sessionId !== input.sessionId ||
                  !isActiveChallenge(challenge, input.now)
                ) {
                  return true;
                }
                yield* transaction
                  .update(stepUpChallenge)
                  .set({
                    attemptsRemaining: Math.min(
                      challenge.attemptsRemaining + 1,
                      COMMERCE_PORTAL_AUTH_POLICY.mfa.maxAttempts,
                    ),
                    updatedAt: input.now,
                  })
                  .where(exactChallengeBinding(input));
                return true;
              },
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('challenge-release', cause)));
      },
    );

    const reserveAttempt = Effect.fn('CommercePortalAuthStepUpChallengeStore.reserveAttempt')(
      function* reserveAttemptEffect(input: {
        readonly challengeIdHash: string;
        readonly now: Date;
        readonly providerSubjectId: string;
        readonly reservationId: string;
        readonly sessionId: string;
      }): Effect.fn.Return<boolean, CommercePortalAuthStepUpUnavailable> {
        return yield* database
          .transaction(
            Effect.fn('CommercePortalAuthStepUpChallengeStore.reserveAttempt.transaction')(
              function* reserveAttemptTransaction(transaction) {
                const challenges = yield* transaction
                  .select({
                    attemptsRemaining: stepUpChallenge.attemptsRemaining,
                    consumedAt: stepUpChallenge.consumedAt,
                    expiresAt: stepUpChallenge.expiresAt,
                    providerSubjectId: stepUpChallenge.providerSubjectId,
                    sessionId: stepUpChallenge.sessionId,
                  })
                  .from(stepUpChallenge)
                  .where(eq(stepUpChallenge.challengeIdHash, input.challengeIdHash))
                  .limit(1)
                  .for('update');
                const challenge = challenges.at(0);
                if (
                  challenge === undefined ||
                  challenge.providerSubjectId !== input.providerSubjectId ||
                  challenge.sessionId !== input.sessionId ||
                  challenge.attemptsRemaining <= 0 ||
                  !isActiveChallenge(challenge, input.now)
                ) {
                  return false;
                }
                yield* transaction
                  .update(stepUpChallenge)
                  .set({ attemptsRemaining: challenge.attemptsRemaining - 1, updatedAt: input.now })
                  .where(exactChallengeBinding(input));
                yield* transaction.insert(stepUpChallengeAttempt).values({
                  challengeIdHash: input.challengeIdHash,
                  providerSubjectId: input.providerSubjectId,
                  reservationId: input.reservationId,
                  reservedAt: input.now,
                  sessionId: input.sessionId,
                });
                return true;
              },
            ),
          )
          .pipe(Effect.mapError((cause) => unavailable('challenge-reserve', cause)));
      },
    );

    return yield* Effect.succeed({
      consume,
      create,
      findByChallengeIdHash,
      recordFailure,
      releaseAttempt,
      reserveAttempt,
    });
  },
);

/** The provider database stays a visible requirement; the composition root supplies it once. */
export const CommercePortalAuthStepUpChallengeStoreLive = Layer.effect(
  CommercePortalAuthStepUpChallengeStoreService,
  Effect.gen(function* makeStepUpChallengeStoreLive() {
    const database = yield* CommercePortalAuthDatabase;
    return yield* makeCommercePortalAuthStepUpChallengeStore(database.executor);
  }),
);
