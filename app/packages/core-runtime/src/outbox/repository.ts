import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { isSqlError } from 'effect/unstable/sql/SqlError';

import { CoreDatabase } from '../db/client.ts';
import {
  actionInvocations,
  domainEvents,
  outboxAttempts,
  outboxDeliveries,
  outboxMessages,
  tenantModuleStates,
  tenants,
  workerCheckpoints,
} from '../db/schema.ts';
import type { CoreTransaction, CoreDatabaseExecutor } from '../db/types.ts';
import { tenantStatesAllowingAccess } from '../modules/module-state-gate.ts';
import type { AnyOutboxWorkerRegistration, OutboxWorkerRetryPolicy, OutboxWorkerSubscription } from './definition.ts';
import { retryBackoffMs } from './definition.ts';
import type { OutboxPersistenceError } from './errors.ts';
import { OutboxClaimLostError, outboxPersistenceError, sanitizeOutboxErrorMessage } from './errors.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });
const BACKGROUND_ELIGIBLE_STATES = tenantStatesAllowingAccess('background');
interface OutboxMatchResult {
  readonly deliveriesCreated: number;
  readonly messagesMatched: number;
}
export interface OutboxClaim {
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly claimId: string;
  readonly consumerModuleKey: string;
  readonly correlationId?: string;
  readonly deliveryId: string;
  readonly domainEventId: string;
  readonly messageId: string;
  readonly payloadJson: unknown;
  readonly producerModuleKey: string;
  readonly retryPolicy: OutboxWorkerRetryPolicy;
  readonly tenantId: string;
  readonly tenantSequenceNo: bigint;
  readonly topic: string;
  readonly workerKey: string;
}
const OutboxFailureStatusSchema = Schema.Literals(['dead', 'pending']);
export type OutboxFailureStatus = typeof OutboxFailureStatusSchema.Type;
export interface OutboxRepositoryService {
  readonly claimNext: (
    registrations: readonly AnyOutboxWorkerRegistration[],
    claimOwner: string,
    now: Date,
  ) => Effect.Effect<Option.Option<OutboxClaim>, OutboxPersistenceError>;
  readonly complete: (
    claim: OutboxClaim,
    now: Date,
  ) => Effect.Effect<void, OutboxClaimLostError | OutboxPersistenceError>;
  readonly fail: (
    claim: OutboxClaim,
    safeErrorMessage: string,
    now: Date,
  ) => Effect.Effect<OutboxFailureStatus, OutboxClaimLostError | OutboxPersistenceError>;
  readonly matchUnmatched: (
    subscriptions: readonly OutboxWorkerSubscription[],
    now: Date,
  ) => Effect.Effect<OutboxMatchResult, OutboxPersistenceError>;
}
export class OutboxRepository extends Context.Service<OutboxRepository, OutboxRepositoryService>()(
  '@app/core-runtime/outbox/repository/OutboxRepository',
) {}
const claimLostOrPersistenceError = <Failure>(error: Failure) =>
  Schema.is(OutboxClaimLostError)(error) ? error : outboxPersistenceError(error);
const OutboxRepositoryInvariantError = Schema.TaggedError<unknown>()('OutboxRepositoryInvariantError', {
  reason: Schema.String,
});
const claimLost = (): OutboxClaimLostError =>
  new OutboxClaimLostError({
    code: 'outbox_claim_lost',
    reason: 'The Outbox delivery claim is no longer owned by this runtime',
  });
const streamKeyFor = (producerModuleKey: string, topic: string): string => `${producerModuleKey}:${topic}`;
const addMilliseconds = (date: Date, milliseconds: number): Date =>
  DateTime.toDateUtc(DateTime.addDuration(DateTime.makeUnsafe(date), milliseconds));
const loadClaimCorrelationId = Effect.fnUntraced(function* loadClaimCorrelationId(
  transaction: CoreTransaction,
  actionInvocationId: string | null,
) {
  if (actionInvocationId === null) {
    return null;
  }
  const [invocation] = yield* transaction
    .select({ correlationId: actionInvocations.correlationId })
    .from(actionInvocations)
    .where(eq(actionInvocations.actionInvocationId, actionInvocationId));
  return invocation?.correlationId;
});

