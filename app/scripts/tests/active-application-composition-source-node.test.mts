import { NodeHttpServer } from '@effect/platform-node';
import { ConfigProvider, Duration, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { FetchHttpClient, HttpServer, HttpServerResponse } from 'effect/unstable/http';
import { NetAddress } from 'effect/unstable/net';
import { expect, it, rstest } from 'effect-rstest';

import {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
} from '../../packages/core-runtime/src/modules/active-application-composition.ts';
import { ActiveApplicationCompositionSourceLive } from '../../packages/core-runtime/src/modules/active-application-composition-source.node.ts';
import { ActiveApplicationCompositionSource } from '../../packages/core-runtime/src/modules/active-application-composition-source-service.ts';
import { ActiveApplicationCompositionUnavailableError } from '../../packages/core-runtime/src/modules/active-application-composition-errors.ts';
import { ONTOS_APPLICATION_COMPOSITION_MAX_BYTES } from '../../packages/core-runtime/src/modules/application-composition-limits.ts';

const httpClient = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ cache: 'no-store', redirect: 'manual' })),
);
const SnapshotText = Schema.fromJsonString(
  Schema.Struct({ revision: Schema.String, validUntil: Schema.DateTimeUtcFromString }),
);
const ONE_SECOND_AFTER_EPOCH = '1970-01-01T00:00:01.000Z';
const encodedSnapshot = (revision: string, validUntil = '2030-01-01T00:00:00.000Z') =>
  Schema.encodeSync(SnapshotText)({
    revision,
    validUntil: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(validUntil),
  });
const encodedActiveApplicationCompositionSnapshot = Effect.suspend(() =>
  ActiveApplicationCompositionSource.pipe(
    Effect.flatMap(({ load }) => load),
    Effect.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient))),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  ),
);

interface SnapshotResponse {
  readonly body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

const serveSnapshot = (response: (request: RequestInit | undefined) => SnapshotResponse) =>
  Effect.gen(function* serveSnapshotEffect() {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        rstest.stubGlobal('fetch', async (_input: Parameters<typeof fetch>[0], request?: RequestInit) => {
          const current = response(request);
          return new Response(current.body, {
            headers: current.headers,
            status: current.status ?? 200,
          });
        }),
      ),
      (resource) => Effect.sync(() => resource[Symbol.dispose]()),
    );
    return 'https://authority.invalid/active';
  });

const sourceConfiguration = (url: string, token?: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN: token,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: url,
    }),
  );

it.effect('the same long-lived Node consumer reads new snapshot bytes after the bounded cache expires', () =>
  Effect.suspend(() => {
    let current = encodedSnapshot('first');
    const authorityServer = HttpServer.serve(Effect.sync(() => HttpServerResponse.text(current))).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    return Effect.gen(function* runtimePromotion() {
      const server = yield* HttpServer.HttpServer;
      const address = yield* Effect.succeed(server.address).pipe(
        Effect.flatMap((value) =>
          NetAddress.isUnixPathAddress(value)
            ? Effect.die('The native test server must use an Internet socket')
            : Effect.succeed(value),
        ),
      );
      const url = yield* Effect.fromResult(NetAddress.toUrl(address));
      url.hostname = '127.0.0.1';
      const source = yield* ActiveApplicationCompositionSource.pipe(
        Effect.provide(
          ActiveApplicationCompositionSourceLive.pipe(
            Layer.provide(httpClient),
            Layer.provide(sourceConfiguration(url.href)),
          ),
        ),
      );
      const read = source.load;
      expect(yield* read).toBe(current);
      current = encodedSnapshot('second');
      expect(yield* read).toBe(encodedSnapshot('first'));
      yield* TestClock.adjust('30 seconds');
      expect(yield* read).toBe(current);
    }).pipe(Effect.provide(authorityServer));
  }),
);

