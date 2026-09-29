import {
  Array as Arr,
  Cause,
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

import type { AnyOutboxWorkerRegistration, OutboxWorkerRequirements, OutboxWorkerSubscription } from './definition.ts';
import type {
  combineOutboxWorkerHealth,
  createOutboxWorkerHealth,
  OutboxWorkerHealth,
  serveOutboxWorkerHealth,
} from './health.ts';
import { parseOutboxPollingConfig, runOutboxPollingLoop } from './poller.ts';
import type { OutboxPollingConfig, RunOutboxPollingLoopInput } from './poller.ts';
import type { OutboxRuntime } from './runtime.ts';

const ShutdownSignalSchema = Schema.Literals(['SIGINT', 'SIGTERM']);
export type ShutdownSignal = typeof ShutdownSignalSchema.Type;

export interface DefineOutboxWorkerEntryInput<Registration extends AnyOutboxWorkerRegistration, LayerError> {
  readonly claimOwnerPrefix: string;
  readonly layer: Layer.Layer<OutboxRuntime | OutboxWorkerRequirements<Registration>, LayerError>;
  readonly registrations: readonly Registration[];
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}

export interface OutboxWorkerLoopInput {
  readonly config: OutboxPollingConfig;
  readonly health?: Pick<OutboxWorkerHealth, 'cycleFailed' | 'cycleSucceeded'>;
}

/**
 * One MicroVertical's hosted polling loop. The host runs each entry against its own
 * ManagedRuntime so owner layers stay as isolated as they were in dedicated processes.
 */
export interface OutboxWorkerEntry<out LayerError> {
  readonly claimOwnerPrefix: string;
  readonly registrations: number;
  readonly runLoop: (input: OutboxWorkerLoopInput) => Effect.Effect<void, LayerError>;
}

export interface RunOutboxWorkerHostInput<LayerError> {
  readonly entries: readonly OutboxWorkerEntry<LayerError>[];
  readonly health?: boolean;
}

export const defineOutboxWorkerEntry = <Registration extends AnyOutboxWorkerRegistration, LayerError>(
  input: DefineOutboxWorkerEntryInput<Registration, LayerError>,
): OutboxWorkerEntry<LayerError> =>
  Object.freeze({
    claimOwnerPrefix: input.claimOwnerPrefix,
    registrations: input.registrations.length,
    runLoop: ({ config, health }: OutboxWorkerLoopInput) => {
      const pollingInput: RunOutboxPollingLoopInput<Registration> = {
        config,
        registrations: input.registrations,
        subscriptions: input.subscriptions,
      };
      const loop = runOutboxPollingLoop(health === undefined ? pollingInput : { ...pollingInput, health });
      return Effect.acquireUseRelease(
        Effect.sync(() => ManagedRuntime.make(input.layer)),
        (runtime) => runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provideContext(loop, context))),
        (runtime) => runtime.disposeEffect,
      );
    },
  });

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

const healthPortConfig = Config.option(Config.Port('OUTBOX_WORKER_HEALTH_PORT'));

export { OutboxRuntimeLive as OutboxWorkerInfrastructureLive } from './runtime.ts';

const processTracer = Tracer.make({
  span: (options) => new Tracer.NativeSpan(options),
});

interface OutboxWorkerHealthApi {
  readonly combineOutboxWorkerHealth: typeof combineOutboxWorkerHealth;
  readonly createOutboxWorkerHealth: typeof createOutboxWorkerHealth;
  readonly serveOutboxWorkerHealth: typeof serveOutboxWorkerHealth;
}

const loadOutboxWorkerHealthApi = Effect.suspend(() => {
  const healthApi: Promise<OutboxWorkerHealthApi> = import('./health.ts');
  return Effect.promise(Fn.constant(healthApi)).pipe(Effect.timeout('30 seconds'), Effect.orDie);
});

interface HostedLoop<LayerError> {
  readonly config: OutboxPollingConfig;
  readonly entry: OutboxWorkerEntry<LayerError>;
  readonly health: Option.Option<OutboxWorkerHealth>;
}

