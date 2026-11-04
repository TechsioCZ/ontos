import { CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfigLive } from '../../packages/core-runtime/src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../packages/core-runtime/src/db/database-identities.ts';
import { defineDatabaseIdentityEnrollment } from '../../packages/core-runtime/src/db/database-identity-manifest.ts';
import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { observeRuntimeJob } from '../../packages/core-runtime/src/observability/runtime-jobs.ts';
import {
  CoreSearchDerivedStampSweep,
  CoreSearchDerivedStampSweepLive,
} from '../../packages/core-runtime/src/search/persistence.ts';
import type { CoreSearchDerivedStampModules } from '../../packages/core-runtime/src/search/persistence.ts';
import {
  outboxWorkerDatabaseConfigLive as partyWorkerDatabaseConfigLive,
  outboxWorkerDatabaseIdentityEnrollmentLive as partyWorkerDatabaseIdentityEnrollmentLive,
} from '../../verticals/party-registry/src/worker-host/layer.ts';
import { Clock, Console, Context, Duration, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';

const sweepWith = <Failure,>(
  modules: CoreSearchDerivedStampModules,
  identity: Layer.Layer<Layer.Success<typeof DatabaseConfigLive> | DatabaseIdentityEnrollmentContext, Failure>,
) => ({
  layer: CoreSearchDerivedStampSweepLive.pipe(Layer.provide(CoreDatabaseLive), Layer.provide(identity)),
  modules,
});

/** Each identity repairs only the owners Core Search RLS lets it write: Party through its worker, the rest as runtime. */
const sweepIdentities = [
  sweepWith(
    { except: ['party.registry'] },
    Layer.merge(
      DatabaseConfigLive,
      Layer.succeed(DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment([])),
    ),
  ),
  sweepWith(
    { only: ['party.registry'] },
    Layer.merge(partyWorkerDatabaseConfigLive, partyWorkerDatabaseIdentityEnrollmentLive),
  ),
] as const;

const compositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(ActiveApplicationCompositionSourceLive),
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
    ),
  ),
);

// The host Scope interrupts this wait and clears its timer; idle maintenance must not keep the process alive.
export const SearchDerivedStampSweepDelay = Context.Reference<(duration: Duration.Duration) => Effect.Effect<void>>(
  'ontos/SearchDerivedStampSweepDelay',
  {
    defaultValue: () => (duration) =>
      Effect.callback((resume) => {
        const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
        timer.unref();
        return Effect.sync(() => clearTimeout(timer));
      }),
  },
);

const SWEEP_INTERVAL = Duration.minutes(10);

const reportFailure = (message: string) =>
  Effect.matchEffect({ onFailure: () => Console.error(message), onSuccess: () => Effect.void });

/**
 * Keeps every Core Search row's derived stamp current, so no deploy, format change or legacy write leaves an
 * owner's search verifying its whole bucket in memory. It sweeps once at startup, then every ten minutes; a
 * failed sweep is reported and retried on the next tick, and maintenance never stops the host.
 */
export const startSearchDerivedStampSweep = () =>
  Effect.gen(function* runDerivedStampSweeps() {
    const composition = Context.get(yield* Layer.build(compositionLive), ActiveApplicationCompositionService);
    const sweeps = yield* Effect.forEach(
      sweepIdentities,
      ({ layer, modules }) =>
        Layer.build(layer).pipe(
          Effect.map((context) => ({ modules, sweeper: Context.get(context, CoreSearchDerivedStampSweep) })),
        ),
      { concurrency: 1 },
    );
    const sweepOnce = Effect.gen(function* sweepDerivedStampsOnce() {
      const { composition: active } = yield* composition.load;
      const results = yield* Effect.forEach(
        sweeps,
        ({ modules, sweeper }) => sweeper.sweep({ compositionRevision: active.revision, modules }),
        { concurrency: 1 },
      );
      const repaired = results.reduce((total, result) => total + result.repaired, 0);
      if (repaired > 0) {
        const units = results.reduce((total, result) => total + result.units, 0);
        yield* Console.log(`[search-stamps] repaired ${String(repaired)} rows in ${String(units)} units`);
      }
    }).pipe(
      observeRuntimeJob('search-derived-stamp-sweep'),
      reportFailure('[search-stamps] sweep unavailable; retrying on the next tick'),
    );
    const delay = yield* SearchDerivedStampSweepDelay;
    for (;;) {
      const started = yield* Clock.monotonicTimeNanos;
      yield* sweepOnce;
      const elapsed = Duration.nanos((yield* Clock.monotonicTimeNanos) - started);
      yield* delay(Duration.max(Duration.subtract(SWEEP_INTERVAL, elapsed), Duration.zero));
    }
  }).pipe(
    reportFailure('[search-stamps] sweep could not start; the host continues without it'),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  );