it.live('retains its scoped configuration provider while keeping missing or malformed configuration lazy', () =>
  Effect.gen(function* retainedSourceConfiguration() {
    let requests = 0;
    const token = 'scoped-source-read-token';
    const url = yield* serveSnapshot((request) => {
      requests += 1;
      expect(new Headers(request?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return { body: encodedSnapshot('retained-provider') };
    });
    const source = yield* ActiveApplicationCompositionSource.pipe(
      Effect.provide(
        ActiveApplicationCompositionSourceLive.pipe(
          Layer.provide(httpClient),
          Layer.provide(sourceConfiguration(url, token)),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
    expect(requests).toBe(0);
    expect(yield* source.load.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))))).toBe(
      encodedSnapshot('retained-provider'),
    );
    expect(requests).toBe(1);
    for (const { configuration, reason } of [
      {
        configuration: ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        reason: 'configuration is required',
      },
      { configuration: sourceConfiguration('not a URL'), reason: 'URL is invalid' },
    ]) {
      const unconfigured = yield* ActiveApplicationCompositionSource.pipe(
        Effect.provide(
          ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient), Layer.provide(configuration)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
      expect(requests).toBe(1);
      const failure = yield* Effect.flip(unconfigured.load.pipe(Effect.provide(sourceConfiguration(url, token))));
      expect(failure.reason).toContain(reason);
      expect(requests).toBe(1);
    }
  }).pipe(Effect.scoped),
);

it.effect('coalesces concurrent reads and never caches failed or malformed observations', () =>
  Effect.gen(function* cacheSingleAuthority() {
    let requests = 0;
    let current: SnapshotResponse = { body: encodedSnapshot('first') };
    const url = yield* serveSnapshot(() => {
      requests += 1;
      return current;
    });
    yield* Effect.gen(function* usesOneSourceInstance() {
      const source = yield* ActiveApplicationCompositionSource;
      const read = source.load;
      const concurrent = yield* Effect.all(
        Array.from({ length: 100 }, () => read),
        { concurrency: 'unbounded' },
      );
      expect(concurrent).toEqual(Array.from({ length: 100 }, () => encodedSnapshot('first')));
      expect(requests).toBe(1);
      current = { body: 'unavailable', status: 503 };
      yield* TestClock.adjust('30 seconds');
      expect((yield* Effect.flip(read)).reason).toContain('HTTP 503');
      expect(requests).toBe(2);
      current = { body: '{"not":"an authority observation"}' };
      expect((yield* Effect.flip(read)).reason).toContain('no valid authority deadline');
      expect(requests).toBe(3);
      current = { body: encodedSnapshot('recovered') };
      expect(yield* read).toBe(current.body);
      expect(requests).toBe(4);
    }).pipe(
      Effect.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient))),
      Effect.provide(sourceConfiguration(url)),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  }).pipe(Effect.scoped),
);

it.effect('caps successful raw caching at the published authority deadline', () =>
  Effect.gen(function* cacheCannotExtendLease() {
    yield* TestClock.setTime(0);
    let requests = 0;
    const first = encodedSnapshot('first', ONE_SECOND_AFTER_EPOCH);
    let current = first;
    const url = yield* serveSnapshot(() => {
      requests += 1;
      return { body: current };
    });
    yield* Effect.gen(function* deadlineBoundSourceInstance() {
      const source = yield* ActiveApplicationCompositionSource;
      expect(yield* source.load).toBe(first);
      current = encodedSnapshot('renewed');
      yield* TestClock.adjust('999 millis');
      expect(yield* source.load).toBe(first);
      expect(requests).toBe(1);
      yield* TestClock.adjust('1 millis');
      expect(yield* source.load).toBe(current);
      expect(requests).toBe(2);
    }).pipe(
      Effect.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient))),
      Effect.provide(sourceConfiguration(url)),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  }).pipe(Effect.scoped),
);

it.live('captures many one-byte HTTP fragments without carrying bytes into the next read', () =>
  Effect.gen(function* fragmentedSnapshotBody() {
    let current = encodedSnapshot(`ř${'x'.repeat(65_536)}`, ONE_SECOND_AFTER_EPOCH);
    let fragments = 0;
    const url = yield* serveSnapshot(() => {
      const bytes = new TextEncoder().encode(current);
      let offset = 0;
      return {
        body: new ReadableStream({
          pull: (controller) => {
            if (offset === bytes.byteLength) {
              controller.close();
            } else {
              fragments += 1;
              controller.enqueue(bytes.subarray(offset, offset + 1));
              offset += 1;
            }
          },
        }),
      };
    });
    yield* Effect.gen(function* separateReadAccumulators() {
      const source = yield* ActiveApplicationCompositionSource;
      expect(yield* source.load).toBe(current);
      expect(fragments).toBe(new TextEncoder().encode(current).byteLength);
      current = encodedSnapshot('second', ONE_SECOND_AFTER_EPOCH);
      fragments = 0;
      expect(yield* source.load).toBe(current);
      expect(fragments).toBe(new TextEncoder().encode(current).byteLength);
    }).pipe(
      Effect.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient))),
      Effect.provide(sourceConfiguration(url)),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  }).pipe(Effect.scoped),
);

it.live('uses the configured read token without retaining it in source failures', () =>
  Effect.gen(function* sourceAuthorization() {
    const token = 'fixture-read-only-token';
    let expected = true;
    const url = yield* serveSnapshot((request) => ({
      body: encodedSnapshot('authorized'),
      status: expected && new Headers(request?.headers).get('authorization') === `Bearer ${token}` ? 200 : 401,
    }));
    const read = encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url, token)));
    expect(yield* read).toBe(encodedSnapshot('authorized'));
    expected = false;
    const failure = yield* Effect.flip(read);
    expect(failure.reason).toContain('HTTP 401');
    expect(String(failure)).not.toContain(token);
  }).pipe(Effect.scoped),
);

