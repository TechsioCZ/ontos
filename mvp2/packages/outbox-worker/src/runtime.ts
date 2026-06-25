// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off globalConsole:off globalConsoleInEffect:off globalDate:off missedPipeableOpportunity:off unknownInEffectCatch:off
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime';
import { Duration, Effect, Schedule } from 'effect';
import { claimDueDeliveries } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';
import { executeClaimedDelivery } from './execute.ts';
import { materializeDeliveries } from './materialize.ts';

export type OutboxWorkerRuntime = {
  readonly config: OutboxWorkerRuntimeConfig;
  readonly registrations: readonly OutboxWorkerRegistration<unknown>[];
};

export type OutboxWorkerTickResult = {
  readonly deliveriesClaimed: number;
  readonly deliveriesInserted: number;
  readonly messagesMatched: number;
};

export const runOutboxWorkerTick = async ({
  config,
  registrations,
}: OutboxWorkerRuntime): Promise<OutboxWorkerTickResult> => {
  const materialized = await materializeDeliveries({
    batchSize: config.materializeBatchSize,
    registrations,
  });
  const claimedDeliveries = await claimDueDeliveries({
    batchSize: config.claimBatchSize,
    claimTimeoutMs: config.claimTimeoutMs,
    runtimeId: config.runtimeId,
  });

  for (const claimedDelivery of claimedDeliveries) {
    await executeClaimedDelivery({
      claimedDelivery,
      registrations,
      runtimeConfig: config,
    });
  }

  return {
    deliveriesClaimed: claimedDeliveries.length,
    deliveriesInserted: materialized.deliveriesInserted,
    messagesMatched: materialized.messagesMatched,
  };
};

export const makeOutboxWorkerLoop = (runtime: OutboxWorkerRuntime): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => runOutboxWorkerTick(runtime),
    catch: (error) => error,
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (
          result.messagesMatched > 0 ||
          result.deliveriesInserted > 0 ||
          result.deliveriesClaimed > 0
        ) {
          console.info('[outbox-worker] tick', result);
        }
      }),
    ),
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.error('[outbox-worker] tick failed', error);
      }),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(runtime.config.pollIntervalMs))),
  );
