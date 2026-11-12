import { NodeCrypto } from '@effect/platform-node';
import { Clock, Console, Context, Duration, Effect, Layer } from 'effect';

import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import {
  ACCESS_FENCE_SWEEP_INTERVAL,
  makeAccessFenceSweepBackoffs,
  sweepLapsedAccessFences,
} from '../../packages/core-runtime/src/access/lifecycle/fence-sweeper.ts';
import type { AccessFenceSweepReport } from '../../packages/core-runtime/src/access/lifecycle/fence-sweeper.ts';
import { CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfigLive } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { defineDatabaseIdentityEnrollment } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import { observeRuntimeJob } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import {
  AccessProjectionWriterLive,
  AccessWriteJournalStoreLive,
  CoreAuthorizationProjectionCompilerLive,
  SpiceDbConfigLive,
  TenantIntentLoaderLive,
} from '../../packages/core-runtime/src/outbox/core-authorization-projection.ts';

/*
 * The access fence sweep of the Outbox host. A tenant whose fence holder died, or whose projection failed after it
 * wrote to the engine, stays closed until a reconcile takes the lapsed fence over; once a minute this asks which
 * tenants are in that state and reconciles a few of them as each tenant's platform release actor. With nothing
 * lapsed a tick is one small statement. Every recovery and every failure is printed, the failure with its next try.
 */
// The runtime identity, as the Outbox host's other Core maintenance uses it.
const identity = Layer.merge(
  DatabaseConfigLive,
  Layer.succeed(DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment([])),
);
const database = CoreDatabaseLive.pipe(Layer.provideMerge(identity));
const stores = Layer.mergeAll(
  TenantIntentLoaderLive,
  AccessWriteJournalStoreLive,
  AccessReleaseStoreLive,
  CoreAuthorizationProjectionCompilerLive.pipe(Layer.provide(SpiceDbConfigLive)),
).pipe(Layer.provideMerge(database));
export const AccessFenceSweepLive = Layer.mergeAll(
  stores,
  AccessProjectionWriterLive.pipe(Layer.provide(Layer.merge(stores, NodeCrypto.layer))),
);

// The host Scope interrupts this wait and clears its timer; idle maintenance must not keep the process alive.
export const AccessFenceSweepDelay = Context.Reference<(duration: Duration.Duration) => Effect.Effect<void>>(
  'ontos/AccessFenceSweepDelay',
  {
    defaultValue: () => (duration) =>
      Effect.callback((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        timer.unref();
        return Effect.sync(() => clearTimeout(timer));
      }),
  },
);

const minutes = (millis: number) => `${String(Math.ceil(millis / 60_000))} min`;

/** The lines one tick prints: one per tenant reopened, one per tenant still closed. Nothing when idle. */
export const accessFenceSweepLines = (report: AccessFenceSweepReport) => ({
  failed: report.failed.map(
    ({ reason, retryInMillis, tenantId }) =>
      `[access-fence-sweep] TENANT ${tenantId} STAYS CLOSED: ${reason}; next try in ${minutes(retryInMillis)}`,
  ),
  healed: report.healed.map(
    (tenantId) =>
      `[access-fence-sweep] tenant ${tenantId}: took over a lapsed access fence and reconciled it; the tenant is open again`,
  ),
});

const printSweep = (report: AccessFenceSweepReport) => {
  const { failed, healed } = accessFenceSweepLines(report);
  return Effect.all(
    [
      healed.length === 0 ? Effect.void : Console.log(healed.join('\n')),
      failed.length === 0 ? Effect.void : Console.error(failed.join('\n')),
    ],
    { discard: true },
  );
};

const reportFailure = (message: string) =>
  Effect.matchEffect({ onFailure: () => Console.error(message), onSuccess: () => Effect.void });

export const startAccessFenceSweep = () =>
  Effect.gen(function* runAccessFenceSweeps() {
    const context = yield* Layer.build(AccessFenceSweepLive);
    const backoffs = yield* makeAccessFenceSweepBackoffs;
    const delay = yield* AccessFenceSweepDelay;
    let tick = 0;
    for (;;) {
      tick += 1;
      const started = yield* Clock.monotonicTimeNanos;
      yield* sweepLapsedAccessFences(backoffs, `tick-${String(tick)}`).pipe(
        Effect.flatMap(printSweep),
        Effect.provideContext(context),
        observeRuntimeJob('access-fence-sweep'),
        reportFailure('[access-fence-sweep] the lapsed access fences could not be read; retrying on the next tick'),
      );
      const elapsed = Duration.nanos((yield* Clock.monotonicTimeNanos) - started);
      yield* delay(Duration.max(Duration.subtract(ACCESS_FENCE_SWEEP_INTERVAL, elapsed), Duration.zero));
    }
  }).pipe(
    reportFailure('[access-fence-sweep] the sweep could not start; the host continues without it'),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  );