export const makeOutboxRepository = (executor: CoreDatabaseExecutor): OutboxRepositoryService => ({
  claimNext: (registrations, claimOwner, now) => {
    if (registrations.length === 0) {
      return Effect.succeedNone;
    }
    const byWorkerKey = new Map(registrations.map((registration) => [registration.descriptor.workerKey, registration]));
    return executor
      .transaction(
        Effect.fn('claimNextEffect')(function* claimNextEffect(transaction: CoreTransaction) {
          const candidates = yield* transaction
            .select({
              actionInvocationId: domainEvents.actionInvocationId,
              attemptsCount: outboxDeliveries.attemptsCount,
              consumerModuleKey: outboxDeliveries.consumerModuleKey,
              deliveryId: outboxDeliveries.outboxDeliveryId,
              domainEventId: domainEvents.domainEventId,
              messageId: outboxMessages.outboxMessageId,
              payloadJson: outboxMessages.payloadJson,
              producerModuleKey: outboxMessages.producerModuleKey,
              status: outboxDeliveries.status,
              tenantId: outboxMessages.tenantId,
              tenantSequenceNo: domainEvents.tenantSequenceNo,
              topic: outboxMessages.topic,
              workerKey: outboxDeliveries.workerKey,
            })
            .from(outboxDeliveries)
            .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
            .innerJoin(domainEvents, eq(domainEvents.domainEventId, outboxMessages.domainEventId))
            .innerJoin(
              tenantModuleStates,
              and(
                eq(tenantModuleStates.tenantId, outboxMessages.tenantId),
                eq(tenantModuleStates.moduleKey, outboxDeliveries.consumerModuleKey),
                inArray(tenantModuleStates.state, BACKGROUND_ELIGIBLE_STATES),
              ),
            )
            .where(
              and(
                inArray(outboxDeliveries.workerKey, [...byWorkerKey.keys()]),
                or(
                  and(eq(outboxDeliveries.status, 'pending'), lte(outboxDeliveries.availableAt, now)),
                  and(eq(outboxDeliveries.status, 'processing'), lte(outboxDeliveries.claimExpiresAt, now)),
                ),
              ),
            )
            .orderBy(
              asc(outboxDeliveries.availableAt),
              asc(domainEvents.tenantSequenceNo),
              asc(outboxDeliveries.outboxDeliveryId),
            )
            .limit(1)
            .for('update', { skipLocked: true });
          const [candidate] = candidates;
          if (candidate === undefined) {
            return Option.none();
          }
          const registration = byWorkerKey.get(candidate.workerKey);
          if (registration === undefined) {
            return Option.none();
          }
          if (candidate.status === 'processing') {
            yield* transaction
              .update(outboxAttempts)
              .set({
                errorMessage: 'Outbox Worker lease expired before completion',
                finishedAt: now,
              })
              .where(and(eq(outboxAttempts.outboxDeliveryId, candidate.deliveryId), isNull(outboxAttempts.finishedAt)));
          }
          if (candidate.attemptsCount >= registration.descriptor.retryPolicy.maxAttempts) {
            yield* transaction
              .update(outboxDeliveries)
              .set({
                claimedAt: null,
                claimedBy: null,
                claimExpiresAt: null,
                status: 'dead',
                updatedAt: now,
              })
              .where(eq(outboxDeliveries.outboxDeliveryId, candidate.deliveryId));
            return Option.none();
          }
          const claimId = `${claimOwner}:${randomUUID()}`;
          const claimExpiresAt = addMilliseconds(now, registration.descriptor.leaseDurationMs);
          const [claimed] = yield* transaction
            .update(outboxDeliveries)
            .set({
              attemptsCount: sql`${outboxDeliveries.attemptsCount} + 1`,
              claimedAt: now,
              claimedBy: claimId,
              claimExpiresAt,
              status: 'processing',
              updatedAt: now,
            })
            .where(eq(outboxDeliveries.outboxDeliveryId, candidate.deliveryId))
            .returning({ attemptsCount: outboxDeliveries.attemptsCount });
          if (claimed === undefined) {
            return yield* new OutboxRepositoryInvariantError({
              reason: 'Claim update returned no delivery',
            });
          }
          const [attempt] = yield* transaction
            .insert(outboxAttempts)
            .values({ outboxDeliveryId: candidate.deliveryId, startedAt: now })
            .returning({ attemptId: outboxAttempts.outboxAttemptId });
          if (attempt === undefined) {
            return yield* new OutboxRepositoryInvariantError({
              reason: 'Attempt insert returned no row',
            });
          }
          const correlationId = yield* loadClaimCorrelationId(transaction, candidate.actionInvocationId);
          return Option.some(
            withOptionalProperty(
              {
                attemptId: attempt.attemptId,
                attemptNumber: claimed.attemptsCount,
                claimId,
                consumerModuleKey: candidate.consumerModuleKey,
              },
              !(correlationId === null || correlationId === undefined),
              'correlationId',
              correlationId ?? '',
              {
                deliveryId: candidate.deliveryId,
                domainEventId: candidate.domainEventId,
                messageId: candidate.messageId,
                payloadJson: candidate.payloadJson,
                producerModuleKey: candidate.producerModuleKey,
                retryPolicy: registration.descriptor.retryPolicy,
                tenantId: candidate.tenantId,
                tenantSequenceNo: candidate.tenantSequenceNo,
                topic: candidate.topic,
                workerKey: candidate.workerKey,
              },
            ) satisfies OutboxClaim,
          );
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.mapError(outboxPersistenceError),
      );
  },
  complete: (claim, now) =>
    executor
      .transaction(
        Effect.fn('completeEffect')(function* completeEffect(transaction: CoreTransaction) {
          yield* transaction
            .select({ tenantId: tenants.tenantId })
            .from(tenants)
            .where(eq(tenants.tenantId, claim.tenantId))
            .for('update');
          const [owned] = yield* transaction
            .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
            .from(outboxDeliveries)
            .where(
              and(
                eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId),
                eq(outboxDeliveries.status, 'processing'),
                eq(outboxDeliveries.claimedBy, claim.claimId),
              ),
            )
            .for('update');
          if (owned === undefined) {
            return yield* claimLost();
          }
          const finishedAttempts = yield* transaction
            .update(outboxAttempts)
            .set({ finishedAt: now })
            .where(and(eq(outboxAttempts.outboxAttemptId, claim.attemptId), isNull(outboxAttempts.finishedAt)))
            .returning({ attemptId: outboxAttempts.outboxAttemptId });
          if (finishedAttempts.length !== 1) {
            return yield* claimLost();
          }
          const completed = yield* transaction
            .update(outboxDeliveries)
            .set({
              claimedAt: null,
              claimedBy: null,
              claimExpiresAt: null,
              status: 'done',
              updatedAt: now,
            })
            .where(
              and(
                eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId),
                eq(outboxDeliveries.status, 'processing'),
                eq(outboxDeliveries.claimedBy, claim.claimId),
              ),
            )
            .returning({ deliveryId: outboxDeliveries.outboxDeliveryId });
          if (completed.length !== 1) {
            return yield* claimLost();
          }
          const streamKey = streamKeyFor(claim.producerModuleKey, claim.topic);
          const [checkpoint] = yield* transaction
            .select({
              lastTenantSequenceNo: workerCheckpoints.lastTenantSequenceNo,
            })
            .from(workerCheckpoints)
            .where(
              and(
                eq(workerCheckpoints.tenantId, claim.tenantId),
                eq(workerCheckpoints.consumerName, claim.workerKey),
                eq(workerCheckpoints.streamKey, streamKey),
              ),
            )
            .for('update');
          const previous = checkpoint?.lastTenantSequenceNo ?? 0n;
          const streamDeliveries = yield* transaction
            .select({
              status: outboxDeliveries.status,
              tenantSequenceNo: domainEvents.tenantSequenceNo,
            })
            .from(outboxDeliveries)
            .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
            .innerJoin(domainEvents, eq(domainEvents.domainEventId, outboxMessages.domainEventId))
            .where(
              and(
                eq(outboxMessages.tenantId, claim.tenantId),
                eq(outboxDeliveries.workerKey, claim.workerKey),
                eq(outboxMessages.producerModuleKey, claim.producerModuleKey),
                eq(outboxMessages.topic, claim.topic),
                gt(domainEvents.tenantSequenceNo, previous),
              ),
            )
            .orderBy(asc(domainEvents.tenantSequenceNo));
          let nextCheckpoint = previous;
          for (const delivery of streamDeliveries) {
            if (delivery.status !== 'done') {
              break;
            }
            nextCheckpoint = delivery.tenantSequenceNo;
          }
          if (nextCheckpoint > previous) {
            yield* transaction
              .insert(workerCheckpoints)
              .values({
                consumerName: claim.workerKey,
                lastProcessedAt: now,
                lastTenantSequenceNo: nextCheckpoint,
                streamKey,
                tenantId: claim.tenantId,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                set: {
                  lastProcessedAt: now,
                  lastTenantSequenceNo: nextCheckpoint,
                  updatedAt: now,
                },
                target: [workerCheckpoints.tenantId, workerCheckpoints.consumerName, workerCheckpoints.streamKey],
              });
          }
          return yield* Effect.void;
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.mapError(claimLostOrPersistenceError),
      ),
  fail: (claim, safeErrorMessage, now) =>
    executor
      .transaction(
        Effect.fn('failEffect')(function* failEffect(transaction: CoreTransaction) {
          const [owned] = yield* transaction
            .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
            .from(outboxDeliveries)
            .where(
              and(
                eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId),
                eq(outboxDeliveries.status, 'processing'),
                eq(outboxDeliveries.claimedBy, claim.claimId),
              ),
            )
            .for('update');
          if (owned === undefined) {
            return yield* claimLost();
          }
          const finishedAttempts = yield* transaction
            .update(outboxAttempts)
            .set({
              errorMessage: sanitizeOutboxErrorMessage(safeErrorMessage),
              finishedAt: now,
            })
            .where(and(eq(outboxAttempts.outboxAttemptId, claim.attemptId), isNull(outboxAttempts.finishedAt)))
            .returning({ attemptId: outboxAttempts.outboxAttemptId });
          if (finishedAttempts.length !== 1) {
            return yield* claimLost();
          }
          const status: OutboxFailureStatus = claim.attemptNumber >= claim.retryPolicy.maxAttempts ? 'dead' : 'pending';
          const availableAt =
            status === 'dead' ? now : addMilliseconds(now, retryBackoffMs(claim.retryPolicy, claim.attemptNumber));
          const updated = yield* transaction
            .update(outboxDeliveries)
            .set({
              availableAt,
              claimedAt: null,
              claimedBy: null,
              claimExpiresAt: null,
              status,
              updatedAt: now,
            })
            .where(
              and(
                eq(outboxDeliveries.outboxDeliveryId, claim.deliveryId),
                eq(outboxDeliveries.status, 'processing'),
                eq(outboxDeliveries.claimedBy, claim.claimId),
              ),
            )
            .returning({ deliveryId: outboxDeliveries.outboxDeliveryId });
          if (updated.length !== 1) {
            return yield* claimLost();
          }
          return status;
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.mapError(claimLostOrPersistenceError),
      ),
  matchUnmatched: (subscriptions, now) =>
    executor
      .transaction(
        Effect.fn('matchUnmatchedEffect')(function* matchUnmatchedEffect(transaction: CoreTransaction) {
          const messages = yield* transaction
            .select({
              messageId: outboxMessages.outboxMessageId,
              producerModuleKey: outboxMessages.producerModuleKey,
              topic: outboxMessages.topic,
            })
            .from(outboxMessages)
            .where(isNull(outboxMessages.matchedAt))
            .orderBy(asc(outboxMessages.createdAt), asc(outboxMessages.outboxMessageId))
            .limit(100)
            .for('update', { skipLocked: true });
          const matchMessage = Effect.fn('OutboxRepository.matchMessage')(function* matchNextMessage(
            messageIndex: number,
            deliveriesCreated: number,
          ): Effect.fn.Return<number, EffectDrizzleQueryError> {
            const message = messages[messageIndex];
            if (message === undefined) {
              return deliveriesCreated;
            }
            const matches = subscriptions.filter(
              (subscription) =>
                subscription.producerModuleKey === message.producerModuleKey && subscription.topic === message.topic,
            );
            let nextDeliveriesCreated = deliveriesCreated;
            if (matches.length > 0) {
              const inserted = yield* transaction
                .insert(outboxDeliveries)
                .values(
                  matches.map((subscription) => ({
                    consumerModuleKey: subscription.consumerModuleKey,
                    outboxMessageId: message.messageId,
                    workerKey: subscription.workerKey,
                  })),
                )
                .onConflictDoNothing()
                .returning({ deliveryId: outboxDeliveries.outboxDeliveryId });
              nextDeliveriesCreated += inserted.length;
            }
            yield* transaction
              .update(outboxMessages)
              .set({ matchedAt: now })
              .where(and(eq(outboxMessages.outboxMessageId, message.messageId), isNull(outboxMessages.matchedAt)));
            return yield* matchMessage(messageIndex + 1, nextDeliveriesCreated);
          });
          const deliveriesCreated = yield* matchMessage(0, 0);
          return { deliveriesCreated, messagesMatched: messages.length };
        }),
      )
      .pipe(
        Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
        Effect.mapError(outboxPersistenceError),
      ),
});
export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* makeOutboxRepositoryService() {
    const database = yield* CoreDatabase;
    return makeOutboxRepository(database.executor);
  }),
);
