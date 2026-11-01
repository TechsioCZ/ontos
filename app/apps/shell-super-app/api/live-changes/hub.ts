import type { LiveChange } from '@app/core-runtime/live/change-notification';
import { Clock, Context, Deferred, Duration, Effect, Layer, Option, Queue, Random, RcRef, Stream } from 'effect';

import { LiveChangeTail } from './listener.ts';
import { appsForChange } from './live-scope.ts';
import type { LiveScope } from './live-scope.ts';

/**
 * One server-push channel per browser document (Server-Sent Events), fed by committed changes.
 *
 * Core publishes an invalidation key with `pg_notify` inside every committing Action and Outbox delivery transaction.
 * The hub runs ONE change tail for the whole Shell process — acquired with the first connection, released a minute
 * after the last one closes — and fans each change out to the connections whose tenant, legal entity and allowed
 * module APIs it concerns. A connection only ever receives app ids to revalidate, never data.
 */

const COALESCE = Duration.millis(250);
const HEARTBEAT = Duration.seconds(25);
const MAX_AGE = Duration.minutes(10);
const TAIL_IDLE = Duration.minutes(1);
const MAX_PER_PRINCIPAL = 4;
const MAX_CONNECTIONS = 500;
const RETRY_MIN_MILLIS = 3000;
const RETRY_SPREAD_MILLIS = 5000;
const HEARTBEAT_FRAME = ': ping\n\n';
const RESET_FRAME = 'event: reset\ndata: all\n\n';

interface Subscriber {
  readonly evicted: Deferred.Deferred<boolean>;
  readonly openedAt: number;
  /** Bounded by the number of installed apps: a slow reader gets one merged frame, never a growing queue. */
  readonly pending: Set<string>;
  reset: boolean;
  readonly scope: LiveScope;
  readonly wake: Queue.Queue<boolean>;
}

/** The next SSE frame of a connection: `change` names app ids, `reset` asks it to revalidate everything it shows. */
const frameOf = (subscriber: Subscriber): Option.Option<string> => {
  if (subscriber.reset) {
    subscriber.reset = false;
    subscriber.pending.clear();
    return Option.some(RESET_FRAME);
  }
  if (subscriber.pending.size === 0) {
    return Option.none();
  }
  const apps = [...subscriber.pending].toSorted();
  subscriber.pending.clear();
  return Option.some(`event: change\ndata: ${apps.join(',')}\n\n`);
};

const routeChange = (subscribers: ReadonlySet<Subscriber>, change: LiveChange) => {
  for (const subscriber of subscribers) {
    const apps = appsForChange(subscriber.scope, change);
    if (apps.length > 0) {
      for (const app of apps) {
        subscriber.pending.add(app);
      }
      Queue.offerUnsafe(subscriber.wake, true);
    }
  }
};

const resetSubscribers = (subscribers: ReadonlySet<Subscriber>) => {
  for (const subscriber of subscribers) {
    subscriber.reset = true;
    Queue.offerUnsafe(subscriber.wake, true);
  }
};

const nextFrame = (subscriber: Subscriber) =>
  Queue.take(subscriber.wake).pipe(
    Effect.andThen(Effect.sleep(COALESCE)),
    Effect.map(() => frameOf(subscriber)),
  );

const framesOf = (subscriber: Subscriber, retryMillis: number): Stream.Stream<string> => {
  const changes = Stream.fromEffectRepeat(nextFrame(subscriber)).pipe(
    Stream.filter(Option.isSome),
    Stream.map((frame) => frame.value),
  );
  const heartbeat = Stream.tick(HEARTBEAT).pipe(
    Stream.drop(1),
    Stream.map(() => HEARTBEAT_FRAME),
  );
  return Stream.concat(Stream.succeed(`retry: ${retryMillis}\n: connected\n\n`), Stream.merge(changes, heartbeat)).pipe(
    Stream.interruptWhen(Deferred.await(subscriber.evicted)),
    Stream.interruptWhen(Effect.sleep(MAX_AGE)),
  );
};

/** The oldest connections of the principal that must close so the new one stays within the per-principal limit. */
const evictionsFor = (subscribers: ReadonlySet<Subscriber>, principalId: string) => {
  const same = [...subscribers]
    .filter((subscriber) => subscriber.scope.principalId === principalId)
    .toSorted((left, right) => left.openedAt - right.openedAt);
  return same.slice(0, Math.max(0, same.length - MAX_PER_PRINCIPAL + 1));
};

export interface LiveChangeHubService {
  readonly connections: Effect.Effect<number>;
  /** Routes one committed change to the affected connections. */
  readonly publish: (change: LiveChange) => Effect.Effect<void>;
  /** Asks every connection to revalidate everything (after possibly missed notifications). */
  readonly resetAll: Effect.Effect<void>;
  /**
   * The SSE body of one connection, or none at the process connection limit. It ends after the maximum age (the
   * browser reconnects and its scope is resolved again) or when a newer connection of the same principal evicts it.
   */
  readonly subscribe: (scope: LiveScope) => Effect.Effect<Option.Option<Stream.Stream<string>>>;
}

export class LiveChangeHub extends Context.Service<LiveChangeHub, LiveChangeHubService>()(
  '@app/shell-super-app/api/live-changes/hub/LiveChangeHub',
) {}

export const LiveChangeHubLive = Layer.effect(
  LiveChangeHub,
  Effect.gen(function* makeLiveChangeHub() {
    const tail = yield* LiveChangeTail;
    const subscribers = new Set<Subscriber>();
    const publish = (change: LiveChange) => Effect.sync(() => routeChange(subscribers, change));
    const resetAll = Effect.sync(() => resetSubscribers(subscribers));
    const tailLease = yield* RcRef.make({
      acquire: Effect.forkScoped(tail.run({ publish, resetAll })),
      idleTimeToLive: TAIL_IDLE,
    });

    const register = (scope: LiveScope) =>
      Effect.acquireRelease(
        Effect.gen(function* registerSubscriber() {
          yield* Effect.forEach(
            evictionsFor(subscribers, scope.principalId),
            (subscriber) => Deferred.succeed(subscriber.evicted, true),
            { concurrency: MAX_PER_PRINCIPAL, discard: true },
          );
          const subscriber: Subscriber = {
            evicted: yield* Deferred.make<boolean>(),
            openedAt: yield* Clock.currentTimeMillis,
            pending: new Set(),
            reset: false,
            scope,
            wake: yield* Queue.dropping<boolean>(1),
          };
          subscribers.add(subscriber);
          return subscriber;
        }),
        (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
      );

    const open = Effect.fn('LiveChangeHub.open')(function* openConnection(scope: LiveScope, retryMillis: number) {
      const subscriber = yield* register(scope);
      yield* RcRef.get(tailLease);
      return framesOf(subscriber, retryMillis);
    });

    const subscribe = Effect.fn('LiveChangeHub.subscribe')(function* subscribeConnection(scope: LiveScope) {
      if (subscribers.size >= MAX_CONNECTIONS) {
        return Option.none<Stream.Stream<string>>();
      }
      const retryMillis = RETRY_MIN_MILLIS + (yield* Random.nextIntBetween(0, RETRY_SPREAD_MILLIS));
      return Option.some(Stream.unwrap(open(scope, retryMillis)));
    });

    return {
      connections: Effect.sync(() => subscribers.size),
      publish,
      resetAll,
      subscribe,
    } satisfies LiveChangeHubService;
  }),
);
