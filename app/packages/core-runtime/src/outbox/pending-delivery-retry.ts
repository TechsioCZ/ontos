import { and, eq, isNull, sql } from 'drizzle-orm';
import { DateTime, Effect, Option, Schema } from 'effect';

import { TenantIdSchema } from '../access/ids.ts';
import { auditEvents, outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';

const nonblank = (maxLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength), Schema.isTrimmed());
const OutboxMessageIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('OutboxMessageId'));
const OutboxWorkerKeySchema = nonblank(200).pipe(Schema.brand('OutboxWorkerKey'));
const inputSchema = Schema.Struct({
  operatorName: nonblank(200),
  outboxMessageId: OutboxMessageIdSchema,
  reason: nonblank(2000),
  tenantId: TenantIdSchema,
  workerKey: OutboxWorkerKeySchema,
});
export type PendingOutboxDeliveryRetryInput = typeof inputSchema.Encoded;

export class PendingOutboxDeliveryRetryError extends Schema.TaggedError<PendingOutboxDeliveryRetryError>()(
  'PendingOutboxDeliveryRetryError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literals([
      'outbox_retry_invalid_input',
      'outbox_delivery_not_found',
      'outbox_delivery_not_retryable',
      'outbox_retry_compare_and_set_failed',
      'outbox_retry_forbidden',
      'outbox_retry_unavailable',
    ]),
    reason: Schema.String,
  },
) {}
const unavailable = (reason: string) => (cause: unknown) =>
  new PendingOutboxDeliveryRetryError({ cause, code: 'outbox_retry_unavailable', reason });

/**
 * Operator-only repair follow-up in the caller's native admin transaction. Never redrives a dead delivery,
 * resets its attempt budget, steals a claim, changes a payload or settles completion debt. The caller must
 * propagate failure so that scheduling and its append-only audit either commit together or both roll back.
 */
export const retryPendingOutboxDelivery = Effect.fn('PendingOutboxDeliveryRetry.retry')(function* retry(
  transaction: CoreTransaction,
  rawInput: PendingOutboxDeliveryRetryInput,
) {
  const input = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: 'error' })(rawInput).pipe(
    Effect.mapError(
      (cause) =>
        new PendingOutboxDeliveryRetryError({
          cause,
          code: 'outbox_retry_invalid_input',
          reason: 'An exact delivery and bounded operator reason are required',
        }),
    ),
  );
  const [delivery] = yield* transaction
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      claimedAt: outboxDeliveries.claimedAt,
      claimedBy: outboxDeliveries.claimedBy,
      claimExpiresAt: outboxDeliveries.claimExpiresAt,
      outboxDeliveryId: outboxDeliveries.outboxDeliveryId,
      status: outboxDeliveries.status,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(
      and(
        eq(outboxMessages.tenantId, input.tenantId),
        eq(outboxDeliveries.outboxMessageId, input.outboxMessageId),
        eq(outboxDeliveries.workerKey, input.workerKey),
      ),
    )
    // Locks both rows of this exact inner join; a different tenant/message/worker is never selected.
    .for('update')
    .pipe(Effect.mapError(unavailable('The exact pending delivery could not be locked')));
  if (delivery === undefined) {
    return yield* new PendingOutboxDeliveryRetryError({
      code: 'outbox_delivery_not_found',
      reason: 'No delivery matches this tenant, message and worker',
    });
  }
  if (
    delivery.status !== 'pending' ||
    delivery.attemptsCount <= 0 ||
    delivery.claimedBy !== null ||
    delivery.claimedAt !== null ||
    delivery.claimExpiresAt !== null
  ) {
    return yield* new PendingOutboxDeliveryRetryError({
      code: 'outbox_delivery_not_retryable',
      reason: 'Only a previously tried pending delivery with no claim may be rescheduled',
    });
  }
  const facts = yield* transaction
    .execute(
      sql`
      select clock_timestamp()::text as "databaseNow", session_user::text as "recordedBy",
        has_table_privilege(session_user, 'core.outbox_delivery_resolutions', 'INSERT') as administrative
    `,
      'objects',
    )
    .pipe(
      Effect.mapError(unavailable('The database clock and administrative identity could not be read')),
      Effect.flatMap((rows) =>
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              administrative: Schema.Boolean,
              databaseNow: Schema.String,
              recordedBy: nonblank(200),
            }),
          ),
        )(rows).pipe(Effect.mapError(unavailable('The database clock and identity were invalid'))),
      ),
    );
  const [fact] = facts;
  const clock = DateTime.make(fact?.databaseNow ?? '');
  if (facts.length !== 1 || fact === undefined || Option.isNone(clock)) {
    return yield* new PendingOutboxDeliveryRetryError({
      code: 'outbox_retry_unavailable',
      reason: 'The database returned no valid clock and administrative identity',
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
  let { availableAt } = delivery;
  if (!alreadyDue) {
    const [changed] = yield* transaction
      .update(outboxDeliveries)
      .set({ availableAt: now, updatedAt: now })
      .where(
        and(
          eq(outboxDeliveries.outboxDeliveryId, delivery.outboxDeliveryId),
          eq(outboxDeliveries.outboxMessageId, input.outboxMessageId),
          eq(outboxDeliveries.workerKey, input.workerKey),
          eq(outboxDeliveries.status, 'pending'),
          eq(outboxDeliveries.attemptsCount, delivery.attemptsCount),
          // The row lock protects its schedule. Comparing a decoded JS Date would truncate PostgreSQL microseconds.
          isNull(outboxDeliveries.claimedBy),
          isNull(outboxDeliveries.claimedAt),
          isNull(outboxDeliveries.claimExpiresAt),
        ),
      )
      .returning({ availableAt: outboxDeliveries.availableAt })
      .pipe(Effect.mapError(unavailable('The pending delivery could not be rescheduled')));
    if (changed === undefined) {
      return yield* new PendingOutboxDeliveryRetryError({
        code: 'outbox_retry_compare_and_set_failed',
        reason: 'The pending delivery changed before rescheduling',
      });
    }
    ({ availableAt } = changed);
  }
  const outcome = alreadyDue ? ('ALREADY_DUE' as const) : ('RETRY_REQUESTED' as const);
  yield* transaction
    .insert(auditEvents)
    .values({
      actionInvocationId: null,
      auditProfile: 'sensitive',
      authMethod: 'system',
      eventType: 'core.outbox.pending-delivery-retry-after-repair',
      evidenceJson: {
        ...input,
        attemptsCount: delivery.attemptsCount,
        availableAt: availableAt.toISOString(),
        outboxDeliveryId: delivery.outboxDeliveryId,
        outcome,
        previousAvailableAt: delivery.availableAt.toISOString(),
        recordedBy: fact.recordedBy,
        status: delivery.status,
      },
      outcome: 'succeeded',
      outcomeCode: alreadyDue ? 'pending_delivery_already_due' : 'pending_delivery_retry_requested',
      outcomeStage: 'system',
      principalId: null,
      targetResourceId: delivery.outboxDeliveryId,
      targetResourceType: 'outbox-delivery',
      tenantId: input.tenantId,
    })
    .pipe(Effect.mapError(unavailable('The operator retry audit could not be appended')));
  return {
    attemptsCount: delivery.attemptsCount,
    availableAt,
    outboxDeliveryId: delivery.outboxDeliveryId,
    outboxMessageId: input.outboxMessageId,
    outcome,
    recordedBy: fact.recordedBy,
    status: delivery.status,
    tenantId: input.tenantId,
    workerKey: input.workerKey,
  };
});
