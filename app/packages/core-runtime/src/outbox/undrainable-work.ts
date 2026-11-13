/**
 * What an Outbox drain would wait for and never get.
 *
 * A publication closes durable admission and moves the authority to `draining` before it waits for the Outbox to
 * empty, and from that moment the running release refuses every read and write. Waiting for work that cannot
 * finish therefore costs an outage, so a publisher asks this first and refuses to start the drain instead — the
 * old release keeps serving and nothing is written.
 *
 * Eligibility is asked with {@link backgroundEligibleConsumer} and {@link activeMessageTenant}, the very predicates
 * the claim uses, so the drain's question and the claim's answer can never disagree again.
 */
import { and, asc, eq, gt, notInArray, or, sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';

import { outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreDbExecutor } from '../db/types.ts';
import { activeMessageTenant, backgroundEligibleConsumer } from './repository.ts';

/**
 * Why one delivery would never finish inside the drain's budget.
 *
 * - `dead`: only an operator redrive or release moves it; the boot gate already refuses to publish with one.
 * - `no-eligible-consumer`: its consumer module is not background-eligible in its tenant, or its tenant is not active.
 * - `scheduled-beyond-budget`: its next attempt falls after the drain budget expires.
 */
export const UndrainableOutboxReasonSchema = Schema.Literals([
  'dead',
  'no-eligible-consumer',
  'scheduled-beyond-budget',
]);
export type UndrainableOutboxReason = typeof UndrainableOutboxReasonSchema.Type;

export interface UndrainableOutboxDelivery {
  readonly attemptsCount: number;
  readonly availableAt: Date;
  readonly consumerModuleKey: string;
  readonly outboxMessageId: string;
  readonly reason: UndrainableOutboxReason;
  readonly status: string;
  readonly tenantId: string;
  readonly workerKey: string;
}

/** Enough rows to act on; the message says when there are more. */
export const UNDRAINABLE_REPORT_LIMIT = 20;

/**
 * The deliveries a drain starting now would wait for in vain, oldest first.
 *
 * `carriedOverWorkerKeys` names the core-system work the retiring revision may hand to the next one, which is
 * outstanding but not blocking; it is never reported. Work that is merely in flight — claimed, retrying within the
 * budget, or waiting for a consumer that is live — is not reported either: that work drains.
 */
export const listUndrainableOutboxWork = Effect.fn('Outbox.listUndrainableWork')(function* listUndrainableOutboxWork(
  executor: CoreDbExecutor,
  input: {
    readonly budgetMs: number;
    /** Proven-identical core-system keys: outstanding work that crosses the boundary, never a refusal. */
    readonly carriedOverWorkerKeys: readonly string[];
    /**
     * Every core-system key the retiring authority approved. A live host of that release claims these as Core's
     * own work without a tenant module state, so they have a consumer even when they do not carry over.
     */
    readonly coreSystemWorkerKeys: readonly string[];
    readonly limit?: number;
  },
) {
  const deadline = sql`clock_timestamp() + make_interval(secs => ${input.budgetMs / 1000})`;
  const notCarriedOver =
    input.carriedOverWorkerKeys.length === 0
      ? undefined
      : notInArray(outboxDeliveries.workerKey, [...input.carriedOverWorkerKeys]);
  const ineligible = and(
    eq(outboxDeliveries.status, 'pending'),
    or(sql`not (${backgroundEligibleConsumer(input.coreSystemWorkerKeys)})`, sql`not (${activeMessageTenant})`),
  );
  return yield* executor
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      consumerModuleKey: outboxDeliveries.consumerModuleKey,
      outboxMessageId: outboxDeliveries.outboxMessageId,
      reason: sql<UndrainableOutboxReason>`case
          when ${outboxDeliveries.status} = 'dead' then 'dead'
          when ${outboxDeliveries.availableAt} > ${deadline} then 'scheduled-beyond-budget'
          else 'no-eligible-consumer' end`,
      status: outboxDeliveries.status,
      tenantId: outboxMessages.tenantId,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(
      and(
        notInArray(outboxDeliveries.status, ['done', 'released']),
        or(
          eq(outboxDeliveries.status, 'dead'),
          // Carried-over work is outstanding but never blocking, so it is never a refusal.
          and(notCarriedOver, or(gt(outboxDeliveries.availableAt, deadline), ineligible)),
        ),
      ),
    )
    .orderBy(asc(outboxDeliveries.createdAt), asc(outboxDeliveries.outboxDeliveryId))
    .limit(input.limit ?? UNDRAINABLE_REPORT_LIMIT);
});

const describeOne = (delivery: UndrainableOutboxDelivery) =>
  `${delivery.reason}: --tenant-id ${delivery.tenantId} --message-id ${delivery.outboxMessageId} --worker-key ${delivery.workerKey} (consumer ${delivery.consumerModuleKey}, ${delivery.status}, attempts ${String(delivery.attemptsCount)}, available at ${DateTime.formatIso(DateTime.makeUnsafe(delivery.availableAt))})`;

/** One operator-readable line naming every reported row, or `''` when the drain can finish. */
export const describeUndrainableOutboxWork = (deliveries: readonly UndrainableOutboxDelivery[]): string => {
  if (deliveries.length === 0) {
    return '';
  }
  const more =
    deliveries.length === UNDRAINABLE_REPORT_LIMIT
      ? ` (first ${String(UNDRAINABLE_REPORT_LIMIT)}; \`pnpm outbox:dead-delivery list\` shows the dead ones)`
      : '';
  return `Outbox work that this drain could never finish${more}: ${deliveries.map(describeOne).join('; ')}`;
};
