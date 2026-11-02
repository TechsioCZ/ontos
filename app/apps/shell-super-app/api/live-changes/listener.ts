import { DatabaseConfig } from '@app/core-runtime';
import { LIVE_CHANGE_CHANNEL, decodeLiveChange } from '@app/core-runtime/live/change-notification';
import type { LiveChange } from '@app/core-runtime/live/change-notification';
import { PgClient } from '@effect/sql-pg';
import { Context, Duration, Effect, Layer, Option, Redacted, Schedule, Stream } from 'effect';
import type { Reactivity } from 'effect/reactivity';

/** What the change tail drives. */
export interface LiveChangeSink {
  readonly publish: (change: LiveChange) => Effect.Effect<void>;
  /** Every connection revalidates everything: notifications may have been missed. */
  readonly resetAll: Effect.Effect<void>;
}

export interface LiveChangeTailService {
  /** Runs until interrupted, reconnecting by itself; never fails. */
  readonly run: (sink: LiveChangeSink) => Effect.Effect<void>;
}

/** The process's single source of committed changes. */
export class LiveChangeTail extends Context.Service<LiveChangeTail, LiveChangeTailService>()(
  '@app/shell-super-app/api/live-changes/listener/LiveChangeTail',
) {}

/** Exponential reconnect, capped at 30 seconds and jittered so Shell restarts do not synchronise. */
const reconnect = Schedule.min([Schedule.exponential(Duration.seconds(1)), Schedule.spaced(Duration.seconds(30))]).pipe(
  Schedule.jittered,
);

const listenOnce = Effect.fn('LiveChangeTail.listenOnce')(function* listenOnce(
  url: Redacted.Redacted,
  sink: LiveChangeSink,
) {
  const client = yield* PgClient.makeClient({ url });
  const notifications = yield* client.listen(LIVE_CHANGE_CHANNEL);
  yield* Stream.fromQueue(notifications).pipe(
    Stream.runForEach(({ payload }) =>
      Option.match(decodeLiveChange(payload), { onNone: () => Effect.void, onSome: sink.publish }),
    ),
  );
});

/**
 * One dedicated `LISTEN` connection on the shared runtime database. PostgreSQL pushes each committed notification, so
 * nothing polls. After a lost connection every browser is asked to revalidate once, because notifications sent while
 * the tail was down are gone.
 */
export const LiveChangeTailLive = Layer.effect(
  LiveChangeTail,
  Effect.gen(function* makeLiveChangeTail() {
    const config = yield* DatabaseConfig;
    const reactivity = yield* Effect.context<Reactivity.Reactivity>();
    const url = Redacted.make(config.connectionString);
    return {
      run: (sink: LiveChangeSink) => {
        let attempts = 0;
        return Effect.suspend(() => {
          attempts += 1;
          return (attempts > 1 ? sink.resetAll : Effect.void).pipe(
            Effect.andThen(Effect.scoped(listenOnce(url, sink))),
          );
        }).pipe(
          Effect.provideContext(reactivity),
          Effect.tapCause((cause) => Effect.logWarning('Live change tail stopped; reconnecting', cause)),
          Effect.retry(reconnect),
          Effect.ignore,
          // A tail that ended without an error is resumed too: the hub must never be left without one.
          Effect.forever,
        );
      },
    } satisfies LiveChangeTailService;
  }),
);
