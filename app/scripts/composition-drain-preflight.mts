#!/usr/bin/env node
/**
 * Read-only answer to one question before a deploy: would a publication of this release start its Outbox drain,
 * or would it refuse because something can never finish?
 *
 * It runs the publisher's own pre-flight and carry-over classification against the authority row as it stands,
 * writes nothing, and takes no advisory lock, so it can never stall a running publisher or a release. The verdict
 * is advisory for exactly that reason: a publisher re-asks under its own publication lock before it acts.
 *
 * It prints identifiers, worker keys, statuses and times only — never a message payload or personal data.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Console, DateTime, Effect, Layer, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { CoreDatabase } from '../packages/core-runtime/src/db/client.ts';
import { applicationCompositionAuthority } from '../packages/core-runtime/src/db/schema.ts';
import { carriedOverCoreSystemWorkerKeys } from '../packages/core-runtime/src/modules/application-composition-authority.ts';
import {
  classifyDrainWork,
  countDrainWork,
  countTrackedDebt,
  countUnmatchedMessages,
  describeWorkerKeyIdentity,
  listDrainWork,
} from '../packages/core-runtime/src/outbox/drain-preflight.ts';
import {
  describeUndrainableOutboxWork,
  listUndrainableOutboxWork,
} from '../packages/core-runtime/src/outbox/undrainable-work.ts';
import {
  APPLICATION_COMPOSITION_PUBLICATION_BUDGETS,
  ApplicationCompositionAuthorityAdminDatabaseLive,
} from './application-composition-authority-publication.mts';

export class CompositionDrainPreflightError extends Schema.TaggedError<CompositionDrainPreflightError>()(
  'CompositionDrainPreflightError',
  { reason: Schema.String },
) {}

const instant = (at: Date) => DateTime.formatIso(DateTime.makeUnsafe(at));

const preflight = (budgetMs: number, limit: number) =>
  Effect.gen(function* runPreflight() {
    const database = yield* CoreDatabase;
    const [authority] = yield* database.executor
      .select({
        durableWorkAdmission: applicationCompositionAuthority.durableWorkAdmission,
        phase: applicationCompositionAuthority.phase,
        revision: applicationCompositionAuthority.revision,
        validUntil: applicationCompositionAuthority.validUntil,
      })
      .from(applicationCompositionAuthority)
      .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
    if (authority === undefined) {
      yield* Console.log('No Application Composition authority row: the next publication is an initial cutover.');
      return true;
    }
    yield* Console.log(
      `authority phase=${authority.phase} admission=${authority.durableWorkAdmission} ` +
        `revision=${authority.revision} validUntil=${instant(authority.validUntil)}`,
    );

    // No lock: a plain read of the same row the publisher reads, so this command never blocks a publication.
    const sets = yield* database.executor.transaction((transaction) => carriedOverCoreSystemWorkerKeys(transaction));
    const [counts, unmatched, trackedDebt, rows] = yield* Effect.all(
      [
        countDrainWork(database.executor),
        countUnmatchedMessages(database.executor),
        countTrackedDebt(database.executor),
        listDrainWork(database.executor, {
          budgetMs,
          carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
          coreSystemConsumers: sets.coreSystemConsumers,
          limit,
        }),
      ],
      { concurrency: 1 },
    );

    yield* Console.log(
      `unmatched messages=${String(unmatched)}; non-terminal deliveries carrying completion debt=${String(trackedDebt)}`,
    );
    if (counts.length === 0) {
      yield* Console.log('non-terminal Outbox work: none');
    } else {
      yield* Console.log('non-terminal Outbox work by worker key and status:');
      for (const row of counts) {
        yield* Console.log(`  ${row.workerKey} ${row.status} ${String(row.count)}`);
      }
    }

    if (rows.length > 0) {
      yield* Console.log(`how the next drain would treat each row (first ${String(rows.length)}):`);
    }
    for (const row of rows) {
      const { outcome, why } = classifyDrainWork(row);
      const identity = describeWorkerKeyIdentity(row.workerKey, sets);
      yield* Console.log(
        `  ${outcome.toUpperCase()} ${row.workerKey} identity=${identity} status=${row.status} ` +
          `attempts=${String(row.attemptsCount)} claimed=${String(row.claimed)} matched=${String(row.matched)} ` +
          `availableAt=${instant(row.availableAt)} tenant=${row.tenantId} message=${row.outboxMessageId} — ${why}`,
      );
    }

    // The verdict itself is the publisher's own pre-flight, not a re-implementation of it.
    const undrainable = yield* listUndrainableOutboxWork(database.executor, {
      budgetMs,
      carriedOverWorkerKeys: sets.carriedOverWorkerKeys,
      coreSystemConsumers: sets.coreSystemConsumers,
    });
    const described = describeUndrainableOutboxWork(undrainable.filter((delivery) => delivery.reason !== 'dead'));
    // The pre-flight only ever runs for an `active` authority. Say what the publisher would really do otherwise,
    // and count unmatched messages, which the drain and every seal block on just as hard.
    const blockers = [
      ...(undrainable.length === 0 ? [] : [`${String(undrainable.length)} delivery(ies) would be refused`]),
      ...(unmatched === 0 ? [] : [`${String(unmatched)} unmatched message(s) would block the drain`]),
    ];
    if (authority.phase === 'draining') {
      yield* Console.log(
        'this authority is draining: the running release already refuses reads, and a publication would resume its Outbox drain rather than run this pre-flight. Follow "Returning a stuck authority to active" in docs/architecture/DEPLOYMENT.md.',
      );
      return false;
    }
    if (authority.phase === 'sealed') {
      yield* Console.log(
        'this authority is sealed: a replacement publication is refused outright until a migration completes.',
      );
      return false;
    }
    const starts = blockers.length === 0;
    const skipsDrain = authority.phase === 'migrated';
    yield* Console.log(
      `a publication of this release would ${skipsDrain ? 'promote without a drain (the authority is migrated), and its promotion check' : 'start its drain'}: ${
        starts ? 'yes' : `no (${blockers.join('; ')})`
      }`,
    );
    if (described !== '') {
      yield* Console.log(described);
    }
    if (undrainable.some((delivery) => delivery.reason === 'dead')) {
      yield* Console.log('Dead deliveries must be redriven or released first: `pnpm outbox:dead-delivery list`.');
    }
    return starts;
  });

const command = Command.make(
  'composition-drain-preflight',
  {
    budgetMs: Flag.Int('budget-ms').pipe(
      Flag.withDefault(APPLICATION_COMPOSITION_PUBLICATION_BUDGETS.drainMs),
      Flag.withDescription('Drain budget the verdict assumes, in milliseconds'),
    ),
    limit: Flag.Int('limit').pipe(
      Flag.withDefault(200),
      Flag.withDescription('How many outstanding deliveries to describe individually'),
    ),
  },
  ({ budgetMs, limit }) =>
    preflight(budgetMs, limit).pipe(
      Effect.flatMap((starts) =>
        starts
          ? Effect.void
          : Effect.fail(
              new CompositionDrainPreflightError({
                reason: 'Outstanding Outbox work would refuse this release’s drain; resolve the rows above first',
              }),
            ),
      ),
    ),
).pipe(
  Command.withDescription('Report, without writing anything, whether a publication would start its Outbox drain'),
  Command.provide(() => ApplicationCompositionAuthorityAdminDatabaseLive),
);

export const main = Command.run({ version: '1.0.0' })(command);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
