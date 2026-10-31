import type { OutboxWorkerEntry } from '@app/core-runtime/outbox/worker';
import { Clock, Config, Effect, Option, Redacted, Ref, Schema, Semaphore } from 'effect';

import { CommerceEnrollmentContinuation } from '../enrollment/continuation/enrollment-continuation.ts';
import { commerceEnrollmentContinuationSweeperFor } from '../workers/enrollment-continuation-sweeper.ts';

const RECOVERY_INTERVAL_MS = 30_000;
const RECOVERY_CYCLE_TIMEOUT_MS = 60_000;
const RECOVERY_STALE_AFTER_MS = 90_000;
const RETRY_INITIAL_MS = 1000;
const RETRY_MAX_MS = 30_000;

export class CommerceEnrollmentRecoveryConfigurationError extends Schema.TaggedError<CommerceEnrollmentRecoveryConfigurationError>()(
  'CommerceEnrollmentRecoveryConfigurationError',
  {
    reason: Schema.Literal('Commerce enrollment recovery gateway configuration is missing or malformed'),
  },
) {}

const recoveryConfigurationFailure = (cause: unknown): CommerceEnrollmentRecoveryConfigurationError =>
  Object.defineProperty(
    new CommerceEnrollmentRecoveryConfigurationError({
      reason: 'Commerce enrollment recovery gateway configuration is missing or malformed',
    }),
    'cause',
    { enumerable: false, value: cause },
  );

const gatewayUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
      ? undefined
      : 'The owner gateway URL must be HTTP(S) without credentials, query or fragment',
  ),
);

/** The owner adapters read these lazily. An empty journal must not conceal missing credentials. */
export const validateCommerceEnrollmentRecoveryConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(gatewayUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
}).pipe(
  Effect.mapError(recoveryConfigurationFailure),
  Effect.filterOrFail(
    ({ apiKey }) => Redacted.value(apiKey).trim().length > 0,
    () => recoveryConfigurationFailure('empty-gateway-credential'),
  ),
  Effect.asVoid,
);

export interface CommerceEnrollmentRecoveryCycleHealth {
  readonly cycleFailed: Effect.Effect<void>;
  readonly cycleSucceeded: Effect.Effect<void>;
}

interface RecoveryHealth {
  readonly outbox: CommerceEnrollmentRecoveryCycleHealth;
  readonly recovery: CommerceEnrollmentRecoveryCycleHealth;
}

interface CycleState {
  readonly outbox: Option.Option<number>;
  readonly recovery: Option.Option<number>;
}

/**
 * Both clocks belong to this owner invocation. A successful outbox cycle cannot renew recovery's
 * clock or clear its failure, and recovery cannot clear an outbox admission failure.
 */
export const makeCommerceEnrollmentRecoveryHealth = Effect.fn('CommerceEnrollmentRecovery.health')(
  function* makeCommerceEnrollmentRecoveryHealthEffect(
    outboxStaleAfterMillis: number,
    health?: CommerceEnrollmentRecoveryCycleHealth,
  ): Effect.fn.Return<RecoveryHealth> {
    const state = yield* Ref.make<CycleState>({ outbox: Option.none(), recovery: Option.none() });
    const mutex = yield* Semaphore.make(1);
    const update = (kind: keyof CycleState, success: boolean) =>
      Effect.gen(function* updateRecoveryHealth() {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.updateAndGet(state, (previous) => ({
          ...previous,
          [kind]: success ? Option.some(now) : Option.none(),
        }));
        const fresh = (at: Option.Option<number>, staleAfter: number) =>
          Option.isSome(at) && now - at.value <= staleAfter;
        const ready = fresh(current.outbox, outboxStaleAfterMillis) && fresh(current.recovery, RECOVERY_STALE_AFTER_MS);
        if (health !== undefined) {
          yield* ready ? health.cycleSucceeded : health.cycleFailed;
        }
      }).pipe(mutex.withPermits(1));
    return {
      outbox: { cycleFailed: update('outbox', false), cycleSucceeded: update('outbox', true) },
      recovery: { cycleFailed: update('recovery', false), cycleSucceeded: update('recovery', true) },
    };
  },
);

/** Immediate durable discovery, then a bounded cadence. Business retry budgets remain in the journal. */
export const runCommerceEnrollmentRecovery = Effect.fn('CommerceEnrollmentRecovery.run')(
  function* runCommerceEnrollmentRecoveryEffect(
    health: CommerceEnrollmentRecoveryCycleHealth,
  ): Effect.fn.Return<void, never, CommerceEnrollmentContinuation> {
    const continuation = yield* CommerceEnrollmentContinuation;
    const sweeper = yield* commerceEnrollmentContinuationSweeperFor({ continuation });
    const retryDelay = yield* Ref.make(RETRY_INITIAL_MS);
    const tick = Effect.gen(function* recoveryTick() {
      const completed = yield* sweeper.sweep.pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: RECOVERY_CYCLE_TIMEOUT_MS,
          orElse: () => Effect.succeed(false),
        }),
      );
      const observation = yield* sweeper.observation;
      const successful = completed && observation.available;
      yield* successful ? health.cycleSucceeded : health.cycleFailed;
      yield* Effect.annotateLogs(
        successful
          ? Effect.logInfo('Commerce enrollment recovery cycle completed')
          : Effect.logWarning('Commerce enrollment recovery cycle unavailable'),
        {
          lastSuccessfulSweepAt: Option.getOrNull(observation.lastSuccessfulSweepAt),
          oldestObservedDueAt: Option.getOrNull(observation.oldestDueAt),
          retryExhaustedCount: Option.getOrNull(observation.retryExhaustedCount),
          unresolvedObserved: observation.unresolved,
        },
      );
      if (successful) {
        yield* Ref.set(retryDelay, RETRY_INITIAL_MS);
        yield* Effect.sleep(RECOVERY_INTERVAL_MS);
      } else {
        const delay = yield* Ref.getAndUpdate(retryDelay, (current) => Math.min(current * 2, RETRY_MAX_MS));
        yield* Effect.sleep(delay);
      }
    });
    return yield* Effect.forever(tick);
  },
);

/**
 * This is the published owner's runLoop, not a detached layer fiber. Core's existing host owns its
 * failure and signal lifetime. Both child loops must finish interruption and scoped disposal before
 * this entry returns, in dedicated and combined hosting alike.
 */
export const withCommerceEnrollmentRecovery = <OutboxError, RecoveryError>(
  entry: OutboxWorkerEntry<OutboxError>,
  runRecovery: (health: CommerceEnrollmentRecoveryCycleHealth) => Effect.Effect<void, RecoveryError>,
): OutboxWorkerEntry<OutboxError | RecoveryError> => ({
  claimOwnerPrefix: entry.claimOwnerPrefix,
  registrations: entry.registrations,
  runLoop: Effect.fn('CommerceEnrollmentRecovery.ownerLoops')(function* runCommerceOwnerLoops({
    config,
    health,
  }: Parameters<OutboxWorkerEntry<OutboxError>['runLoop']>[0]) {
    const checks = yield* makeCommerceEnrollmentRecoveryHealth(Math.max(5000, config.pollIntervalMs * 3), health);
    const recovery = runRecovery(checks.recovery);
    yield* Effect.all([entry.runLoop({ config, health: checks.outbox }), recovery], {
      concurrency: 2,
      discard: true,
    });
  }),
});
