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
 *
 * Every frame carries an SSE id (`<process epoch>.<change sequence>`). A stream cut by a proxy or a deploy is resumed by
 * the browser with `Last-Event-ID`: the hub replays the app ids of the changes it still remembers since that id, and
 * sends `reset` only when it cannot (another process, or too long ago). Reconnecting never reloads a page by itself.
 */

const COALESCE = Duration.millis(250);
const HEARTBEAT = Duration.seconds(25);
const MAX_AGE = Duration.minutes(10);
const TAIL_IDLE = Duration.minutes(1);
// Demo and team accounts are shared by many people at once; a tight limit would make their tabs evict each other
// and reconnect in a loop. The per-process limit still bounds the total.
const MAX_PER_PRINCIPAL = 32;
const MAX_CONNECTIONS = 500;
const RETRY_MIN_MILLIS = 3000;
const RETRY_SPREAD_MILLIS = 5000;
/** Changes remembered for resumed streams. */
const REPLAY_LIMIT = 512;

interface Subscriber {
  readonly evicted: Deferred.Deferred<boolean>;
  readonly openedAt: number;
  /** Bounded by the number of installed apps: a slow reader gets one merged frame, never a growing queue. */
  readonly pending: Set<string>;
  reset: boolean;
  readonly scope: LiveScope;
  readonly wake: Queue.Queue<boolean>;
}

/** The sequence of changes routed by this process; `floor` is the oldest id a resumed stream may carry. */
interface ChangeLog {
  readonly entries: { readonly change: LiveChange; readonly sequence: number }[];
  readonly epoch: string;
  floor: number;
  sequence: number;
}

const eventId = (log: ChangeLog, sequence: number) => `id: ${log.epoch}.${String(sequence)}\n`;

/** The next SSE frame of a connection: `change` names app ids, `reset` asks it to revalidate everything it shows. */
const frameOf = (log: ChangeLog, subscriber: Subscriber): Option.Option<string> => {
  if (!subscriber.reset && subscriber.pending.size === 0) {
    return Option.none();
  }
  // Everything routed up to now is in this frame.
  const id = eventId(log, log.sequence);
  if (subscriber.reset) {
    subscriber.reset = false;
    subscriber.pending.clear();
    return Option.some(`${id}event: reset\ndata: all\n\n`);
  }
  const apps = [...subscriber.pending].toSorted();
  subscriber.pending.clear();
  return Option.some(`${id}event: change\ndata: ${apps.join(',')}\n\n`);
};

/** The id line of a frame without changes: it moves forward only when nothing is waiting to be sent. */
const idleIdOf = (log: ChangeLog, subscriber: Subscriber) => {
  if (subscriber.reset || subscriber.pending.size > 0) {
    return '';
  }
  return eventId(log, log.sequence);
};

