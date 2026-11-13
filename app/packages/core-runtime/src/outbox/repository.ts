import { attestNativeOutboxClaim, prepareNativeOutboxClaimAdmission } from './worker-runtime-binding.ts';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import type { SQL } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { isSqlError } from 'effect/sql/SqlError';

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
import type { CoreTransaction, CoreDbExecutor } from '../db/types.ts';
import { tenantStatesAllowingAccess } from '../modules/module-state-gate.ts';
import {
  ApplicationCompositionAuthorityError,
  lockApplicationCompositionAuthority,
} from '../modules/application-composition-authority.ts';
import type { AnyOutboxWorkerRegistration, OutboxWorkerRetryPolicy } from './definition.ts';
import { retryBackoffMs } from './definition.ts';
import { PersistenceFailure } from '../database/persistence-failure.ts';
import { OutboxClaimLostError, sanitizeOutboxErrorMessage } from './errors.ts';

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
  readonly actorPrincipalId?: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly claimId: string;
  readonly consumerModuleKey: string;
  readonly correlationId?: string;
  readonly deliveryId: string;
  readonly domainEventId: string;
  readonly messageId: string;
  readonly originatorInvocationId?: string;
  /** The company (Legal Entity) the event's action invocation acted in; absent for a tenant-level event. */
  readonly originatorLegalEntityId?: string;
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
    compositionRevision: string,
  ) => Effect.Effect<Option.Option<OutboxClaim>, ApplicationCompositionAuthorityError | PersistenceFailure>;
  readonly complete: (claim: OutboxClaim, now: Date) => Effect.Effect<void, OutboxClaimLostError | PersistenceFailure>;
  readonly fail: (
    claim: OutboxClaim,
    safeErrorMessage: string,
    now: Date,
    wakeAt?: Date,
  ) => Effect.Effect<OutboxFailureStatus, OutboxClaimLostError | PersistenceFailure>;
  readonly matchUnmatched: (
    compositionRevision: string,
    now: Date,
  ) => Effect.Effect<OutboxMatchResult, ApplicationCompositionAuthorityError | PersistenceFailure>;
}
export class OutboxRepository extends Context.Service<OutboxRepository, OutboxRepositoryService>()(
  '@app/core-runtime/outbox/repository/OutboxRepository',
) {}
const outboxPersistenceFailure = <FailureCause>(cause: FailureCause): PersistenceFailure =>
  new PersistenceFailure({ cause, reason: 'The Outbox Worker persistence operation failed' });
const claimLostOrPersistenceError = <Failure>(error: Failure) =>
  Schema.is(OutboxClaimLostError)(error) ? error : outboxPersistenceFailure(error);
const compositionAuthorityOrPersistenceError = <Failure>(error: Failure) =>
  Schema.is(ApplicationCompositionAuthorityError)(error) ? error : outboxPersistenceFailure(error);
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
const loadClaimInvocationEvidence = Effect.fnUntraced(function* loadClaimInvocationEvidence(
  transaction: CoreTransaction,
  actionInvocationId: string | null,
  tenantId: string,
) {
  if (actionInvocationId === null) {
    return {} as const;
  }
  const [invocation] = yield* transaction
    .select({
      actorPrincipalId: actionInvocations.principalId,
      correlationId: actionInvocations.correlationId,
    })
    .from(actionInvocations)
    .where(and(eq(actionInvocations.actionInvocationId, actionInvocationId), eq(actionInvocations.tenantId, tenantId)));
  // The event's own action invocation is the originator of asynchronous work: a call it makes acts for that requester (D7).
  const originated = { originatorInvocationId: actionInvocationId };
  if (invocation === undefined) {
    return originated;
  }
  return withOptionalProperty(
    withOptionalProperty(
      originated,
      invocation.actorPrincipalId !== null,
      'actorPrincipalId',
      invocation.actorPrincipalId ?? '',
      {},
    ),
    invocation.correlationId !== null,
    'correlationId',
    invocation.correlationId ?? '',
    {},
  );
});

/** A background-eligible consumer state of the message's tenant; shared by the claim and its idle probe. */
const backgroundEligibleConsumer = and(
  eq(tenantModuleStates.tenantId, outboxMessages.tenantId),
  eq(tenantModuleStates.moduleKey, outboxDeliveries.consumerModuleKey),
  inArray(tenantModuleStates.state, BACKGROUND_ELIGIBLE_STATES),
);
// A tenant that is no longer active must not have background work claimed at all. This is a predicate rather than a
// join on purpose: `.for('update')` in the claim locks every row named in the FROM list, and `core.tenants` is the
// per-tenant serialization anchor held FOR UPDATE by every event-emitting action, so joining it would make claim
// transactions contend with ordinary writes. Keeping ineligible deliveries pending means resuming the work resumes with
// the tenant; for an archived tenant, which is terminal, they stay pending rather than being retried, and cancelling
// them belongs with the archive procedure that changes the status.
const activeMessageTenant = sql`exists (select 1 from ${tenants} where ${tenants.tenantId} = ${outboxMessages.tenantId} and ${tenants.status} = 'active')`;
const dueDelivery = (now: Date) =>
  or(
    and(eq(outboxDeliveries.status, 'pending'), lte(outboxDeliveries.availableAt, now)),
    and(eq(outboxDeliveries.status, 'processing'), lte(outboxDeliveries.claimExpiresAt, now)),
  );

