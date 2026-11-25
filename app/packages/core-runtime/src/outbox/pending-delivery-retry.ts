import { and, eq, isNull, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { auditEvents, outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';

const nonblank = (maxLength: number) => Schema.String.check(
  Schema.isMinLength(1), Schema.isMaxLength(maxLength), Schema.isTrimmed(),
);
const inputSchema = Schema.Struct({
  outboxMessageId: Schema.String.check(Schema.isUUID()),
  tenantId: Schema.String.check(Schema.isUUID()),
  workerKey: nonblank(200),
  operatorName: nonblank(200),
  reason: nonblank(2000),
});
export type PendingOutboxDeliveryRetryInput = typeof inputSchema.Type;

export class PendingOutboxDeliveryRetryError extends Schema.TaggedError<PendingOutboxDeliveryRetryError>()(
  'PendingOutboxDeliveryRetryError',
  {
    code: Schema.Literals([
      'outbox_retry_invalid_input', 'outbox_delivery_not_found', 'outbox_delivery_not_retryable',
      'outbox_retry_compare_and_set_failed', 'outbox_retry_forbidden', 'outbox_retry_unavailable',
    ]),
    reason: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
const unavailable = (reason: string) => (cause: unknown) =>
  new PendingOutboxDeliveryRetryError({ code: 'outbox_retry_unavailable', reason, cause });

/**
 * Operator-only repair follow-up in the caller's native admin transaction. Never redrives a dead delivery,
 * resets its attempt budget, steals a claim, changes a payload or settles completion debt. The caller must
 * propagate failure so that scheduling and its append-only audit either commit together or both roll back.
 */
export const retryPendingOutboxDelivery = Effect.fn('PendingOutboxDeliveryRetry.retry')(
  function* retry(transaction: CoreTransaction, rawInput: PendingOutboxDeliveryRetryInput) {
    const input = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: 'error' })(rawInput).pipe(
      Effect.mapError((cause) => new PendingOutboxDeliveryRetryError({
        code: 'outbox_retry_invalid_input', reason: 'An exact delivery and bounded operator reason are required', cause,
      })),
    );
    const [delivery] = yield* transaction.select({
      outboxDeliveryId: outboxDeliveries.outboxDeliveryId,
      status: outboxDeliveries.status,
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      claimedBy: outboxDeliveries.claimedBy,
      claimedAt: outboxDeliveries.claimedAt,
      claimExpiresAt: outboxDeliveries.claimExpiresAt,
    }).from(outboxDeliveries)
      .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
      .where(and(
        eq(outboxMessages.tenantId, input.tenantId),
        eq(outboxDeliveries.outboxMessageId, input.outboxMessageId),
        eq(outboxDeliveries.workerKey, input.workerKey),
      ))
      // Locks both rows of this exact inner join; a different tenant/message/worker is never selected.
      .for('update')
      .pipe(Effect.mapError(unavailable('The exact pending delivery could not be locked')));
    if (delivery === undefined) {
      return yield* new PendingOutboxDeliveryRetryError({
        code: 'outbox_delivery_not_found', reason: 'No delivery matches this tenant, message and worker',
      });
    }
    if (
      delivery.status !== 'pending' || delivery.attemptsCount <= 0 ||
      delivery.claimedBy !== null || delivery.claimedAt !== null || delivery.claimExpiresAt !== null
    ) {
      return yield* new PendingOutboxDeliveryRetryError({
        code: 'outbox_delivery_not_retryable', reason: 'Only a previously tried pending delivery with no claim may be rescheduled',
      });
    }
    const facts = yield* transaction.execute(sql`
      select clock_timestamp()::text as "databaseNow", session_user::text as "recordedBy",
        has_table_privilege(session_user, 'core.outbox_delivery_resolutions', 'INSERT') as administrative
    `, 'objects').pipe(
      Effect.mapError(unavailable('The database clock and administrative identity could not be read')),
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
        databaseNow: Schema.String, recordedBy: nonblank(200), administrative: Schema.Boolean,
      })))(rows).pipe(Effect.mapError(unavailable('The database clock and identity were invalid')))),
    );
    const [fact] = facts;
    const clock = DateTime.make(fact?.databaseNow ?? '');
    if (facts.length !== 1 || fact === undefined || Option.isNone(clock)) {
      return yield* new PendingOutboxDeliveryRetryError({
        code: 'outbox_retry_unavailable', reason: 'The database returned no valid clock and administrative identity',
      });
    }
    if (!fact.administrative) {
      return yield* new PendingOutboxDeliveryRetryError({
        code: 'outbox_retry_forbidden',
        reason: 'Pending retry requires the database identity authorized to insert native operator delivery decisions',
      });
    }
    const now = DateTime.toDateUtc(clock.value);
    const alreadyDue = delivery.availableAt.getTime() <= now.getTime();
    let availableAt = delivery.availableAt;
    if (!alreadyDue) {
      const [changed] = yield* transaction.update(outboxDeliveries)
        .set({ availableAt: now, updatedAt: now })
        .where(and(
          eq(outboxDeliveries.outboxDeliveryId, delivery.outboxDeliveryId),
          eq(outboxDeliveries.outboxMessageId, input.outboxMessageId),
          eq(outboxDeliveries.workerKey, input.workerKey),
          eq(outboxDeliveries.status, 'pending'),
          eq(outboxDeliveries.attemptsCount, delivery.attemptsCount),
          // The row lock protects its schedule. Comparing a decoded JS Date would truncate PostgreSQL microseconds.
          isNull(outboxDeliveries.claimedBy), isNull(outboxDeliveries.claimedAt), isNull(outboxDeliveries.claimExpiresAt),
        ))
        .returning({ availableAt: outboxDeliveries.availableAt })
        .pipe(Effect.mapError(unavailable('The pending delivery could not be rescheduled')));
      if (changed === undefined) {
        return yield* new PendingOutboxDeliveryRetryError({
          code: 'outbox_retry_compare_and_set_failed', reason: 'The pending delivery changed before rescheduling',
        });
      }
      availableAt = changed.availableAt;
    }
    const outcome = alreadyDue ? 'ALREADY_DUE' as const : 'RETRY_REQUESTED' as const;
    yield* transaction.insert(auditEvents).values({
      tenantId: input.tenantId,
      principalId: null,
      actionInvocationId: null,
      authMethod: 'system',
      eventType: 'core.outbox.pending-delivery-retry-after-repair',
      auditProfile: 'sensitive',
      outcome: 'succeeded',
      outcomeStage: 'system',
      outcomeCode: alreadyDue ? 'pending_delivery_already_due' : 'pending_delivery_retry_requested',
      targetResourceType: 'outbox-delivery',
      targetResourceId: delivery.outboxDeliveryId,
      evidenceJson: {
        ...input, outcome, recordedBy: fact.recordedBy,
        outboxDeliveryId: delivery.outboxDeliveryId, status: delivery.status, attemptsCount: delivery.attemptsCount,
        previousAvailableAt: delivery.availableAt.toISOString(), availableAt: availableAt.toISOString(),
      },
    }).pipe(Effect.mapError(unavailable('The operator retry audit could not be appended')));
    return {
      outcome, availableAt, attemptsCount: delivery.attemptsCount, outboxDeliveryId: delivery.outboxDeliveryId,
      outboxMessageId: input.outboxMessageId, tenantId: input.tenantId, workerKey: input.workerKey,
      status: delivery.status, recordedBy: fact.recordedBy,
    };
  },
);
