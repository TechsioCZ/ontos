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
import type { SQL } from 'drizzle-orm';
import { DateTime, Duration, Effect, Schema } from 'effect';

import { outboxAttempts, outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreDbExecutor, CoreTransaction } from '../db/types.ts';
import { carriesOverToNextRelease } from './carry-over.ts';
import { OUTBOX_DEFERRED_ATTEMPT_MESSAGE } from './outbox-worker-deferred.ts';
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
  /** Its owner deferred it to `availableAt` (a wake it asked for), rather than a failure backing off. */
  readonly deferred: boolean;
  readonly outboxMessageId: string;
  readonly reason: UndrainableOutboxReason;
  readonly status: string;
  readonly tenantId: string;
  readonly workerKey: string;
}

/** Enough rows to act on; the message says when there are more. */
export const UNDRAINABLE_REPORT_LIMIT = 20;

/**
 * Work nothing has picked up for longer than a whole drain budget, in the one place both the pre-flight and the
 * operator command ask it. It covers the claim terms that cannot be asked from the database alone — an inactive
 * intrinsic provider, and a worker key no live host registers.
 *
 * Age is measured by `available_at`, never `created_at`: a redrive resets a row to pending and due now while
 * keeping its original `created_at`, and a deploy straight after a documented redrive must not be refused for a
 * row that has been claimable for seconds. A `processing` row counts once its claim lease has been expired for a
 * whole budget — the claim path would hand it to a live host at once, so only a row no host takes stays stuck.
 */
export const stalledLongerThanBudget = (budgetAgo: SQL) =>
  or(
    and(
      eq(outboxDeliveries.status, 'pending'),
      eq(outboxDeliveries.attemptsCount, 0),
      sql`${outboxDeliveries.claimedBy} is null`,
      lt(outboxDeliveries.availableAt, budgetAgo),
    ),
    and(eq(outboxDeliveries.status, 'processing'), lt(outboxDeliveries.claimExpiresAt, budgetAgo)),
  );

/**
 * Messages nothing has matched for longer than a whole drain budget. The matcher keeps running while a release
 * drains, so a freshly written unmatched message is in-flight work and drains; one that has waited a whole budget
 * means no matcher is running, and the drain would wait for it in vain. Asked by the publisher's pre-flight and by
 * the operator command alike.
 */
export const countStalledUnmatchedMessages = Effect.fn('Outbox.countStalledUnmatchedMessages')(
  function* countStalledUnmatchedMessages(executor: CoreDbExecutor | CoreTransaction, budgetMs: number) {
    const budgetSeconds = Duration.toSeconds(Duration.millis(budgetMs));
    const [row] = yield* executor
      .select({ count: sql<number>`count(*)::int` })
      .from(outboxMessages)
      .where(
        and(
          sql`${outboxMessages.matchedAt} is null`,
          lt(outboxMessages.createdAt, sql`clock_timestamp() - make_interval(secs => ${budgetSeconds})`),
        ),
      );
    return row?.count ?? 0;
  },
);

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
  /**
   * How long the drain has left, on the publisher's own budget clock; a delivery due after that never drains.
   * Defaults to `budgetMs`: a drain starting now has its whole budget.
   */
  readonly remainingMs?: number;
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
  const remainingSeconds = Duration.toSeconds(Duration.millis(input.remainingMs ?? input.budgetMs));
  const deadline = sql`clock_timestamp() + make_interval(secs => ${remainingSeconds})`;
  const budgetAgo = sql`clock_timestamp() - make_interval(secs => ${budgetSeconds})`;
  const carriesOver = carriesOverToNextRelease(input.carriedOverWorkerKeys);
  const noLiveConsumer = or(
    sql`not (${backgroundEligibleConsumer(input.coreSystemConsumers)})`,
    sql`not (${activeMessageTenant})`,
  );
  const ineligible = and(eq(outboxDeliveries.status, 'pending'), noLiveConsumer);
  const stalled = stalledLongerThanBudget(budgetAgo);
  return yield* executor
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      consumerModuleKey: outboxDeliveries.consumerModuleKey,
      // The deferral settles the delivery's latest attempt with this exact message; a failure records its own.
      deferred: sql<boolean>`coalesce((
          select ${outboxAttempts.errorMessage} from ${outboxAttempts}
          where ${outboxAttempts.outboxDeliveryId} = ${outboxDeliveries.outboxDeliveryId}
          order by ${outboxAttempts.startedAt} desc limit 1
        ) = ${OUTBOX_DEFERRED_ATTEMPT_MESSAGE}, false)`,
      outboxMessageId: outboxDeliveries.outboxMessageId,
      reason: sql<UndrainableOutboxReason>`case
          when ${outboxDeliveries.status} = 'dead' then 'dead'
          when ${outboxDeliveries.availableAt} > ${deadline} then 'scheduled-beyond-budget'
          when ${ineligible} then 'no-eligible-consumer'
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
        or(eq(outboxDeliveries.status, 'dead'), gt(outboxDeliveries.availableAt, deadline), ineligible, stalled),
      ),
    )
    .orderBy(asc(outboxDeliveries.createdAt), asc(outboxDeliveries.outboxDeliveryId))
    .limit(input.limit ?? UNDRAINABLE_REPORT_LIMIT);
});

/** The reason, with why a delivery is due too late when its own owner asked for that wake. */
const describeReason = (delivery: UndrainableOutboxDelivery) =>
  delivery.reason === 'scheduled-beyond-budget' && delivery.deferred
    ? `${delivery.reason} (deferred by its owner until ${DateTime.formatIso(DateTime.makeUnsafe(delivery.availableAt))})`
    : delivery.reason;

/** One reported delivery, for an operator. */
const describeUndrainableDelivery = (delivery: UndrainableOutboxDelivery) =>
  `${describeReason(delivery)}: --tenant-id ${delivery.tenantId} --message-id ${delivery.outboxMessageId} --worker-key ${delivery.workerKey} (consumer ${delivery.consumerModuleKey}, ${delivery.status}, attempts ${String(delivery.attemptsCount)}, available at ${DateTime.formatIso(DateTime.makeUnsafe(delivery.availableAt))})`;

/** One operator-readable line naming every reported row, or `''` when the drain can finish. */
export const describeUndrainableOutboxWork = (deliveries: readonly UndrainableOutboxDelivery[]): string => {
  if (deliveries.length === 0) {
    return '';
  }
  const more =
    deliveries.length === UNDRAINABLE_REPORT_LIMIT
      ? ` (first ${String(UNDRAINABLE_REPORT_LIMIT)}; \`pnpm composition:drain-preflight\` shows the current state)`
      : '';
  return `Outbox work that this drain could never finish${more}: ${deliveries.map(describeUndrainableDelivery).join('; ')}`;
};
