import { Config, ConfigProvider, Duration, Effect, Schedule, Schema } from 'effect';
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

interface OutboxPollingEnvironment {
  readonly OUTBOX_WORKER_CLAIM_OWNER?: string;
  readonly OUTBOX_WORKER_MAX_DELIVERIES?: string;
  readonly OUTBOX_WORKER_POLL_INTERVAL_MS?: string;
}

export interface OutboxPollingConfig {
  readonly claimOwner: string;
  readonly maxDeliveries: number;
  readonly pollIntervalMs: number;
}

export interface ParseOutboxPollingConfigInput {
  readonly defaultClaimOwner: string;
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
) => Effect.Effect<
  OutboxCycleResult,
  OutboxCycleError,
  RunnerRequirements | OutboxWorkerRequirements<Registration>
>;

const configError = (reason: string): OutboxPollerConfigError =>
  new OutboxPollerConfigError({ code: 'outbox_poller_config_invalid', reason });

const EmptyConfigValue = Schema.Trim.pipe(Schema.decodeTo(Schema.Literal('')));
const ClaimOwnerOverride = Schema.Trim.check(Schema.isMaxLength(200));
const ClaimOwner = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const boundedIntegerConfig = (
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): Config.Config<number> =>
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

const pollingConfig = (defaultClaimOwner: string) =>
  Config.all({
    claimOwner: Config.schema(ClaimOwnerOverride, 'OUTBOX_WORKER_CLAIM_OWNER').pipe(
      Config.withDefault(defaultClaimOwner),
      Config.map((value) => (value === '' ? defaultClaimOwner : value)),
    ),
    maxDeliveries: boundedIntegerConfig(
      'OUTBOX_WORKER_MAX_DELIVERIES',
      DEFAULT_MAX_DELIVERIES,
      1,
      1000,
    ),
    pollIntervalMs: boundedIntegerConfig(
      'OUTBOX_WORKER_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
      10,
      3_600_000,
    ),
  });

const pollingConfigFailure = ({ message }: { readonly message: string }) => configError(message);

export const parseOutboxPollingConfig = ({
  defaultClaimOwner,
  environment,
}: ParseOutboxPollingConfigInput): Effect.Effect<OutboxPollingConfig, OutboxPollerConfigError> => {
  const config = pollingConfig(defaultClaimOwner);
  const decoded =
    environment === undefined ? config : config.parse(ConfigProvider.fromUnknown(environment));

  return decoded.pipe(
    Effect.flatMap((value) =>
      Schema.decodeEffect(ClaimOwner)(value.claimOwner).pipe(
        Effect.map((claimOwner) => Object.freeze({ ...value, claimOwner })),
      ),
    ),
    Effect.mapError(pollingConfigFailure),
  );
};

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

  return tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(input.config.pollIntervalMs))),
    Effect.asVoid,
  );
}
