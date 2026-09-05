/* oxlint-disable typescript/return-await */
// @effect-diagnostics asyncFunction:off
/* eslint-disable promise/prefer-await-to-then -- Promises are used only at the Node process edge. */
import { Config, Effect, Layer, ManagedRuntime, Option, Random } from 'effect';
import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerRequirements,
  OutboxWorkerSubscription,
} from './definition.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from './poller.ts';
import type { RunOutboxPollingLoopInput } from './poller.ts';
import { createOutboxWorkerHealth, serveOutboxWorkerHealth } from './health.ts';
import { OutboxRuntimeLive } from './runtime.ts';
import type { OutboxRuntime } from './runtime.ts';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface RunOutboxWorkerProcessInput<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
> {
  readonly claimOwnerPrefix: string;
  readonly health?: boolean;
  readonly registrations: readonly Registration[];
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}

export interface StartOutboxWorkerProcessInput<
  Registration extends AnyOutboxWorkerRegistration,
  LayerError,
> extends RunOutboxWorkerProcessInput<Registration> {
  readonly layer: Layer.Layer<OutboxRuntime | OutboxWorkerRequirements<Registration>, LayerError>;
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

const healthPortConfig = Config.option(Config.port('OUTBOX_WORKER_HEALTH_PORT'));

/**
 * Dependency-transparent Outbox Worker runtime layer.
 *
 * The worker host composes OutboxRepository and CoreDatabase at its process root.
 */
export const OutboxWorkerInfrastructureLive = OutboxRuntimeLive;

export const runOutboxWorkerProcess = <Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxWorkerProcessInput<Registration>,
) =>
  Effect.scoped(
    Effect.gen(function* runOutboxWorkerProcessEffect() {
      const processNonce = yield* Random.nextInt;
      const config = yield* parseOutboxPollingConfig({
        defaultClaimOwner: `${input.claimOwnerPrefix}:${process.pid}:${processNonce}`,
      });
      const health =
        input.health === true
          ? yield* createOutboxWorkerHealth({
              staleAfterMs: Math.max(5000, config.pollIntervalMs * 3),
            })
          : undefined;
      if (health !== undefined) {
        const configuredHealthPort = yield* healthPortConfig;
        if (Option.isSome(configuredHealthPort)) {
          yield* serveOutboxWorkerHealth(health, { port: configuredHealthPort.value });
        }
      }
      yield* Effect.annotateLogs(Effect.logInfo('Outbox Worker process started'), {
        claimOwner: config.claimOwner,
        maxDeliveries: config.maxDeliveries,
        pollIntervalMs: config.pollIntervalMs,
        registrations: input.registrations.length,
      });

      let pollingInput: RunOutboxPollingLoopInput<Registration> = {
        config,
        registrations: input.registrations,
        subscriptions: input.subscriptions,
      };
      if (health !== undefined) {
        pollingInput = { ...pollingInput, health };
      }
      const signal = yield* waitForShutdownSignal.pipe(
        Effect.raceFirst(
          runOutboxPollingLoop(pollingInput).pipe(Effect.as<ShutdownSignal>('SIGTERM')),
        ),
      );
      yield* Effect.logInfo(`Outbox Worker process received ${signal}; shutting down`);
    }),
  );

export const startOutboxWorkerProcess = <
  Registration extends AnyOutboxWorkerRegistration,
  LayerError,
>(
  input: StartOutboxWorkerProcessInput<Registration, LayerError>,
): void => {
  let processInput: RunOutboxWorkerProcessInput<Registration> = {
    claimOwnerPrefix: input.claimOwnerPrefix,
    registrations: input.registrations,
    subscriptions: input.subscriptions,
  };
  if (input.health !== undefined) {
    processInput = { ...processInput, health: input.health };
  }
  const runtime = ManagedRuntime.make(input.layer);
  void runtime
    .runPromise(runOutboxWorkerProcess(processInput))
    .then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    )
    .finally(async () => runtime.dispose());
};