/** What a stream resumed after `lastEventId` missed: app ids, or a reset when the log cannot tell. */
const resumeFrom = (log: ChangeLog, scope: LiveScope, lastEventId: Option.Option<string>) => {
  if (Option.isNone(lastEventId)) {
    return { apps: [], reset: false };
  }
  const [epoch, sequenceText] = lastEventId.value.split('.');
  const sequence = Number(sequenceText);
  if (epoch !== log.epoch || !Number.isSafeInteger(sequence) || sequence < log.floor || sequence > log.sequence) {
    return { apps: [], reset: true };
  }
  const apps: string[] = [];
  for (const entry of log.entries) {
    if (entry.sequence > sequence) {
      apps.push(...appsForChange(scope, entry.change));
    }
  }
  return { apps, reset: false };
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

const nextFrame = (log: ChangeLog, subscriber: Subscriber) =>
  Queue.take(subscriber.wake).pipe(
    Effect.andThen(Effect.sleep(COALESCE)),
    Effect.map(() => frameOf(log, subscriber)),
  );

const framesOf = (log: ChangeLog, subscriber: Subscriber, retryMillis: number): Stream.Stream<string> => {
  const changes = Stream.fromEffectRepeat(nextFrame(log, subscriber)).pipe(
    Stream.filter(Option.isSome),
    Stream.map((frame) => frame.value),
  );
  const heartbeat = Stream.tick(HEARTBEAT).pipe(
    Stream.drop(1),
    Stream.map(() => `${idleIdOf(log, subscriber)}: ping\n\n`),
  );
  const connected = Stream.sync(() => `retry: ${String(retryMillis)}\n${idleIdOf(log, subscriber)}: connected\n\n`);
  return Stream.concat(connected, Stream.merge(changes, heartbeat)).pipe(
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
  /** Routes one committed change to the affected connections and remembers it for resumed streams. */
  readonly publish: (change: LiveChange) => Effect.Effect<void>;
  /** Asks every connection to revalidate everything (after possibly missed notifications). */
  readonly resetAll: Effect.Effect<void>;
  /**
   * The SSE body of one connection, or none at the process connection limit. It ends after the maximum age (the
   * browser reconnects and its scope is resolved again) or when a newer connection of the same principal evicts it.
   * `lastEventId` is the browser's `Last-Event-ID` of a resumed stream.
   */
  readonly subscribe: (
    scope: LiveScope,
    lastEventId: Option.Option<string>,
  ) => Effect.Effect<Option.Option<Stream.Stream<string>>>;
}

export class LiveChangeHub extends Context.Service<LiveChangeHub, LiveChangeHubService>()(
  '@app/shell-super-app/api/live-changes/hub/LiveChangeHub',
) {}

export const LiveChangeHubLive = Layer.effect(
  LiveChangeHub,
  Effect.gen(function* makeLiveChangeHub() {
    const tail = yield* LiveChangeTail;
    const subscribers = new Set<Subscriber>();
    const log: ChangeLog = {
      entries: [],
      epoch: (yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER)).toString(36),
      floor: 0,
      sequence: 0,
    };
    const publish = (change: LiveChange) =>
      Effect.sync(() => {
        log.sequence += 1;
        log.entries.push({ change, sequence: log.sequence });
        if (log.entries.length > REPLAY_LIMIT) {
          log.floor = log.entries.shift()?.sequence ?? log.floor;
        }
        routeChange(subscribers, change);
      });
    // Notifications may have been lost: nothing before this point can be replayed any more.
    const resetAll = Effect.sync(() => {
      log.sequence += 1;
      log.floor = log.sequence;
      log.entries.length = 0;
      resetSubscribers(subscribers);
    });
    const tailLease = yield* RcRef.make({
      acquire: Effect.forkScoped(tail.run({ publish, resetAll })),
      idleTimeToLive: TAIL_IDLE,
    });

    const register = (scope: LiveScope, lastEventId: Option.Option<string>) =>
      Effect.acquireRelease(
        Effect.gen(function* registerSubscriber() {
          yield* Effect.forEach(
            evictionsFor(subscribers, scope.principalId),
            (subscriber) => Deferred.succeed(subscriber.evicted, true),
            { concurrency: MAX_PER_PRINCIPAL, discard: true },
          );
          const evicted = yield* Deferred.make<boolean>();
          const openedAt = yield* Clock.currentTimeMillis;
          const wake = yield* Queue.dropping<boolean>(1);
          // One synchronous step: no change can be published between reading the log and joining the fan-out.
          return yield* Effect.sync(() => {
            const missed = resumeFrom(log, scope, lastEventId);
            const subscriber: Subscriber = {
              evicted,
              openedAt,
              pending: new Set(missed.apps),
              reset: missed.reset,
              scope,
              wake,
            };
            subscribers.add(subscriber);
            if (missed.reset || missed.apps.length > 0) {
              Queue.offerUnsafe(wake, true);
            }
            return subscriber;
          });
        }),
        (subscriber) => Effect.sync(() => subscribers.delete(subscriber)),
      );

    const open = Effect.fn('LiveChangeHub.open')(function* openConnection(
      scope: LiveScope,
      lastEventId: Option.Option<string>,
      retryMillis: number,
    ) {
      const subscriber = yield* register(scope, lastEventId);
      yield* RcRef.get(tailLease);
      return framesOf(log, subscriber, retryMillis);
    });

    const subscribe = Effect.fn('LiveChangeHub.subscribe')(function* subscribeConnection(
      scope: LiveScope,
      lastEventId: Option.Option<string>,
    ) {
      if (subscribers.size >= MAX_CONNECTIONS) {
        return Option.none<Stream.Stream<string>>();
      }
      const retryMillis = RETRY_MIN_MILLIS + (yield* Random.nextIntBetween(0, RETRY_SPREAD_MILLIS));
      return Option.some(Stream.unwrap(open(scope, lastEventId, retryMillis)));
    });

    return {
      connections: Effect.sync(() => subscribers.size),
      publish,
      resetAll,
      subscribe,
    } satisfies LiveChangeHubService;
  }),
);
