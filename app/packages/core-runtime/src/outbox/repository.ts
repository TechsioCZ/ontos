/* eslint-disable no-await-in-loop, sort-keys -- Matching mutates each locked message in order, and service methods follow the lifecycle. */
// @effect-diagnostics asyncFunction:off globalDate:off instanceOfSchema:off
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
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
import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerRetryPolicy,
  OutboxWorkerSubscription,
} from './definition.ts';
import { retryBackoffMs } from './definition.ts';
import {
  OutboxClaimLostError,
  outboxPersistenceError,
  sanitizeOutboxErrorMessage,
} from './errors.ts';
import type { OutboxPersistenceError } from './errors.ts';

export interface OutboxMatchResult {
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

export type OutboxFailureStatus = 'dead' | 'pending';

export interface OutboxRepositoryService {
  readonly claimNext: (
    registrations: readonly AnyOutboxWorkerRegistration[],
    claimOwner: string,
    now: Date,
  ) => Effect.Effect<OutboxClaim | null, OutboxPersistenceError>;
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

const persistenceEffect = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({ catch: outboxPersistenceError, try: operation });

const persistenceOrClaimLostEffect = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof OutboxClaimLostError ? error : outboxPersistenceError(error),
    try: operation,
  });

const claimLost = (): OutboxClaimLostError =>
  new OutboxClaimLostError({
    code: 'outbox_claim_lost',
    reason: 'The Outbox delivery claim is no longer owned by this runtime',
  });

const streamKeyFor = (producerModuleKey: string, topic: string): string =>
  `${producerModuleKey}:${topic}`;

