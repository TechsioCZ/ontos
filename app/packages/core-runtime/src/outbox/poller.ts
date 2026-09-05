/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect's typed catch combinator is not Promise chaining. */
import { Duration, Effect, Schedule } from 'effect';
import type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerRequirements,
  OutboxWorkerSubscription,
} from './definition.ts';
import { OutboxPollerConfigError } from './errors.ts';
import type { OutboxWorkerHealth } from './health.ts';
import { runOutboxCycle } from './runtime.ts';
import type {
  OutboxCycleError,
  OutboxCycleResult,
  OutboxRuntime,
  RunOutboxCycleInput,
} from './runtime.ts';

const DEFAULT_MAX_DELIVERIES = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;

type Environment = Readonly<Record<string, string | undefined>>;

export interface OutboxPollingConfig {
  readonly claimOwner: string;
  readonly maxDeliveries: number;
  readonly pollIntervalMs: number;
}

export interface ParseOutboxPollingConfigInput {
  readonly defaultClaimOwner: string;
  readonly environment?: Environment;
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
) => Effect.Effect<
  OutboxCycleResult,
  OutboxCycleError,
  RunnerRequirements | OutboxWorkerRequirements<Registration>
>;

const configError = (reason: string): OutboxPollerConfigError =>
  new OutboxPollerConfigError({ code: 'outbox_poller_config_invalid', reason });

const parseInteger = (
  environment: Environment,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): Effect.Effect<number, OutboxPollerConfigError> =>
  Effect.gen(function* parseIntegerEffect() {
    const value = environment[key]?.trim();
    if (value === undefined || value.length === 0) {
      return fallback;
    }
    if (!/^\d+$/u.test(value)) {
      return yield* configError(`${key} must be an integer from ${minimum} through ${maximum}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      return yield* configError(`${key} must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
  });

export const parseOutboxPollingConfig = ({
  defaultClaimOwner,
  environment = process.env,
}: ParseOutboxPollingConfigInput): Effect.Effect<OutboxPollingConfig, OutboxPollerConfigError> =>
  Effect.gen(function* parseOutboxPollingConfigEffect() {
    const claimOwner = environment['OUTBOX_WORKER_CLAIM_OWNER']?.trim() || defaultClaimOwner;
    if (claimOwner.length === 0 || claimOwner.length > 200) {
      return yield* configError(
        'OUTBOX_WORKER_CLAIM_OWNER must contain from 1 through 200 characters',
      );
    }
    const maxDeliveries = yield* parseInteger(
      environment,
      'OUTBOX_WORKER_MAX_DELIVERIES',
      DEFAULT_MAX_DELIVERIES,
      1,
      1000,
    );
    const pollIntervalMs = yield* parseInteger(
      environment,
      'OUTBOX_WORKER_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
      10,
      3_600_000,
    );
    return Object.freeze({ claimOwner, maxDeliveries, pollIntervalMs });
  });

const hasActivity = (result: OutboxCycleResult): boolean =>
  result.messagesMatched > 0 || result.deliveriesCreated > 0 || result.claimed > 0;

export function runOutboxPollingLoop<Registration extends AnyOutboxWorkerRegistration>(
  input: RunOutboxPollingLoopInput<Registration>,
): Effect.Effect<void, never, OutboxRuntime | OutboxWorkerRequirements<Registration>>;
export function runOutboxPollingLoop<
  Registration extends AnyOutboxWorkerRegistration,
  RunnerRequirements,
>(
  input: RunOutboxPollingLoopInput<Registration>,
  runCycle: OutboxCycleRunner<Registration, RunnerRequirements>,
): Effect.Effect<void, never, RunnerRequirements | OutboxWorkerRequirements<Registration>>;
export function runOutboxPollingLoop<
  Registration extends AnyOutboxWorkerRegistration,
  RunnerRequirements,
>(
  input: RunOutboxPollingLoopInput<Registration>,
  runCycle?: OutboxCycleRunner<Registration, RunnerRequirements>,
): Effect.Effect<
  void,
  never,
  OutboxRuntime | RunnerRequirements | OutboxWorkerRequirements<Registration>
> {
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
    Effect.catch((error) =>
      Effect.all(
        [
          input.health?.cycleFailed ?? Effect.void,
          Effect.annotateLogs(Effect.logError('Outbox polling cycle failed'), {
            errorTag: error._tag,
          }),
        ],
        { concurrency: 1 },
      ),
    ),
  );

  return tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(input.config.pollIntervalMs))),
    Effect.asVoid,
  );
}
