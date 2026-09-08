import {
  Config,
  Effect,
  Exit,
  Function as Fn,
  Logger,
  ManagedRuntime,
  Option,
  Random,
  References,
  Schema,
  Tracer,
} from 'effect';
import type { Layer } from 'effect';

import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerRequirements,
  OutboxWorkerSubscription,
} from './definition.ts';
import type {
  createOutboxWorkerHealth,
  serveOutboxWorkerHealth,
} from './health.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from './poller.ts';
import type { RunOutboxPollingLoopInput } from './poller.ts';
import type { OutboxRuntime } from './runtime.ts';

const ShutdownSignalSchema = Schema.Literals(['SIGINT', 'SIGTERM']);
export type ShutdownSignal = typeof ShutdownSignalSchema.Type;

export interface RunOutboxWorkerProcessInput<
  Registration extends AnyOutboxWorkerRegistration =
    AnyOutboxWorkerRegistration,
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
  readonly layer: Layer.Layer<
    OutboxRuntime | OutboxWorkerRequirements<Registration>,
    LayerError
  >;
}

const waitForShutdownSignal = Effect.callback<ShutdownSignal>((resume) => {
  const onSignal = (signal: ShutdownSignal) => (): void =>
    resume(Effect.succeed(signal));
  const onSigint = onSignal('SIGINT');
  const onSigterm = onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return Effect.sync(() => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  });
});

const healthPortConfig = Config.option(
  Config.port('OUTBOX_WORKER_HEALTH_PORT')
);

export { OutboxRuntimeLive as OutboxWorkerInfrastructureLive } from './runtime.ts';

const processTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

interface OutboxWorkerHealthApi {
  readonly createOutboxWorkerHealth: typeof createOutboxWorkerHealth;
  readonly serveOutboxWorkerHealth: typeof serveOutboxWorkerHealth;
}

const loadOutboxWorkerHealthApi = Effect.suspend(() => {
  const healthApi: Promise<OutboxWorkerHealthApi> = import('./health.ts');
  return Effect.promise(Fn.constant(healthApi)).pipe(
    Effect.timeout('30 seconds'),
    Effect.orDie
  );
});

export const runOutboxWorkerProcess = <
  Registration extends AnyOutboxWorkerRegistration,
>(
  input: RunOutboxWorkerProcessInput<Registration>
) =>
  Effect.scoped(
    Effect.gen(function* runOutboxWorkerProcessEffect() {
      const processNonce = yield* Random.nextInt;
      const config = yield* parseOutboxPollingConfig({
        defaultClaimOwner: `${input.claimOwnerPrefix}:${process.pid}:${processNonce}`,
      });
      const healthApi =
        input.health === true ? yield* loadOutboxWorkerHealthApi : undefined;
      const health =
        healthApi === undefined
          ? undefined
          : yield* healthApi.createOutboxWorkerHealth({
              staleAfterMs: Math.max(5000, config.pollIntervalMs * 3),
            });
      if (health !== undefined && healthApi !== undefined) {
        const configuredHealthPort = yield* healthPortConfig;
        if (Option.isSome(configuredHealthPort)) {
          yield* healthApi.serveOutboxWorkerHealth(health, {
            port: configuredHealthPort.value,
          });
        }
      }
      yield* Effect.annotateLogs(
        Effect.logInfo('Outbox Worker process started'),
        {
          claimOwner: config.claimOwner,
          maxDeliveries: config.maxDeliveries,
          pollIntervalMs: config.pollIntervalMs,
          registrations: input.registrations.length,
        }
      );

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
          runOutboxPollingLoop(pollingInput).pipe(
            Effect.as<ShutdownSignal>('SIGTERM')
          )
        )
      );
      yield* Effect.logInfo(
        `Outbox Worker process received ${signal}; shutting down`
      );
    })
  );

export const startOutboxWorkerProcess = <
  Registration extends AnyOutboxWorkerRegistration,
  LayerError,
>(
  input: StartOutboxWorkerProcessInput<Registration, LayerError>
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
  runtime.runCallback(
    runOutboxWorkerProcess(processInput).pipe(
      Effect.withLogger(Logger.defaultLogger),
      Effect.withTracer(processTracer),
      Effect.provideService(References.MinimumLogLevel, 'Info'),
      Effect.ensuring(runtime.disposeEffect)
    ),
    {
      onExit: (exit) => {
        process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
      },
    }
  );
};
