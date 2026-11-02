import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { Clock, Context, Effect, Fiber, Match, Queue } from 'effect';
import { useEffect } from 'react';

import { browserRuntime } from '../runtime/browser-effect-runtime.ts';
import { dropBrowserModuleReads } from './browser-request-cache.ts';
import { staffRoutePreloads } from './route-preload-scheduler.ts';

/**
 * The browser end of the Shell's live channel: one `EventSource` per document.
 *
 * The server sends `change` (comma-separated app ids) when a change committed elsewhere concerns this session, and
 * `reset` when it may have missed some. Each batch drops the cached reads of those apps and dispatches
 * `moduleChangeEvent`, so page-data stores revalidate only what is on screen; everything else is merely stale and
 * reloads on navigation. Batches are coalesced (300 ms) and at most one revalidation per second runs. A hidden tab
 * closes its stream after a minute and revalidates once when it is shown again, as does a stream the server refused.
 * A stream cut by a proxy or a deploy is resumed by the browser itself with `Last-Event-ID`; the server then replays
 * what it missed or sends `reset`, so a reconnect alone reloads nothing. While the stream is open, focusing the tab
 * needs no reload: the server has reported every change. Nothing polls.
 */

export const LIVE_CHANGES_URL = '/shell-super-app-api/live-changes';

const COALESCE_MILLIS = 300;
const MIN_INTERVAL_MILLIS = 1000;
const HIDDEN_CLOSE_MILLIS = 60_000;
/** After the server refused a stream (non-200), reconnect attempts back off up to five minutes. */
const REFUSED_BACKOFF_MILLIS = [5000, 15_000, 60_000, 300_000] as const;
const LONGEST_BACKOFF_MILLIS = 300_000;
const CLOSED = 2;

export type LiveRevalidation = ReadonlySet<string> | 'all';

/** The part of `EventSource` the channel uses. */
export interface LiveSource {
  readonly addEventListener: (type: string, listener: (event: Event) => void) => void;
  readonly close: () => void;
  readonly readyState: number;
}

export interface LiveChannelService {
  readonly open: () => LiveSource;
  readonly revalidate: (apps: LiveRevalidation) => Effect.Effect<void>;
}

const browserLiveChannel: LiveChannelService = {
  open: () => new EventSource(LIVE_CHANGES_URL, { withCredentials: true }),
  revalidate: (apps) =>
    dropBrowserModuleReads(apps).pipe(
      Effect.andThen(
        Effect.sync(() =>
          globalThis.dispatchEvent(
            new CustomEvent(moduleChangeEvent, { detail: { apps: apps === 'all' ? 'all' : [...apps] } }),
          ),
        ),
      ),
    ),
};

/** The channel's collaborators: the document's `EventSource` and page-data revalidation by default; tests replace it. */
export const LiveChannel = Context.Reference<LiveChannelService>(
  '@app/shell-super-app/routes/live-changes/LiveChannel',
  { defaultValue: () => browserLiveChannel },
);

export type LiveSignal =
  | { readonly apps: LiveRevalidation; readonly kind: 'change' }
  | { readonly kind: 'closed'; readonly source: LiveSource }
  | { readonly kind: 'flush' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'hidden-timeout' }
  | { readonly kind: 'online' }
  | { readonly kind: 'open'; readonly source: LiveSource }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'visible' };

const appsOf = (event: Event): LiveRevalidation =>
  new Set(
    String('data' in event ? event.data : '')
      .split(',')
      .filter((app) => /^[a-z][a-z0-9-]*$/u.test(app)),
  );

const mergeApps = (current: LiveRevalidation | null, next: LiveRevalidation): LiveRevalidation =>
  current === 'all' || next === 'all' ? 'all' : new Set([...(current ?? []), ...next]);

const signal = (signals: Queue.Queue<LiveSignal>, value: LiveSignal) => {
  Queue.offerUnsafe(signals, value);
};

const listen = (source: LiveSource, signals: Queue.Queue<LiveSignal>) => {
  source.addEventListener('open', () => {
    signal(signals, { kind: 'open', source });
  });
  source.addEventListener('change', (event) => {
    signal(signals, { apps: appsOf(event), kind: 'change' });
  });
  source.addEventListener('reset', () => {
    signal(signals, { kind: 'reset' });
  });
  source.addEventListener('error', () => {
    // CONNECTING: the browser resumes by itself after the server's `retry`, and the server covers the gap.
    if (source.readyState === CLOSED) {
      signal(signals, { kind: 'closed', source });
    }
  });
};

interface ChannelState {
  flush: Fiber.Fiber<void> | null;
  hidden: Fiber.Fiber<void> | null;
  lastRevalidationAt: number;
  /** The stream was down at some point, so changes may have been missed: revalidate once it is open again. */
  missed: boolean;
  pending: LiveRevalidation | null;
  reconnect: Fiber.Fiber<void> | null;
  refusals: number;
  source: LiveSource | null;
}

const remember = (assign: (fiber: Fiber.Fiber<void>) => void) => (fiber: Fiber.Fiber<void>) =>
  Effect.sync(() => {
    assign(fiber);
  });

const interrupt = (fiber: Fiber.Fiber<void> | null) => (fiber === null ? Effect.void : Fiber.interrupt(fiber));

/**
 * The channel's single event loop. Every input — stream events, visibility, network, its own timers — arrives as a
 * signal, so state changes happen one at a time. Runs until interrupted; closes the stream on exit.
 */
