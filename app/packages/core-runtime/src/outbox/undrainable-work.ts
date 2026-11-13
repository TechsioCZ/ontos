/**
 * What an Outbox drain would wait for and never get.
 *
 * A publication closes durable admission and moves the authority to `draining` before it waits for the Outbox to
 * empty, and from that moment the running release refuses every read and write. Waiting for work that cannot
 * finish therefore costs an outage, so a publisher asks this first and refuses to start the drain instead — the
 * authority stays `active` with its admission unchanged, and the old release keeps serving.
 *
 * What this asks, exactly:
 *
 * - It exempts precisely the rows the drain carries over ({@link carriesOverToNextRelease}), never a worker key
 *   alone: a core-system row that is claimed, attempted, unmatched, redriven or carrying completion debt blocks
 *   the drain, so it must be able to appear here.
 * - It reports a `dead` delivery, which only an operator moves.
 * - It reports a `pending` delivery whose consumer is not background-eligible in its tenant or whose tenant is not
 *   active, asked with the claim's own {@link backgroundEligibleConsumer} and {@link activeMessageTenant}.
 * - It reports a delivery whose next attempt falls after the drain budget.
 * - It cannot ask the claim's remaining terms without a running host: whether each worker's intrinsic provider
 *   modules are active for the tenant (`intrinsicProvidersActive`, which needs the host's registrations and the
 *   composition catalog), and whether any live host registers the worker key at all. Those are covered
 *   conservatively by age: an unclaimed, never-attempted, due delivery older than a whole drain budget has not
 *   been picked up by anything, whatever the reason, so it is reported.
 */
import { and, asc, eq, gt, lt, notInArray, or, sql } from 'drizzle-orm';
import { DateTime, Duration, Effect, Schema } from 'effect';

import { outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreDbExecutor, CoreTransaction } from '../db/types.ts';
import { carriesOverToNextRelease } from './carry-over.ts';
import { activeMessageTenant, backgroundEligibleConsumer } from './repository.ts';
import type { OutboxConsumerKey } from './repository.ts';

/**
 * Why one delivery would never finish inside the drain's budget.
 *
 * - `dead`: only an operator redrive or release moves it; the boot gate already refuses to publish with one.
 * - `no-eligible-consumer`: its consumer module is not background-eligible in its tenant, or its tenant is not active.
 * - `scheduled-beyond-budget`: its next attempt falls after the drain budget expires.
 * - `unclaimed-longer-than-budget`: nothing has picked it up for longer than a whole drain budget.
 */
export const UndrainableOutboxReasonSchema = Schema.Literals([
  'dead',
  'no-eligible-consumer',
  'scheduled-beyond-budget',
  'unclaimed-longer-than-budget',
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

export interface UndrainableOutboxWorkInput {
  readonly budgetMs: number;
  /** Proven-identical core-system keys: the rows these carry over are exempt, by the shared predicate. */
  readonly carriedOverWorkerKeys: readonly string[];
  /**
   * Every core-system subscription the retiring authority approved, worker key paired with its consumer module. A
   * live host of that release claims these as Core's own work without a tenant module state.
   */
  readonly coreSystemConsumers: readonly OutboxConsumerKey[];
  readonly limit?: number;
}

/**
 * The deliveries a drain starting now would wait for in vain, oldest first. Work that is genuinely in flight —
 * claimed, or retrying inside the budget with a live consumer — is not reported: that work drains.
 */
export const listUndrainableOutboxWork = Effect.fn('Outbox.listUndrainableWork')(function* listUndrainableOutboxWork(
  executor: CoreDbExecutor | CoreTransaction,
  input: UndrainableOutboxWorkInput,
) {
  const budgetSeconds = Duration.toSeconds(Duration.millis(input.budgetMs));
  const deadline = sql`clock_timestamp() + make_interval(secs => ${budgetSeconds})`;
  const budgetAgo = sql`clock_timestamp() - make_interval(secs => ${budgetSeconds})`;
  const carriesOver = carriesOverToNextRelease(input.carriedOverWorkerKeys);
  const noLiveConsumer = or(
    sql`not (${backgroundEligibleConsumer(input.coreSystemConsumers)})`,
    sql`not (${activeMessageTenant})`,
  );
  const ineligible = and(eq(outboxDeliveries.status, 'pending'), noLiveConsumer);
  // Nothing picked it up for a whole budget: covers an inactive intrinsic provider and a worker key no live host
  // registers, neither of which can be asked from the database alone.
  const unclaimedTooLong = and(
    eq(outboxDeliveries.status, 'pending'),
    eq(outboxDeliveries.attemptsCount, 0),
    sql`${outboxDeliveries.claimedBy} is null`,
    lt(outboxDeliveries.createdAt, budgetAgo),
    lt(outboxDeliveries.availableAt, sql`clock_timestamp()`),
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
          when ${noLiveConsumer} then 'no-eligible-consumer'
          else 'unclaimed-longer-than-budget' end`,
      status: outboxDeliveries.status,
      tenantId: outboxMessages.tenantId,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(
      and(
        notInArray(outboxDeliveries.status, ['done', 'released']),
        // Exactly the rows the drain carries over are exempt, and only those.
        carriesOver === undefined ? undefined : sql`not ${carriesOver}`,
        or(
          eq(outboxDeliveries.status, 'dead'),
          gt(outboxDeliveries.availableAt, deadline),
          ineligible,
          unclaimedTooLong,
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
      ? ` (first ${String(UNDRAINABLE_REPORT_LIMIT)}; \`pnpm composition:drain-preflight\` shows the current state)`
      : '';
  return `Outbox work that this drain could never finish${more}: ${deliveries.map(describeOne).join('; ')}`;
};
