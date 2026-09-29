import { Config, ConfigProvider, Duration, Effect, Schedule, Schema } from 'effect';

import type { AnyOutboxWorkerRegistration, OutboxWorkerRequirements, OutboxWorkerSubscription } from './definition.ts';
import { OutboxPollerConfigError } from './errors.ts';
import type { OutboxWorkerHealth } from './health.ts';
import { runOutboxCycle } from './runtime.ts';
import type { OutboxCycleError, OutboxCycleResult, OutboxRuntime, RunOutboxCycleInput } from './runtime.ts';

const DEFAULT_MAX_DELIVERIES = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;

interface OutboxPollingEnvironment {
  readonly OUTBOX_WORKER_MAX_DELIVERIES?: string;
  readonly OUTBOX_WORKER_POLL_INTERVAL_MS?: string;
  readonly OUTBOX_WORKER_PROCESS_IDENTITY?: string;
}

export interface OutboxPollingConfig {
  readonly claimOwner: string;
  readonly maxDeliveries: number;
  readonly pollIntervalMs: number;
}

export interface ParseOutboxPollingConfigInput {
  /** One prefix per polling loop hosted by this process; each loop claims under its own owner. */
  readonly claimOwnerPrefixes: readonly string[];
  readonly defaultProcessIdentity: string;
  readonly environment?: OutboxPollingEnvironment;
}

export interface RunOutboxPollingLoopInput<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
> {
  readonly config: OutboxPollingConfig;
  readonly health?: Pick<OutboxWorkerHealth, 'cycleFailed' | 'cycleSucceeded'>;
  readonly registrations: readonly Registration[];
  readonly subscriptions: readonly OutboxWorkerSubscription[];
}

export type OutboxCycleRunner<
  Registration extends AnyOutboxWorkerRegistration = AnyOutboxWorkerRegistration,
  RunnerRequirements = OutboxRuntime,
> = (
  input: RunOutboxCycleInput<Registration>,
) => Effect.Effect<OutboxCycleResult, OutboxCycleError, RunnerRequirements | OutboxWorkerRequirements<Registration>>;

const configError = (reason: string): OutboxPollerConfigError =>
  new OutboxPollerConfigError({ code: 'outbox_poller_config_invalid', reason });

const EmptyConfigValue = Schema.Trim.pipe(Schema.decodeTo(Schema.Literal('')));
const ProcessIdentityOverride = Schema.Trim.check(Schema.isMaxLength(200));
const ClaimOwnerPrefix = Schema.String.check(Schema.isMinLength(1));
const ClaimOwner = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const boundedIntegerConfig = (key: string, fallback: number, minimum: number, maximum: number): Config.Config<number> =>
  Config.schema(
    Schema.Union([
      EmptyConfigValue,
      Schema.Trim.check(Schema.isPattern(/^\d+$/u)).pipe(
        Schema.decodeTo(Schema.FiniteFromString),
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isBetween({ maximum, minimum })),
      ),
    ]),
    key,
  ).pipe(
    Config.withDefault(fallback),
    Config.map((value) => (value === '' ? fallback : value)),
  );

