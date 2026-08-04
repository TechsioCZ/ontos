/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect's typed catch combinator is not Promise chaining. */
import { Duration, Effect, Schedule, Schema } from 'effect';
import type { AnyOutboxWorkerRegistration, OutboxWorkerRequirements } from './definition.ts';
import { OutboxPollerConfigError } from './errors.ts';
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
  readonly registrations: readonly Registration[];
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
): number => {
  const value = environment[key]?.trim();
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  if (!/^\d+$/u.test(value)) {
    throw configError(`${key} must be an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configError(`${key} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
};

export const parseOutboxPollingConfig = ({
  defaultClaimOwner,
  environment = process.env,
}: ParseOutboxPollingConfigInput): Effect.Effect<OutboxPollingConfig, OutboxPollerConfigError> =>
  Effect.try({
    catch: (error) =>
      Schema.is(OutboxPollerConfigError)(error)
        ? error
        : configError('The Outbox polling configuration is invalid'),
    try: () => {
      const claimOwner = environment['OUTBOX_WORKER_CLAIM_OWNER']?.trim() || defaultClaimOwner;
      if (claimOwner.length === 0 || claimOwner.length > 200) {
        throw configError('OUTBOX_WORKER_CLAIM_OWNER must contain from 1 through 200 characters');
      }
      return Object.freeze({
        claimOwner,
        maxDeliveries: parseInteger(
          environment,
          'OUTBOX_WORKER_MAX_DELIVERIES',
          DEFAULT_MAX_DELIVERIES,
          1,
          1000,
        ),
        pollIntervalMs: parseInteger(
          environment,
          'OUTBOX_WORKER_POLL_INTERVAL_MS',
          DEFAULT_POLL_INTERVAL_MS,
          10,
          3_600_000,
        ),
      });
    },
  });

const hasActivity = (result: OutboxCycleResult): boolean =>
  result.messagesMatched > 0 || result.deliveriesCreated > 0 || result.claimed > 0;

export const runOutboxPollingLoop = <
  Registration extends AnyOutboxWorkerRegistration,
  RunnerRequirements = OutboxRuntime,
>(
  input: RunOutboxPollingLoopInput<Registration>,
  runCycle: OutboxCycleRunner<
    Registration,
    RunnerRequirements
  > = runOutboxCycle as OutboxCycleRunner<Registration, RunnerRequirements>,
): Effect.Effect<void, never, RunnerRequirements | OutboxWorkerRequirements<Registration>> => {
  const tick = runCycle({
    claimOwner: input.config.claimOwner,
    maxDeliveries: input.config.maxDeliveries,
    registrations: input.registrations,
  }).pipe(
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
      Effect.annotateLogs(Effect.logError('Outbox polling cycle failed'), {
        errorTag: error._tag,
      }),
    ),
  );

  return tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(input.config.pollIntervalMs))),
    Effect.asVoid,
  );
};
