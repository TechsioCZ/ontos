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
  Order,
  Random,
  References,
  Schema,
  Tracer,
} from 'effect';
import type { Layer } from 'effect';

import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import { buildApplicationCompositionCatalog } from '../modules/application-composition-catalog.ts';
import { OntosOutboxSubscriptionContractSchema } from '../modules/manifest.ts';
import { OutboxWorkerDescriptorError } from './errors.ts';
import { ActiveApplicationCompositionUnavailableError } from '../modules/active-application-composition-errors.ts';

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

const sameSubscriptions = Schema.toEquivalence(Schema.Array(OntosOutboxSubscriptionContractSchema));
const subscriptionOrder = Order.mapInput(Order.String, ({ workerKey }: { readonly workerKey: string }) => workerKey);
const unavailableSubscriptionCatalog = (cause: unknown) =>
  new ActiveApplicationCompositionUnavailableError({
    cause,
    reason: 'The complete Application Composition subscription catalog is unavailable',
  });

const ShutdownSignalSchema = Schema.Literals(['SIGINT', 'SIGTERM']);
export type ShutdownSignal = typeof ShutdownSignalSchema.Type;

export interface DefineOutboxWorkerEntryInput<Registration extends AnyOutboxWorkerRegistration, LayerError> {
  readonly claimOwnerPrefix: string;
  /** Identity compiled into this owner artifact, independent of mutable process configuration. */
  readonly expectedDeployment: Readonly<{ appId: string; buildMarker: string }>;
  readonly layer: Layer.Layer<
    OutboxRuntime | ActiveApplicationCompositionService | OutboxWorkerRequirements<Registration>,
    LayerError
  >;
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
): OutboxWorkerEntry<LayerError | ActiveApplicationCompositionUnavailableError | OutboxWorkerDescriptorError> => {
  const expectedDeployment = Object.freeze({ ...input.expectedDeployment });
  const registrations = Object.freeze([...input.registrations]);
  const compiledSubscriptions = Object.freeze(
    input.subscriptions.map((subscription) => Object.freeze({ ...subscription })),
  );
  return Object.freeze({
    claimOwnerPrefix: input.claimOwnerPrefix,
    registrations: registrations.length,
    runLoop: ({ config, health }: OutboxWorkerLoopInput) => {
      const loop = Effect.gen(function* runCompiledOutboxWorkerLoop() {
        const authority = yield* ActiveApplicationCompositionService;
        const suppliedSubscriptions = yield* Schema.decodeUnknownEffect(
          Schema.Array(OntosOutboxSubscriptionContractSchema),
          { onExcessProperty: 'error' },
        )(compiledSubscriptions).pipe(
          Effect.mapError(
            (cause) =>
              new ActiveApplicationCompositionUnavailableError({
                cause,
                reason: 'The compiled Outbox Worker subscription contract is invalid',
              }),
          ),
          Effect.map((subscriptions) => subscriptions.toSorted(subscriptionOrder)),
        );
        const admitComposition = Effect.gen(function* admitWorkerComposition() {
          const snapshot = yield* authority.load.pipe(Effect.flatMap(validateActiveApplicationCompositionSnapshot));
          const modulesById = new Map<string, (typeof snapshot.composition.modules)[number]>();
          for (const module of snapshot.composition.modules) {
            modulesById.set(module.moduleId, module);
          }
          for (const registration of registrations) {
            const approved = modulesById.get(registration.descriptor.consumerModuleKey);
            if (
              approved === undefined ||
              approved.deployment.appId !== expectedDeployment.appId ||
              approved.deployment.buildMarker !== expectedDeployment.buildMarker
            ) {
              return yield* new OutboxWorkerDescriptorError({
                code: 'outbox_worker_descriptor_invalid',
                reason: 'The compiled Outbox Worker owner artifact is not approved by this Application Composition',
              });
            }
          }
          const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(
            Effect.mapError(unavailableSubscriptionCatalog),
          );
          const ownerModules = new Set<string>();
          for (const { deployment, moduleId } of snapshot.composition.modules) {
            if (
              deployment.appId === expectedDeployment.appId &&
              deployment.buildMarker === expectedDeployment.buildMarker
            ) {
              ownerModules.add(moduleId);
            }
          }
          const approvedSubscriptions: (typeof OntosOutboxSubscriptionContractSchema.Type)[] = [];
          for (const { runtime } of catalog.contracts) {
            for (const subscription of runtime.outboxSubscriptions) {
              if (ownerModules.has(subscription.consumerModuleKey)) {
                approvedSubscriptions.push(subscription);
              }
            }
          }
          approvedSubscriptions.sort(subscriptionOrder);
          if (!sameSubscriptions(approvedSubscriptions, suppliedSubscriptions)) {
            return yield* new OutboxWorkerDescriptorError({
              code: 'outbox_worker_descriptor_invalid',
              reason: 'The compiled Outbox Worker subscriptions differ from the complete approved owner contract',
            });
          }
          return snapshot.composition.revision;
        });
        const pollingInput: RunOutboxPollingLoopInput<Registration> = {
          admitComposition,
          config,
          registrations,
          subscriptions: compiledSubscriptions,
        };
        // The compiled owner and ABI stay fixed. Each new cycle captures one approved revision;
        // existing claimed handler contexts retain their original revision in owner transactions.
        return yield* runOutboxPollingLoop(health === undefined ? pollingInput : { ...pollingInput, health });
      });
      return Effect.acquireUseRelease(
        Effect.sync(() => ManagedRuntime.make(input.layer)),
        (runtime) => runtime.contextEffect.pipe(Effect.flatMap((context) => Effect.provideContext(loop, context))),
        (runtime) => runtime.disposeEffect,
      );
    },
  });
};

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