export const runLiveChanges = Effect.fn('LiveChanges.run')(function* runLiveChanges(signals: Queue.Queue<LiveSignal>) {
  const channel = yield* LiveChannel;
  const state: ChannelState = {
    flush: null,
    hidden: null,
    lastRevalidationAt: Number.NEGATIVE_INFINITY,
    missed: false,
    pending: null,
    reconnect: null,
    refusals: 0,
    source: null,
  };
  const later = (delayMillis: number, next: LiveSignal) =>
    Effect.forkChild(Effect.sleep(delayMillis).pipe(Effect.andThen(Queue.offer(signals, next)), Effect.asVoid));
  const connect = Effect.gen(function* connectStream() {
    if (state.source !== null) {
      return;
    }
    yield* interrupt(state.reconnect);
    state.reconnect = null;
    const source = channel.open();
    state.source = source;
    listen(source, signals);
  });
  const close = Effect.sync(() => {
    state.source?.close();
    state.source = null;
  });
  const queue = Effect.fn('LiveChanges.queue')(function* queueRevalidation(apps: LiveRevalidation) {
    state.pending = mergeApps(state.pending, apps);
    if (state.flush === null) {
      const now = yield* Clock.currentTimeMillis;
      state.flush = yield* later(Math.max(COALESCE_MILLIS, state.lastRevalidationAt + MIN_INTERVAL_MILLIS - now), {
        kind: 'flush',
      });
    }
  });
  const flush = Effect.gen(function* flushRevalidation() {
    const apps = state.pending;
    state.pending = null;
    state.flush = null;
    state.lastRevalidationAt = yield* Clock.currentTimeMillis;
    if (apps !== null && (apps === 'all' || apps.size > 0)) {
      yield* channel.revalidate(apps);
    }
  });
  const onOpen = (source: LiveSource) => {
    if (source !== state.source) {
      return Effect.void;
    }
    state.refusals = 0;
    if (!state.missed) {
      return Effect.void;
    }
    state.missed = false;
    return queue('all');
  };
  const onRefused = (source: LiveSource) => {
    if (source !== state.source) {
      return Effect.void;
    }
    state.missed = true;
    const delay = REFUSED_BACKOFF_MILLIS.at(state.refusals) ?? LONGEST_BACKOFF_MILLIS;
    state.refusals += 1;
    return close.pipe(
      Effect.andThen(later(delay, { kind: 'reconnect' })),
      Effect.flatMap(
        remember((fiber) => {
          state.reconnect = fiber;
        }),
      ),
    );
  };
  const onHidden = Effect.suspend(() =>
    interrupt(state.hidden).pipe(
      Effect.andThen(later(HIDDEN_CLOSE_MILLIS, { kind: 'hidden-timeout' })),
      Effect.flatMap(
        remember((fiber) => {
          state.hidden = fiber;
        }),
      ),
    ),
  );
  const onHiddenTimeout = Effect.suspend(() => {
    state.hidden = null;
    state.missed = true;
    return interrupt(state.reconnect).pipe(Effect.andThen(close));
  });
  const onVisible = Effect.suspend(() => {
    const { hidden } = state;
    state.hidden = null;
    if (state.source === null) {
      state.missed = true;
    }
    return interrupt(hidden).pipe(Effect.andThen(connect));
  });
  const onOnline = Effect.suspend(() => {
    state.refusals = 0;
    return connect;
  });
  const onReconnect = Effect.suspend(() => {
    state.reconnect = null;
    return connect;
  });
  const handle = (input: LiveSignal): Effect.Effect<void> =>
    Match.value(input).pipe(
      Match.discriminatorsExhaustive('kind')({
        change: ({ apps }) => queue(apps),
        closed: ({ source }) => onRefused(source),
        flush: () => flush,
        hidden: () => onHidden,
        'hidden-timeout': () => onHiddenTimeout,
        online: () => onOnline,
        open: ({ source }) => onOpen(source),
        reconnect: () => onReconnect,
        reset: () => queue('all'),
        visible: () => onVisible,
      }),
    );
  yield* connect;
  return yield* Queue.take(signals).pipe(Effect.flatMap(handle), Effect.forever, Effect.ensuring(close));
});

/** Forwards the document's visibility and network events into the channel for as long as the scope is open. */
const forwardDocumentSignals = (signals: Queue.Queue<LiveSignal>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onVisibility = () => {
        signal(signals, { kind: globalThis.document.visibilityState === 'visible' ? 'visible' : 'hidden' });
      };
      const onOnline = () => {
        signal(signals, { kind: 'online' });
      };
      globalThis.document.addEventListener('visibilitychange', onVisibility);
      globalThis.addEventListener('online', onOnline);
      return { onOnline, onVisibility };
    }),
    ({ onOnline, onVisibility }) =>
      Effect.sync(() => {
        globalThis.document.removeEventListener('visibilitychange', onVisibility);
        globalThis.removeEventListener('online', onOnline);
      }),
  );

const documentLiveChanges = Effect.gen(function* documentLiveChanges() {
  // Never compete with the login burst: wait for the page's reads and the menu prefetch (bounded).
  yield* Effect.sleep('3 seconds');
  yield* staffRoutePreloads.awaitIdle.pipe(Effect.timeout('20 seconds'), Effect.ignore);
  const signals = yield* Queue.unbounded<LiveSignal>();
  yield* forwardDocumentSignals(signals);
  return yield* runLiveChanges(signals);
}).pipe(Effect.scoped);

const noop = () => {
  // Nothing was started.
};

/** Opens the document's live channel while a company context is shown; a context switch reloads the document. */
export const useLiveChanges = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled || !('EventSource' in globalThis)) {
      return noop;
    }
    const fiber = browserRuntime.runFork(documentLiveChanges);
    return () => {
      browserRuntime.runFork(Fiber.interrupt(fiber));
    };
  }, [enabled]);
};