const hostedLoop = <LayerError>(
  entry: OutboxWorkerEntry<LayerError>,
  config: OutboxPollingConfig,
  healthApi: OutboxWorkerHealthApi | undefined,
): Effect.Effect<HostedLoop<LayerError>> =>
  healthApi === undefined
    ? Effect.succeed({ config, entry, health: Option.none() })
    : healthApi
        .createOutboxWorkerHealth({ staleAfterMs: Math.max(5000, config.pollIntervalMs * 3) })
        .pipe(Effect.map((health) => ({ config, entry, health: Option.some(health) })));

/**
 * Runs every entry's polling loop in one process behind one signal handler and one readiness
 * endpoint. The first loop to fail interrupts the others; each loop disposes its own runtime
 * before the host scope closes, so the failure surfaces only after every runtime is released.
 */
export const runOutboxWorkerHost = <LayerError>(input: RunOutboxWorkerHostInput<LayerError>) =>
  Effect.scoped(
    Effect.gen(function* runOutboxWorkerHostEffect() {
      const processNonce = yield* Random.nextInt;
      const configs = yield* parseOutboxPollingConfig({
        claimOwnerPrefixes: input.entries.map((entry) => entry.claimOwnerPrefix),
        defaultProcessIdentity: `${process.pid}:${processNonce}`,
      });
      const healthApi = input.health === true ? yield* loadOutboxWorkerHealthApi : undefined;
      const loops: readonly HostedLoop<LayerError>[] = yield* Effect.forEach(
        Arr.zip(input.entries, configs),
        ([entry, config]) => hostedLoop(entry, config, healthApi),
        { concurrency: 1 },
      );
      if (healthApi !== undefined) {
        const configuredHealthPort = yield* healthPortConfig;
        if (Option.isSome(configuredHealthPort)) {
          yield* healthApi.serveOutboxWorkerHealth(
            healthApi.combineOutboxWorkerHealth(loops.flatMap(({ health }) => Option.toArray(health))),
            { port: configuredHealthPort.value },
          );
        }
      }
      yield* Effect.forEach(
        loops,
        ({ config, entry }) =>
          Effect.annotateLogs(Effect.logInfo('Outbox Worker loop started'), {
            claimOwner: config.claimOwner,
            maxDeliveries: config.maxDeliveries,
            pollIntervalMs: config.pollIntervalMs,
            registrations: entry.registrations,
          }),
        { concurrency: 1, discard: true },
      );

      const runLoops = Effect.forEach(
        loops,
        ({ config, entry, health }) =>
          entry
            .runLoop(
              Option.match(health, {
                onNone: () => ({ config }),
                onSome: (loopHealth) => ({ config, health: loopHealth }),
              }),
            )
            .pipe(Effect.annotateLogs({ claimOwner: config.claimOwner })),
        // Every hosted loop polls forever, so the host needs exactly one fiber per loop.
        { concurrency: loops.length, discard: true },
      );
      const signal = yield* waitForShutdownSignal.pipe(
        Effect.raceFirst(runLoops.pipe(Effect.as<ShutdownSignal>('SIGTERM'))),
      );
      yield* Effect.logInfo(`Outbox Worker host received ${signal}; shutting down`);
    }),
  );

/**
 * Name every failure reason by its tag only, so a defect raised beside a typed failure (for example
 * by a finalizer) stays visible. A raw cause can carry database diagnostics or credentials, and
 * Outbox telemetry excludes raw causes, stacks, and messages.
 */
const describeWorkerFailure = <E extends { readonly _tag: string }>(cause: Cause.Cause<E>): string => {
  const names = cause.reasons.map((reason) => {
    if (Cause.isFailReason(reason)) {
      return reason.error._tag;
    }
    return Cause.isDieReason(reason) ? 'Defect' : 'Interrupted';
  });
  return [...new Set(names)].join(', ');
};

export const startOutboxWorkerHost = <LayerError extends { readonly _tag: string }>(
  input: RunOutboxWorkerHostInput<LayerError>,
): void => {
  Effect.runCallback(
    runOutboxWorkerHost(input).pipe(
      Effect.withLogger(Logger.defaultLogger),
      Effect.withTracer(processTracer),
      Effect.provideService(References.MinimumLogLevel, 'Info'),
    ),
    {
      onExit: (exit) => {
        if (Exit.isFailure(exit)) {
          process.stderr.write(`Outbox Worker host failed: ${describeWorkerFailure(exit.cause)}\n`);
        }
        process.exitCode = Exit.isSuccess(exit) ? 0 : 1;
      },
    },
  );
};
