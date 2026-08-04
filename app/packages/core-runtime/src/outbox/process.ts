/* eslint-disable promise/prefer-await-to-then -- Promises are used only at the Node process edge. */
import { Effect, Layer, ManagedRuntime, Random } from 'effect';
import { DatabaseConfigLive } from '../db/config.ts';
import { CoreDatabaseLive } from '../db/client.ts';
import type { AnyOutboxWorkerRegistration, OutboxWorkerRequirements } from './definition.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from './poller.ts';
import { OutboxRuntimeLive } from './runtime.ts';
import type { OutboxRuntime } from './runtime.ts';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface RunOutboxWorkerProcessInput<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
> {
  readonly claimOwnerPrefix: string;
  readonly registrations: readonly Registration[];
}

export interface StartOutboxWorkerProcessInput<
  Registration extends AnyOutboxWorkerRegistration,
  LayerError,
> extends RunOutboxWorkerProcessInput<Registration> {
  readonly layer: Layer.Layer<
    OutboxRuntime | OutboxWorkerRequirements<Registration>,
    LayerError,
    never
  >;
}

const waitForShutdownSignal = Effect.callback<ShutdownSignal>((resume) => {
  const onSignal = (signal: ShutdownSignal) => (): void => resume(Effect.succeed(signal));
  const onSigint = onSignal('SIGINT');
  const onSigterm = onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return Effect.sync(() => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  });
});

export const OutboxWorkerInfrastructureLive = OutboxRuntimeLive.pipe(
  Layer.provide(CoreDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

export const runOutboxWorkerProcess = <Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxWorkerProcessInput<Registration>,
) =>
  Effect.gen(function* runOutboxWorkerProcessEffect() {
    const processNonce = yield* Random.nextInt;
    const config = yield* parseOutboxPollingConfig({
      defaultClaimOwner: `${input.claimOwnerPrefix}:${process.pid}:${processNonce}`,
    });
    yield* Effect.annotateLogs(Effect.logInfo('Outbox Worker process started'), {
      claimOwner: config.claimOwner,
      maxDeliveries: config.maxDeliveries,
      pollIntervalMs: config.pollIntervalMs,
      registrations: input.registrations.length,
    });

    const signal = yield* waitForShutdownSignal.pipe(
      Effect.raceFirst(
        runOutboxPollingLoop({ config, registrations: input.registrations }).pipe(
          Effect.as<ShutdownSignal>('SIGTERM'),
        ),
      ),
    );
    yield* Effect.logInfo(`Outbox Worker process received ${signal}; shutting down`);
  });

export const startOutboxWorkerProcess = <
  Registration extends AnyOutboxWorkerRegistration,
  LayerError,
>(
  input: StartOutboxWorkerProcessInput<Registration, LayerError>,
): void => {
  const runtime = ManagedRuntime.make(input.layer);
  void runtime
    .runPromise(
      runOutboxWorkerProcess({
        claimOwnerPrefix: input.claimOwnerPrefix,
        registrations: input.registrations,
      }),
    )
    .then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    )
    .finally(() => runtime.dispose());
};
