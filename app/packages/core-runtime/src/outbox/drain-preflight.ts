/**
 * What a publication's Outbox drain would do with each piece of outstanding work, as diagnostics.
 *
 * This is advisory only and takes no lock: it never stalls a running publisher, and a publisher re-asks the same
 * questions under its own publication lock before it writes anything. It reads no payload and no personal data —
 * only identifiers, worker keys, statuses and times.
 */
import { and, asc, eq, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import { Duration, Effect, Schema } from 'effect';

import { outboxDeliveries, outboxMessages } from '../db/schema.ts';
import type { CoreDbExecutor } from '../db/types.ts';
import { carriesOverToNextRelease } from './carry-over.ts';
import { activeMessageTenant, backgroundEligibleConsumer } from './repository.ts';
import type { OutboxConsumerKey } from './repository.ts';

/**
 * How one outstanding delivery meets the next release's drain.
 *
 * - `drain`: a live consumer can claim it, so the retiring release finishes it inside the drain.
 * - `carry-over`: Core's own untouched work under a proven-identical descriptor; it crosses the boundary.
 * - `block`: neither, so the drain would wait for it and never get it.
 */
export const DrainWorkOutcomeSchema = Schema.Literals(['drain', 'carry-over', 'block']);
export type DrainWorkOutcome = typeof DrainWorkOutcomeSchema.Type;

export interface DrainWorkRow {
  readonly attemptsCount: number;
  readonly availableAt: Date;
  readonly beyondBudget: boolean;
  /** The shared carry-over predicate, evaluated by the database on this row. */
  readonly carriesOver: boolean;
  readonly claimed: boolean;
  readonly consumerModuleKey: string;
  readonly eligible: boolean;
  readonly matched: boolean;
  readonly outboxMessageId: string;
  readonly status: string;
  readonly tenantId: string;
  readonly trackedRevision: string | null;
  /** Nothing has picked it up for longer than a whole drain budget. */
  readonly unclaimedTooLong: boolean;
  readonly workerKey: string;
}

export const DRAIN_PREFLIGHT_ROW_LIMIT = 200;

/**
 * Every non-terminal delivery with the facts the drain decides on. `coreSystemWorkerKeys` are the core-system keys
 * the retiring authority approved, which is what {@link backgroundEligibleConsumer} treats as Core's own work.
 */
export const listDrainWork = Effect.fn('Outbox.listDrainWork')(function* listDrainWork(
  executor: CoreDbExecutor,
  input: {
    readonly budgetMs: number;
    readonly carriedOverWorkerKeys: readonly string[];
    readonly coreSystemConsumers: readonly OutboxConsumerKey[];
    readonly limit?: number;
  },
) {
  const budgetSeconds = Duration.toSeconds(Duration.millis(input.budgetMs));
  const deadline = sql`clock_timestamp() + make_interval(secs => ${budgetSeconds})`;
  const budgetAgo = sql`clock_timestamp() - make_interval(secs => ${budgetSeconds})`;
  const carriesOver = carriesOverToNextRelease(input.carriedOverWorkerKeys);
  return yield* executor
    .select({
      attemptsCount: outboxDeliveries.attemptsCount,
      availableAt: outboxDeliveries.availableAt,
      beyondBudget: sql<boolean>`${outboxDeliveries.availableAt} > ${deadline}`,
      carriesOver: carriesOver === undefined ? sql<boolean>`false` : sql<boolean>`coalesce(${carriesOver}, false)`,
      claimed: sql<boolean>`${outboxDeliveries.claimedBy} is not null`,
      consumerModuleKey: outboxDeliveries.consumerModuleKey,
      eligible: sql<boolean>`(${backgroundEligibleConsumer(input.coreSystemConsumers)}) and (${activeMessageTenant})`,
      matched: sql<boolean>`${outboxMessages.matchedAt} is not null`,
      outboxMessageId: outboxDeliveries.outboxMessageId,
      status: outboxDeliveries.status,
      tenantId: outboxMessages.tenantId,
      trackedRevision: outboxMessages.completionOriginalRevision,
      unclaimedTooLong: sql<boolean>`${outboxDeliveries.status} = 'pending' and ${outboxDeliveries.attemptsCount} = 0
        and ${outboxDeliveries.claimedBy} is null and ${outboxDeliveries.createdAt} < ${budgetAgo}
        and ${outboxDeliveries.availableAt} < clock_timestamp()`,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(notInArray(outboxDeliveries.status, ['done', 'released']))
    .orderBy(asc(outboxDeliveries.createdAt), asc(outboxDeliveries.outboxDeliveryId))
    .limit(input.limit ?? DRAIN_PREFLIGHT_ROW_LIMIT);
});

/** Non-terminal Outbox work counted by worker key and status; no identifiers, so it is safe to print in full. */
export const countDrainWork = Effect.fn('Outbox.countDrainWork')(function* countDrainWork(executor: CoreDbExecutor) {
  return yield* executor
    .select({
      count: sql<number>`count(*)::int`,
      status: outboxDeliveries.status,
      workerKey: outboxDeliveries.workerKey,
    })
    .from(outboxDeliveries)
    .where(notInArray(outboxDeliveries.status, ['done', 'released']))
    .groupBy(outboxDeliveries.workerKey, outboxDeliveries.status)
    .orderBy(asc(outboxDeliveries.workerKey), asc(outboxDeliveries.status));
});

/** Messages still waiting to be matched; any one of them blocks a drain on its own. */
export const countUnmatchedMessages = Effect.fn('Outbox.countUnmatchedMessages')(function* countUnmatchedMessages(
  executor: CoreDbExecutor,
) {
  const [row] = yield* executor
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .where(isNull(outboxMessages.matchedAt));
  return row?.count ?? 0;
});

/**
 * How the drain would treat one row, by exactly the conditions the drain predicate applies: Core's own untouched
 * work under a carried-over key crosses the boundary, work with a live consumer drains, the rest blocks.
 */
export interface DrainWorkVerdict {
  readonly outcome: DrainWorkOutcome;
  readonly why: string;
}

export const classifyDrainWork = (row: DrainWorkRow): DrainWorkVerdict => {
  if (row.carriesOver) {
    return { outcome: 'carry-over', why: "Core's own untouched work under a proven-identical descriptor" };
  }
  if (row.status === 'dead') {
    return { outcome: 'block', why: 'dead; only an operator redrive or release moves it' };
  }
  if (row.beyondBudget) {
    return { outcome: 'block', why: 'its next attempt falls after the drain budget' };
  }
  if (!row.eligible && row.status === 'pending') {
    return {
      outcome: 'block',
      why: 'no eligible consumer: its consumer module is not background-eligible in its tenant, or its tenant is not active',
    };
  }
  if (row.unclaimedTooLong) {
    return { outcome: 'block', why: 'nothing has picked it up for longer than a whole drain budget' };
  }
  if (!row.matched) {
    return { outcome: 'block', why: 'its message is not matched yet' };
  }
  return { outcome: 'drain', why: 'a live consumer can claim it' };
};

/** Whether the retiring authority approved this delivery's worker key, and whether this release matches it. */
export const describeWorkerKeyIdentity = (
  workerKey: string,
  sets: {
    readonly approvedCoreSystemWorkerKeys: readonly string[];
    readonly approvedWorkerKeys: readonly string[];
    readonly carriedOverWorkerKeys: readonly string[];
  },
): string => {
  if (sets.carriedOverWorkerKeys.includes(workerKey)) {
    return 'identical';
  }
  if (sets.approvedCoreSystemWorkerKeys.includes(workerKey)) {
    return 'differs';
  }
  return sets.approvedWorkerKeys.includes(workerKey) ? 'not-core-system' : 'absent';
};

/** Deliveries whose message carries completion debt of the given revision; they stay with that revision. */
export const countTrackedDebt = Effect.fn('Outbox.countTrackedDebt')(function* countTrackedDebt(
  executor: CoreDbExecutor,
) {
  const [row] = yield* executor
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxDeliveries)
    .innerJoin(outboxMessages, eq(outboxMessages.outboxMessageId, outboxDeliveries.outboxMessageId))
    .where(
      and(
        notInArray(outboxDeliveries.status, ['done', 'released']),
        isNotNull(outboxMessages.completionOriginalRevision),
      ),
    );
  return row?.count ?? 0;
});