it.live('bounds the complete HTTP body read, including a stalled stream', () =>
  Effect.gen(function* sourceTimeout() {
    let cancelled = false;
    const url = yield* serveSnapshot(() => ({
      body: new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
    }));
    const [duration, failure] = yield* Effect.timed(
      Effect.flip(encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url)))),
    );
    expect(failure.reason).toContain('timed out');
    expect(Duration.toMillis(duration)).toBeLessThan(10_000);
    expect(cancelled).toBe(true);
  }).pipe(Effect.scoped),
);

it.live('cancels an oversized streaming body and rejects invalid UTF-8', () =>
  Effect.gen(function* strictBodyCapture() {
    let cancelled = false;
    let emitted = 0;
    const chunkBytes = 1024 * 1024;
    let current: SnapshotResponse = {
      body: new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
        pull: (controller) => {
          emitted += chunkBytes;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
      }),
    };
    const url = yield* serveSnapshot(() => current);
    const read = encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url)));
    expect((yield* Effect.flip(read)).reason).toContain('exceeds');
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThanOrEqual(ONTOS_APPLICATION_COMPOSITION_MAX_BYTES + 2 * chunkBytes);
    current = { body: new Uint8Array([0xff]) };
    expect((yield* Effect.flip(read)).reason).toContain('not UTF-8');
  }).pipe(Effect.scoped),
);

it.live('rejects unavailable and oversized responses without retaining the previous snapshot', () =>
  Effect.gen(function* sourceFailures() {
    let current: SnapshotResponse = { body: encodedSnapshot('first') };
    const url = yield* serveSnapshot(() => current);
    const read = encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url)));
    expect(yield* read).toBe(current.body);
    current = { body: 'unavailable', status: 503 };
    expect((yield* Effect.flip(read)).reason).toContain('HTTP 503');
    current = { body: 'x'.repeat(ONTOS_APPLICATION_COMPOSITION_MAX_BYTES + 1) };
    expect((yield* Effect.flip(read)).reason).toContain(`exceeds ${ONTOS_APPLICATION_COMPOSITION_MAX_BYTES} bytes`);
    current = { body: encodedSnapshot('recovered') };
    expect(yield* read).toBe(current.body);
  }).pipe(Effect.scoped),
);

it.live('never follows a source redirect', () =>
  Effect.gen(function* sourceRedirect() {
    const url = yield* serveSnapshot((request) => {
      expect(request?.redirect).toBe('manual');
      expect(request?.cache).toBe('no-store');
      return { body: '', headers: { location: 'https://untrusted.example/active' }, status: 302 };
    });
    const error = yield* Effect.flip(
      encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url))),
    );
    expect(error.reason).toContain('HTTP 302');
  }).pipe(Effect.scoped),
);

it.live('closes failed-status requests immediately even when their body remains open', () =>
  Effect.gen(function* failedResponseLifetime() {
    let signal: AbortSignal | null | undefined;
    const url = yield* serveSnapshot((request) => {
      signal = request?.signal;
      return { body: new ReadableStream(), status: 503 };
    });
    const error = yield* Effect.flip(
      encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url))),
    );
    expect(error.reason).toContain('HTTP 503');
    expect(signal?.aborted).toBe(true);
  }).pipe(Effect.scoped),
);

it.live('layer acquisition is independent of absent, unavailable, and malformed composition', () =>
  Effect.gen(function* lazyBootstrap() {
    let current: SnapshotResponse = { body: 'unavailable', status: 503 };
    const url = yield* serveSnapshot(() => current);
    for (const { configuration, response } of [
      {
        configuration: ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        response: { body: 'unavailable', status: 503 },
      },
      {
        configuration: sourceConfiguration(url),
        response: { body: 'unavailable', status: 503 },
      },
      {
        configuration: sourceConfiguration(url),
        response: { body: 'not a snapshot', status: 200 },
      },
    ]) {
      current = response;
      const runtime = ActiveApplicationCompositionConfigLive.pipe(
        Layer.provide(ActiveApplicationCompositionSourceLive.pipe(Layer.provide(httpClient))),
        Layer.provide(configuration),
      );
      yield* ActiveApplicationCompositionService.pipe(
        Effect.provide(runtime),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
      const unavailable = yield* Effect.flip(
        ActiveApplicationCompositionService.pipe(
          Effect.flatMap(({ load }) => load),
          Effect.provide(runtime),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        ),
      );
      expect(Schema.is(ActiveApplicationCompositionUnavailableError)(unavailable)).toBe(true);
    }
  }).pipe(Effect.scoped),
);

it.effect('only accepts a trusted HTTPS or loopback HTTP source URL', () =>
  Effect.gen(function* trustedSourceUrl() {
    for (const url of [
      'not a URL',
      'http://untrusted.example/active',
      'https://user:password@example.com/active',
      'https://example.com/active?revision=latest',
      'https://example.com/active#fragment',
    ]) {
      const error = yield* Effect.flip(
        encodedActiveApplicationCompositionSnapshot.pipe(Effect.provide(sourceConfiguration(url))),
      );
      expect(error.reason).toMatch(/URL|requires HTTPS/u);
    }
  }),
);
