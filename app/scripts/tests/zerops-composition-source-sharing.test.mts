// @effect-diagnostics strictEffectProvide:off -- Each reader builds its own source layer, as each owner bundle does; expires: 2026-12-31.
import { ConfigProvider, Effect, Layer } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { ActiveApplicationCompositionSource } from '../../packages/core-runtime/src/modules/active-application-composition-source-service.ts';
import { startProcessCompositionSourceReads } from '../zerops/process-composition-source-reads.mts';

const URL_UNDER_TEST = 'https://authority.example/shared';
const START = Date.parse('2026-11-12T10:00:00.000Z');
const A_DAY_LATER = '2026-11-13T10:00:00.000Z';
const PAST_FRESHNESS = '31 seconds';
const body = (validUntil: string, marker = 'a') => `{"marker":"${marker}","validUntil":"${validUntil}"}`;

interface Served {
  readonly body: string;
  readonly etag: string;
}

/** A source answering like the host's control port: a strong ETag, and 304 when the reader already holds it. */
const makeSource = (current: () => Served) => {
  const requests: { readonly authorization: string | null; readonly ifNoneMatch: string | null }[] = [];
  const fetch = (_input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ authorization: headers.get('authorization'), ifNoneMatch: headers.get('if-none-match') });
    const served = current();
    return Promise.resolve(
      headers.get('if-none-match') === served.etag
        ? new Response(null, { headers: { etag: served.etag }, status: 304 })
        : new Response(served.body, { headers: { etag: served.etag } }),
    );
  };
  return { fetch, requests };
};

/** One owner bundle or Outbox loop: its own layer build, as each builds the source in its own runtime. */
const readFrom = (fetch: typeof globalThis.fetch, environment: Readonly<Record<string, string>>) =>
  ActiveApplicationCompositionSource.pipe(
    Effect.flatMap((source) => source.load),
    Effect.provide(
      ActiveApplicationCompositionSourceLive.pipe(
        // The source pins its transport from its own context, as main's node source does.
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
      ),
    ),
  );

const environment = { ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: URL_UNDER_TEST };

/** Runs `test` under a process host that shares composition reads, as `serve-units` and the Outbox host do. */
const underProcessHost = <Value, Failure>(test: Effect.Effect<Value, Failure>) =>
  Effect.scoped(Effect.andThen(startProcessCompositionSourceReads, test));

const wrongConfirmation = (_input: URL | RequestInfo, _init?: RequestInit) =>
  Promise.resolve(new Response(null, { headers: { etag: '"other"' }, status: 304 }));

it.effect('independent readers in one process share one read of the snapshot while it is fresh', () =>
  underProcessHost(
    Effect.gen(function* sharedRead() {
      yield* TestClock.setTime(START);
      const served = { body: body(A_DAY_LATER), etag: '"v1"' };
      const source = makeSource(() => served);
      const reads = yield* Effect.forEach(Array.from({ length: 26 }), () => readFrom(source.fetch, environment));
      expect(new Set(reads)).toEqual(new Set([served.body]));
      expect(source.requests).toHaveLength(1);
    }),
  ),
);

it.effect('after 30 s an unchanged snapshot is confirmed by a 304 and neither sent nor parsed again', () =>
  underProcessHost(
    Effect.gen(function* revalidated() {
      yield* TestClock.setTime(START);
      let served = { body: body(A_DAY_LATER), etag: '"v1"' };
      const source = makeSource(() => served);
      expect(yield* readFrom(source.fetch, environment)).toBe(served.body);
      yield* TestClock.adjust(PAST_FRESHNESS);
      expect(yield* readFrom(source.fetch, environment)).toBe(served.body);
      expect(source.requests.map(({ ifNoneMatch }) => ifNoneMatch)).toEqual([null, '"v1"']);
      // Confirmed again for another 30 s: nobody asks.
      expect(yield* readFrom(source.fetch, environment)).toBe(served.body);
      expect(source.requests).toHaveLength(2);
      // A publication replaces the bytes: the next revalidation receives and returns them.
      served = { body: body('2026-11-13T16:00:00.000Z', 'b'), etag: '"v2"' };
      yield* TestClock.adjust(PAST_FRESHNESS);
      expect(yield* readFrom(source.fetch, environment)).toBe(served.body);
      expect(source.requests.at(-1)?.ifNoneMatch).toBe('"v1"');
    }),
  ),
);

it.effect('a 304 that does not confirm the held bytes fails and is not cached', () =>
  underProcessHost(
    Effect.gen(function* unconfirmed() {
      yield* TestClock.setTime(START);
      const original = { body: body(A_DAY_LATER), etag: '"v1"' };
      const first = makeSource(() => original);
      yield* readFrom(first.fetch, environment);
      yield* TestClock.adjust(PAST_FRESHNESS);
      const failure = yield* Effect.flip(readFrom(wrongConfirmation, environment));
      expect(failure.reason).toContain('HTTP 304');
      // The stale read was not extended: the next reader still revalidates.
      const second = makeSource(() => original);
      yield* readFrom(second.fetch, environment);
      expect(second.requests).toHaveLength(1);
    }),
  ),
);

it.effect('the freshness never outlives the authority deadline', () =>
  underProcessHost(
    Effect.gen(function* deadline() {
      yield* TestClock.setTime(START);
      const served = { body: body('2026-11-12T10:00:05.000Z'), etag: '"v1"' };
      const source = makeSource(() => served);
      yield* readFrom(source.fetch, environment);
      yield* TestClock.adjust('6 seconds');
      yield* readFrom(source.fetch, environment);
      expect(source.requests).toHaveLength(2);
    }),
  ),
);

it.effect('readers with another credential do not share a read', () =>
  underProcessHost(
    Effect.gen(function* credentials() {
      yield* TestClock.setTime(START);
      const served = { body: body(A_DAY_LATER), etag: '"v1"' };
      const source = makeSource(() => served);
      yield* readFrom(source.fetch, { ...environment, ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: 'one' });
      yield* readFrom(source.fetch, { ...environment, ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: 'two' });
      yield* readFrom(source.fetch, { ...environment, ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: 'one' });
      expect(source.requests.map(({ authorization }) => authorization)).toEqual(['Bearer one', 'Bearer two']);
    }),
  ),
);

it.effect('without a process host each reader keeps its own read and still revalidates with its ETag', () =>
  Effect.gen(function* layerLocal() {
    yield* TestClock.setTime(START);
    const served = { body: body(A_DAY_LATER), etag: '"v1"' };
    const source = makeSource(() => served);
    yield* readFrom(source.fetch, environment);
    yield* readFrom(source.fetch, environment);
    expect(source.requests).toHaveLength(2);
  }),
);