/**
 * Each worker's intrinsic providers are active for the message's tenant. The claim and its idle probe share this, so a
 * delivery held back by an inactive provider is not work: it neither makes every poll take the fence nor is claimed.
 */
const intrinsicProvidersActive = (
  registrations: readonly AnyOutboxWorkerRegistration[],
  intrinsic: ReadonlyMap<string, readonly string[]>,
) =>
  or(
    ...registrations.map((registration) =>
      and(
        eq(outboxDeliveries.workerKey, registration.descriptor.workerKey),
        ...(intrinsic.get(registration.descriptor.consumerModuleKey) ?? []).map(
          (provider) =>
            sql`exists (select 1 from ${tenantModuleStates} where ${tenantModuleStates.tenantId} = ${outboxMessages.tenantId} and ${tenantModuleStates.moduleKey} = ${provider} and ${tenantModuleStates.state} = 'active')`,
        ),
      ),
    ),
  );

const probeFailure = <Value, Failure, Requirements>(effect: Effect.Effect<Value, Failure, Requirements>) =>
  effect.pipe(
    Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
    Effect.mapError(outboxPersistenceFailure),
  );

/**
 * Whether any of these admitted workers' deliveries could be claimed now. It reads committed rows without the
 * composition fence, so an idle poll costs this one statement instead of a fenced transaction. It asks exactly the
 * claim's question without its row lock and order: a delivery the claim would refuse (an inactive tenant, consumer or
 * intrinsic provider) must not keep every poll on the fenced path. Every claim still takes the fence, admits the
 * revision and re-checks every predicate under its row lock. A delivery that becomes due after the probe is claimed by
 * the next poll.
 */
const hasDueDelivery = Effect.fnUntraced(
  function* hasDueDelivery(
    executor: CoreDbExecutor,
    claimable: SQL | undefined,
    workerKeys: readonly string[],
    now: Date,
  ) {
    const rows = yield* executor
      .select({ deliveryId: outboxDeliveries.outboxDeliveryId })
      .from(outboxDeliveries)
      .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
      .innerJoin(tenantModuleStates, backgroundEligibleConsumer)
      .where(
        and(inArray(outboxDeliveries.workerKey, [...workerKeys]), claimable, activeMessageTenant, dueDelivery(now)),
      )
      .limit(1);
    return rows.length > 0;
  },
  (effect) => effect.pipe(probeFailure),
);

/** Whether any message awaits matching; read without the fence, which only the match transaction itself takes. */
const hasUnmatchedMessage = Effect.fnUntraced(
  function* hasUnmatchedMessage(executor: CoreDbExecutor) {
    const rows = yield* executor
      .select({ messageId: outboxMessages.outboxMessageId })
      .from(outboxMessages)
      .where(isNull(outboxMessages.matchedAt))
      .limit(1);
    return rows.length > 0;
  },
  (effect) => effect.pipe(probeFailure),
);
const NO_MATCH: OutboxMatchResult = Object.freeze({ deliveriesCreated: 0, messagesMatched: 0 });

