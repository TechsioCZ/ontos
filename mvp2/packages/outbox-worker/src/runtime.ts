// @effect-diagnostics anyUnknownInErrorContext:off globalDate:off missedPipeableOpportunity:off unknownInEffectCatch:off
import type { OutboxWorkerRegistration } from '@mvp2/core-runtime/outbox';
import { Duration, Effect, Schedule } from 'effect';
import { claimDueDeliveries } from './claim.ts';
import type { OutboxWorkerRuntimeConfig } from './config.ts';
import { executeClaimedDelivery } from './execute.ts';
import type { OutboxWorkerError } from './errors.ts';
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

export const runOutboxWorkerTick = ({
  config,
  registrations,
}: OutboxWorkerRuntime): Effect.Effect<OutboxWorkerTickResult, OutboxWorkerError> =>
  Effect.gen(function* () {
    const materialized = yield* materializeDeliveries({
      batchSize: config.materializeBatchSize,
      registrations,
    });
    const claimedDeliveries = yield* claimDueDeliveries({
      batchSize: config.claimBatchSize,
      runtimeId: config.runtimeId,
    });

    yield* Effect.forEach(
      claimedDeliveries,
      (claimedDelivery) =>
        executeClaimedDelivery({
          claimedDelivery,
          registrations,
          runtimeConfig: config,
        }),
      { concurrency: 1, discard: true },
    );

    return {
      deliveriesClaimed: claimedDeliveries.length,
      deliveriesInserted: materialized.deliveriesInserted,
      messagesMatched: materialized.messagesMatched,
    };
  });

export const makeOutboxWorkerLoop = (runtime: OutboxWorkerRuntime): Effect.Effect<void> =>
  runOutboxWorkerTick(runtime).pipe(
    Effect.tap((result) =>
      result.messagesMatched > 0 || result.deliveriesInserted > 0 || result.deliveriesClaimed > 0
        ? Effect.logInfo('[outbox-worker] tick', result)
        : Effect.void,
    ),
    Effect.catchAll((error) => Effect.logError('[outbox-worker] tick failed', error)),
    Effect.repeat(Schedule.spaced(Duration.millis(runtime.config.pollIntervalMs))),
    Effect.asVoid,
  );