export const makeOutboxRepository = (
  database: Context.Service.Shape<typeof CoreDatabase>,
): OutboxRepositoryService => ({
  matchUnmatched: (subscriptions, now) =>
    persistenceEffect(() =>
      database.executor.transaction(async (transaction) => {
        const messages = await transaction
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
        let deliveriesCreated = 0;
        for (const message of messages) {
          const matches = subscriptions.filter(
            (subscription) =>
              subscription.producerModuleKey === message.producerModuleKey &&
              subscription.topic === message.topic,
          );
          if (matches.length > 0) {
            const inserted = await transaction
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
            deliveriesCreated += inserted.length;
          }
          await transaction
            .update(outboxMessages)
            .set({ matchedAt: now })
            .where(
              and(
                eq(outboxMessages.outboxMessageId, message.messageId),
                isNull(outboxMessages.matchedAt),
              ),
            );
        }
        return { deliveriesCreated, messagesMatched: messages.length };
      }),
    ),

  claimNext: (registrations, claimOwner, now) => {
    if (registrations.length === 0) {
      return Effect.succeed(null);
    }
    const byWorkerKey = new Map(
      registrations.map((registration) => [registration.descriptor.workerKey, registration]),
    );
    return persistenceEffect(() =>
      database.executor.transaction(async (transaction) => {
        const candidates = await transaction
          .select({
            attemptsCount: outboxDeliveries.attemptsCount,
            consumerModuleKey: outboxDeliveries.consumerModuleKey,
            actionInvocationId: domainEvents.actionInvocationId,
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
          .innerJoin(
            outboxMessages,
            eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
          )
          .innerJoin(domainEvents, eq(domainEvents.domainEventId, outboxMessages.domainEventId))
          .innerJoin(
            tenantModuleStates,
            and(
              eq(tenantModuleStates.tenantId, outboxMessages.tenantId),
              eq(tenantModuleStates.moduleKey, outboxDeliveries.consumerModuleKey),
              eq(tenantModuleStates.state, 'active'),
            ),
          )
          .where(
            and(
              inArray(outboxDeliveries.workerKey, [...byWorkerKey.keys()]),
              or(
                and(eq(outboxDeliveries.status, 'pending'), lte(outboxDeliveries.availableAt, now)),
                and(
                  eq(outboxDeliveries.status, 'processing'),
                  lte(outboxDeliveries.claimExpiresAt, now),
                ),
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
          return null;
        }
        const registration = byWorkerKey.get(candidate.workerKey);
        if (registration === undefined) {
          return null;
        }
        if (candidate.status === 'processing') {
          await transaction
            .update(outboxAttempts)
            .set({
              errorMessage: 'Outbox Worker lease expired before completion',
              finishedAt: now,
            })
            .where(
              and(
                eq(outboxAttempts.outboxDeliveryId, candidate.deliveryId),
                isNull(outboxAttempts.finishedAt),
              ),
            );
        }
        if (candidate.attemptsCount >= registration.descriptor.retryPolicy.maxAttempts) {
          await transaction
            .update(outboxDeliveries)
            .set({
              claimExpiresAt: null,
              claimedAt: null,
              claimedBy: null,
              status: 'dead',
              updatedAt: now,
            })
            .where(eq(outboxDeliveries.outboxDeliveryId, candidate.deliveryId));
          return null;
        }
        const claimId = `${claimOwner}:${randomUUID()}`;
        const claimExpiresAt = new Date(now.getTime() + registration.descriptor.leaseDurationMs);
        const [claimed] = await transaction
          .update(outboxDeliveries)
          .set({
            attemptsCount: sql`${outboxDeliveries.attemptsCount} + 1`,
            claimExpiresAt,
            claimedAt: now,
            claimedBy: claimId,
            status: 'processing',
            updatedAt: now,
          })
          .where(eq(outboxDeliveries.outboxDeliveryId, candidate.deliveryId))
          .returning({ attemptsCount: outboxDeliveries.attemptsCount });
        if (claimed === undefined) {
          throw new Error('claim update returned no delivery');
        }
        const [attempt] = await transaction
          .insert(outboxAttempts)
          .values({ outboxDeliveryId: candidate.deliveryId, startedAt: now })
          .returning({ attemptId: outboxAttempts.outboxAttemptId });
        if (attempt === undefined) {
          throw new Error('attempt insert returned no row');
        }
        const [invocation] =
          candidate.actionInvocationId === null
            ? []
            : await transaction
                .select({ correlationId: actionInvocations.correlationId })
                .from(actionInvocations)
                .where(eq(actionInvocations.actionInvocationId, candidate.actionInvocationId));
        return {
          attemptId: attempt.attemptId,
          attemptNumber: claimed.attemptsCount,
          claimId,
          consumerModuleKey: candidate.consumerModuleKey,
          ...(invocation?.correlationId === null || invocation?.correlationId === undefined
            ? {}
            : { correlationId: invocation.correlationId }),
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
        } satisfies OutboxClaim;
      }),
    );
  },

  complete: (claim, now) =>
    persistenceOrClaimLostEffect(() =>
      database.executor.transaction(async (transaction) => {
        await transaction
          .select({ tenantId: tenants.tenantId })
          .from(tenants)
          .where(eq(tenants.tenantId, claim.tenantId))
          .for('update');
        const [owned] = await transaction
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
          throw claimLost();
        }
        const finishedAttempts = await transaction
          .update(outboxAttempts)
          .set({ finishedAt: now })
          .where(
            and(
              eq(outboxAttempts.outboxAttemptId, claim.attemptId),
              isNull(outboxAttempts.finishedAt),
            ),
          )
          .returning({ attemptId: outboxAttempts.outboxAttemptId });
        if (finishedAttempts.length !== 1) {
          throw claimLost();
        }
        const completed = await transaction
          .update(outboxDeliveries)
          .set({
            claimExpiresAt: null,
            claimedAt: null,
            claimedBy: null,
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
          throw claimLost();
        }

        const streamKey = streamKeyFor(claim.producerModuleKey, claim.topic);
        const [checkpoint] = await transaction
          .select({ lastTenantSequenceNo: workerCheckpoints.lastTenantSequenceNo })
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
        const streamDeliveries = await transaction
          .select({
            status: outboxDeliveries.status,
            tenantSequenceNo: domainEvents.tenantSequenceNo,
          })
          .from(outboxDeliveries)
          .innerJoin(
            outboxMessages,
            eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId),
          )
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
          await transaction
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
              target: [
                workerCheckpoints.tenantId,
                workerCheckpoints.consumerName,
                workerCheckpoints.streamKey,
              ],
            });
        }
      }),
    ),

  fail: (claim, safeErrorMessage, now) =>
    persistenceOrClaimLostEffect(() =>
      database.executor.transaction(async (transaction) => {
        const [owned] = await transaction
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
          throw claimLost();
        }
        const finishedAttempts = await transaction
          .update(outboxAttempts)
          .set({
            errorMessage: sanitizeOutboxErrorMessage(safeErrorMessage),
            finishedAt: now,
          })
          .where(
            and(
              eq(outboxAttempts.outboxAttemptId, claim.attemptId),
              isNull(outboxAttempts.finishedAt),
            ),
          )
          .returning({ attemptId: outboxAttempts.outboxAttemptId });
        if (finishedAttempts.length !== 1) {
          throw claimLost();
        }
        const status: OutboxFailureStatus =
          claim.attemptNumber >= claim.retryPolicy.maxAttempts ? 'dead' : 'pending';
        const availableAt =
          status === 'dead'
            ? now
            : new Date(now.getTime() + retryBackoffMs(claim.retryPolicy, claim.attemptNumber));
        const updated = await transaction
          .update(outboxDeliveries)
          .set({
            availableAt,
            claimExpiresAt: null,
            claimedAt: null,
            claimedBy: null,
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
          throw claimLost();
        }
        return status;
      }),
    ),
});

export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* makeOutboxRepositoryService() {
    const database = yield* CoreDatabase;
    return makeOutboxRepository(database);
  }),
);