export const makeOutboxRepository = (executor: CoreDbExecutor, crypto: Crypto.Crypto): OutboxRepositoryService => {
  const matchUnmatchedMessages = (compositionRevision: string, now: Date) =>
    executor
      .transaction(
        Effect.fn('matchUnmatchedEffect')(function* matchUnmatchedEffect(transaction: CoreTransaction) {
          const subscriptions = yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'match');
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
        Effect.mapError(compositionAuthorityOrPersistenceError),
      );
  return {
    claimNext: (registrations, claimOwner, now, compositionRevision) => {
      if (registrations.length === 0) {
        return Effect.succeedNone;
      }
      const byWorkerKey = new Map(
        registrations.map((registration) => [registration.descriptor.workerKey, registration]),
      );
      return Effect.gen(function* nativeClaimAdmission() {
        // Admission precedes every statement, the idle probe included: an unadmitted worker issues no SQL at all.
        const admission = yield* prepareNativeOutboxClaimAdmission(registrations, compositionRevision).pipe(
          Effect.mapError(
            (cause) =>
              new ApplicationCompositionAuthorityError({
                cause,
                code: 'application_composition_authority_unavailable',
                reason: 'The worker claim intrinsic admission could not be verified',
              }),
          ),
        );
        const claimable = intrinsicProvidersActive(registrations, admission.intrinsic);
        if (!(yield* hasDueDelivery(executor, claimable, [...byWorkerKey.keys()], now))) {
          return Option.none<OutboxClaim>();
        }
        return yield* executor
          .transaction(
            Effect.fn('claimNextEffect')(function* claimNextEffect(transaction: CoreTransaction) {
              yield* lockApplicationCompositionAuthority(transaction, compositionRevision, 'worker');
              const candidates = yield* transaction
                .select({
                  actionInvocationId: domainEvents.actionInvocationId,
                  attemptsCount: outboxDeliveries.attemptsCount,
                  consumerModuleKey: outboxDeliveries.consumerModuleKey,
                  deliveryId: outboxDeliveries.outboxDeliveryId,
                  domainEventId: domainEvents.domainEventId,
                  legalEntityId: domainEvents.legalEntityId,
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
                .innerJoin(tenantModuleStates, backgroundEligibleConsumer)
                .where(
                  and(
                    inArray(outboxDeliveries.workerKey, [...byWorkerKey.keys()]),
                    claimable,
                    activeMessageTenant,
                    dueDelivery(now),
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
                // The probe saw due work the locked claim did not get: another claimer holds it, or the two
                // questions drifted apart. Either way this poll paid for the fence; name the workers.
                yield* Effect.annotateLogs(Effect.logWarning('Outbox claim found no delivery the probe saw due'), {
                  workerKeys: [...byWorkerKey.keys()].join(','),
                });
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
                  .where(
                    and(eq(outboxAttempts.outboxDeliveryId, candidate.deliveryId), isNull(outboxAttempts.finishedAt)),
                  );
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
              const claimId = `${claimOwner}:${yield* crypto.randomUUIDv4()}`;
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
              const invocationEvidence = yield* loadClaimInvocationEvidence(
                transaction,
                candidate.actionInvocationId,
                candidate.tenantId,
              );
              // The company the event's invocation acted in, so a consumer can keep its work in that company.
              const eventEvidence =
                candidate.legalEntityId === null
                  ? invocationEvidence
                  : { ...invocationEvidence, originatorLegalEntityId: candidate.legalEntityId };
              return Option.some(
                attestNativeOutboxClaim(
                  Object.freeze({
                    attemptId: attempt.attemptId,
                    attemptNumber: claimed.attemptsCount,
                    claimId,
                    consumerModuleKey: candidate.consumerModuleKey,
                    deliveryId: candidate.deliveryId,
                    domainEventId: candidate.domainEventId,
                    ...eventEvidence,
                    messageId: candidate.messageId,
                    payloadJson: candidate.payloadJson,
                    producerModuleKey: candidate.producerModuleKey,
                    retryPolicy: registration.descriptor.retryPolicy,
                    tenantId: candidate.tenantId,
                    tenantSequenceNo: candidate.tenantSequenceNo,
                    topic: candidate.topic,
                    workerKey: candidate.workerKey,
                  } satisfies OutboxClaim),
                  registration,
                  admission,
                ),
              );
            }),
          )
          .pipe(
            Effect.catchDefect((defect) => (isSqlError(defect) ? Effect.fail(defect) : Effect.die(defect))),
            Effect.mapError(compositionAuthorityOrPersistenceError),
          );
      });
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
    fail: (claim, safeErrorMessage, now, wakeAt) =>
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
                  wakeAt === undefined ? undefined : gt(outboxDeliveries.claimExpiresAt, now),
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
            const status: OutboxFailureStatus =
              wakeAt === undefined && claim.attemptNumber >= claim.retryPolicy.maxAttempts ? 'dead' : 'pending';
            const availableAt =
              wakeAt ??
              (status === 'dead' ? now : addMilliseconds(now, retryBackoffMs(claim.retryPolicy, claim.attemptNumber)));
            const settlement = {
              availableAt,
              claimedAt: null,
              claimedBy: null,
              claimExpiresAt: null,
              status,
              updatedAt: now,
            };
            const updated = yield* transaction
              .update(outboxDeliveries)
              // The completed wake stays in outbox_attempts without charging the ordinary retry budget.
              .set(wakeAt === undefined ? settlement : { ...settlement, attemptsCount: claim.attemptNumber - 1 })
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
    matchUnmatched: (compositionRevision, now) =>
      hasUnmatchedMessage(executor).pipe(
        probeFailure,
        Effect.flatMap((pending) =>
          pending ? matchUnmatchedMessages(compositionRevision, now) : Effect.succeed(NO_MATCH),
        ),
      ),
  };
};
export const OutboxRepositoryLive = Layer.effect(
  OutboxRepository,
  Effect.gen(function* makeOutboxRepositoryService() {
    const database = yield* CoreDatabase;
    const crypto = yield* Crypto.Crypto;
    return makeOutboxRepository(database.executor, crypto);
  }),
);
