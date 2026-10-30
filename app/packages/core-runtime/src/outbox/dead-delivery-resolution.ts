import { and, asc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { outboxAttempts, outboxDeliveries, outboxDeliveryResolutions, outboxMessages } from '../db/schema.ts';
import type { OutboxDeliveryResolutionAction } from '../db/schema.ts';
import type { CoreDbExecutor, CoreTransaction } from '../db/types.ts';

export class OutboxDeliveryResolutionError extends Schema.TaggedError<OutboxDeliveryResolutionError>()(
  'OutboxDeliveryResolutionError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    code: Schema.Literals([
      'outbox_delivery_not_found',
      'outbox_delivery_not_dead',
      'outbox_delivery_resolution_unavailable',
    ]),
    reason: Schema.String,
  },
) {}

const unavailable = (reason: string) => (cause: unknown) =>
  new OutboxDeliveryResolutionError({ cause, code: 'outbox_delivery_resolution_unavailable', reason });

/** One exact delivery: the message and the subscribed Worker inside one Tenant. */
export interface OutboxDeliveryReference {
  readonly outboxMessageId: string;
  readonly tenantId: string;
  readonly workerKey: string;
}

export interface OutboxDeliveryResolutionInput extends OutboxDeliveryReference {
  readonly action: OutboxDeliveryResolutionAction;
  readonly operatorName: string;
  readonly reason: string;
}

export interface OutboxDeliveryResolutionReceipt extends OutboxDeliveryReference {
  readonly action: OutboxDeliveryResolutionAction;
  readonly deadAttemptsCount: number;
  readonly deliveryStatus: string;
  readonly outboxDeliveryId: string;
  readonly recordedAt: Date;
  readonly recordedBy: string;
}

export interface DeadOutboxDelivery extends OutboxDeliveryReference {
  readonly attemptsCount: number;
  readonly completionOriginalRevision: string | null;
  readonly consumerModuleKey: string;
  readonly lastError: string | null;
  readonly updatedAt: Date;
}

/**
 * Lists dead deliveries for an operator. `trackedRevision` keeps only deliveries that carry composition
 * completion debt for that original release; without it every dead delivery is listed.
 */
export const listDeadOutboxDeliveries = (
  executor: CoreDbExecutor,
  options: {
    readonly limit: number;
    readonly tenantId?: string | undefined;
    readonly trackedRevision?: string | undefined;
  },
) => {
  const filters: SQL[] = [eq(outboxDeliveries.status, 'dead')];
  if (options.tenantId !== undefined) {
    filters.push(eq(outboxMessages.tenantId, options.tenantId));
  }
  if (options.trackedRevision !== undefined) {
    filters.push(
      eq(outboxMessages.completionOriginalRevision, options.trackedRevision),
      eq(outboxDeliveries.consumerModuleKey, outboxMessages.completionConsumerModuleKey),
    );
  }
  return executor
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      completionOriginalRevision: outboxMessages.completionOriginalRevision,
      consumerModuleKey: outboxDeliveries.consumerModuleKey,
      lastError: sql<string | null>`(select ${outboxAttempts.errorMessage} from ${outboxAttempts}
        where ${outboxAttempts.outboxDeliveryId} = ${outboxDeliveries.outboxDeliveryId}
        order by ${outboxAttempts.startedAt} desc limit 1)`,
      outboxMessageId: outboxDeliveries.outboxMessageId,
      tenantId: outboxMessages.tenantId,
      updatedAt: outboxDeliveries.updatedAt,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(and(...filters))
    .orderBy(asc(outboxDeliveries.updatedAt), asc(outboxDeliveries.outboxDeliveryId))
    .limit(options.limit)
    .pipe(
      Effect.map((rows): readonly DeadOutboxDelivery[] => rows),
      Effect.mapError(unavailable('Dead Outbox deliveries could not be listed')),
    );
};

/** Formats dead deliveries as the exact arguments the operator command expects. */
export const describeDeadOutboxDeliveries = (
  deliveries: readonly Pick<DeadOutboxDelivery, 'attemptsCount' | 'outboxMessageId' | 'tenantId' | 'workerKey'>[],
): string =>
  deliveries
    .map(
      ({ attemptsCount, outboxMessageId, tenantId, workerKey }) =>
        `--tenant-id ${tenantId} --message-id ${outboxMessageId} --worker-key ${workerKey} (attempts ${attemptsCount})`,
    )
    .join('; ');

/**
 * Records one append-only operator decision for one exact dead delivery. The database triggers bind the
 * record to the dead delivery, stamp who and when, and apply it in the same statement: `redrive` returns it
 * to `pending` with a fresh attempt budget, `release` makes it `released`, which settles its completion debt.
 */
export const resolveDeadOutboxDelivery = Effect.fn('OutboxDeliveryResolution.resolve')(function* resolveDeadOutbox(
  transaction: CoreTransaction,
  input: OutboxDeliveryResolutionInput,
) {
  const [delivery] = yield* transaction
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
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
    .for('update', { of: outboxDeliveries })
    .pipe(Effect.mapError(unavailable('The Outbox delivery could not be locked')));
  if (delivery === undefined) {
    return yield* new OutboxDeliveryResolutionError({
      code: 'outbox_delivery_not_found',
      reason: 'No Outbox delivery matches this Tenant, message, and Worker',
    });
  }
  if (delivery.status !== 'dead') {
    return yield* new OutboxDeliveryResolutionError({
      code: 'outbox_delivery_not_dead',
      reason: `Only a dead Outbox delivery can be redriven or released; this delivery is ${delivery.status}`,
    });
  }
  const [recorded] = yield* transaction
    .insert(outboxDeliveryResolutions)
    .values({
      action: input.action,
      deadAttemptsCount: delivery.attemptsCount,
      operatorName: input.operatorName,
      outboxDeliveryId: delivery.outboxDeliveryId,
      outboxMessageId: input.outboxMessageId,
      reason: input.reason,
      tenantId: input.tenantId,
      workerKey: input.workerKey,
    })
    .returning({
      deadAttemptsCount: outboxDeliveryResolutions.deadAttemptsCount,
      outboxDeliveryId: outboxDeliveryResolutions.outboxDeliveryId,
      recordedAt: outboxDeliveryResolutions.recordedAt,
      recordedBy: outboxDeliveryResolutions.recordedBy,
    })
    .pipe(Effect.mapError(unavailable('The Outbox delivery resolution could not be recorded')));
  const ineffective = new OutboxDeliveryResolutionError({
    code: 'outbox_delivery_resolution_unavailable',
    reason: 'The Outbox delivery resolution did not take effect',
  });
  if (recorded === undefined) {
    return yield* ineffective;
  }
  // The ledger trigger applied the decision; read back the delivery it changed.
  const [after] = yield* transaction
    .select({ status: outboxDeliveries.status })
    .from(outboxDeliveries)
    .where(eq(outboxDeliveries.outboxDeliveryId, recorded.outboxDeliveryId))
    .pipe(Effect.mapError(unavailable('The resolved Outbox delivery could not be read')));
  if (after?.status !== (input.action === 'redrive' ? 'pending' : 'released')) {
    return yield* ineffective;
  }
  return {
    action: input.action,
    deadAttemptsCount: recorded.deadAttemptsCount,
    deliveryStatus: after.status,
    outboxDeliveryId: delivery.outboxDeliveryId,
    outboxMessageId: input.outboxMessageId,
    recordedAt: recorded.recordedAt,
    recordedBy: recorded.recordedBy,
    tenantId: input.tenantId,
    workerKey: input.workerKey,
  } satisfies OutboxDeliveryResolutionReceipt;
});