const pollingConfig = (defaultProcessIdentity: string) =>
  Config.all({
    maxDeliveries: boundedIntegerConfig('OUTBOX_WORKER_MAX_DELIVERIES', DEFAULT_MAX_DELIVERIES, 1, 1000),
    pollIntervalMs: boundedIntegerConfig('OUTBOX_WORKER_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 10, 3_600_000),
    processIdentity: Config.schema(ProcessIdentityOverride, 'OUTBOX_WORKER_PROCESS_IDENTITY').pipe(
      Config.withDefault(defaultProcessIdentity),
      Config.map((value) => (value === '' ? defaultProcessIdentity : value)),
    ),
  });

const pollingConfigFailure = ({ message }: { readonly message: string }) => configError(message);

const requireDistinctPrefixes = (claimOwnerPrefixes: readonly string[]) => {
  if (claimOwnerPrefixes.length === 0) {
    return Effect.fail(configError('An Outbox Worker process must host at least one polling loop'));
  }
  const duplicate = claimOwnerPrefixes.find((prefix, index) => claimOwnerPrefixes.indexOf(prefix) !== index);
  return duplicate === undefined
    ? Effect.void
    : Effect.fail(configError(`Outbox Worker claim owner prefix ${duplicate} is hosted more than once`));
};

/**
 * Process-wide settings are read once. The process identity only ever fills the suffix of a claim
 * owner, so every hosted loop keeps its own `${prefix}:${processIdentity}` owner and no environment
 * value can make two loops in one process claim under the same identity.
 */
export const parseOutboxPollingConfig = ({
  claimOwnerPrefixes,
  defaultProcessIdentity,
  environment,
}: ParseOutboxPollingConfigInput): Effect.Effect<readonly OutboxPollingConfig[], OutboxPollerConfigError> => {
  const config = pollingConfig(defaultProcessIdentity);
  const decoded = environment === undefined ? config : config.parse(ConfigProvider.fromUnknown(environment));

  const configs = decoded.pipe(
    Effect.flatMap(({ maxDeliveries, pollIntervalMs, processIdentity }) =>
      Effect.forEach(
        claimOwnerPrefixes,
        (prefix) =>
          Schema.decodeEffect(ClaimOwnerPrefix)(prefix).pipe(
            Effect.flatMap((validPrefix) => Schema.decodeEffect(ClaimOwner)(`${validPrefix}:${processIdentity}`)),
            Effect.map((claimOwner) => Object.freeze({ claimOwner, maxDeliveries, pollIntervalMs })),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.mapError(pollingConfigFailure),
  );
  return requireDistinctPrefixes(claimOwnerPrefixes).pipe(Effect.andThen(configs));
};

const hasActivity = (result: OutboxCycleResult): boolean =>
  result.messagesMatched > 0 || result.deliveriesCreated > 0 || result.claimed > 0;

export function runOutboxPollingLoop<Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxPollingLoopInput<Registration>,
): Effect.Effect<void, never, OutboxRuntime | OutboxWorkerRequirements<Registration>>;
export function runOutboxPollingLoop<Registration extends AnyOutboxWorkerRegistration, RunnerRequirements>(
  input: RunOutboxPollingLoopInput<Registration>,
  runCycle: OutboxCycleRunner<Registration, RunnerRequirements>,
): Effect.Effect<void, never, RunnerRequirements | OutboxWorkerRequirements<Registration>>;
export function runOutboxPollingLoop<Registration extends AnyOutboxWorkerRegistration, RunnerRequirements>(
  input: RunOutboxPollingLoopInput<Registration>,
  runCycle?: OutboxCycleRunner<Registration, RunnerRequirements>,
): Effect.Effect<void, never, OutboxRuntime | RunnerRequirements | OutboxWorkerRequirements<Registration>> {
  const cycleInput = {
    claimOwner: input.config.claimOwner,
    maxDeliveries: input.config.maxDeliveries,
    registrations: input.registrations,
    subscriptions: input.subscriptions,
  };
  const cycle: Effect.Effect<
    OutboxCycleResult,
    OutboxCycleError,
    OutboxRuntime | RunnerRequirements | OutboxWorkerRequirements<Registration>
  > = runCycle === undefined ? runOutboxCycle(cycleInput) : runCycle(cycleInput);
  const tick = cycle.pipe(
    Effect.tap(() => input.health?.cycleSucceeded ?? Effect.void),
    Effect.tap((result) =>
      hasActivity(result)
        ? Effect.annotateLogs(Effect.logInfo('Outbox polling cycle completed'), {
            claimed: result.claimed,
            dead: result.dead,
            deliveriesCreated: result.deliveriesCreated,
            failed: result.failed,
            messagesMatched: result.messagesMatched,
            retried: result.retried,
            succeeded: result.succeeded,
          })
        : Effect.void,
    ),
    Effect.matchEffect({
      onFailure: (error) =>
        Effect.all(
          [
            input.health?.cycleFailed ?? Effect.void,
            Effect.annotateLogs(Effect.logError('Outbox polling cycle failed'), {
              errorTag: error._tag,
            }),
          ],
          { concurrency: 1 },
        ),
      onSuccess: () => Effect.void,
    }),
  );

  return tick.pipe(Effect.repeat(Schedule.spaced(Duration.millis(input.config.pollIntervalMs))), Effect.asVoid);
}
