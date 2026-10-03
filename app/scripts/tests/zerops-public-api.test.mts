import { ConfigProvider, Effect, Fiber, Layer, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';
import type { HttpClientRequest } from 'effect/unstable/http';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/unstable/http';

import { ZeropsApiError } from '../zerops-public-api-error.mts';
import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';

const TEST_TOKEN = 'test-token';
const STOP_PROCESS_PATH = '/process/stop-process';
const STOP_REQUEST = 'PUT /api/rest/public/service-stack/worker-service/stop';
const PROCESS_REQUEST = `GET /api/rest/public${STOP_PROCESS_PATH}`;
const READ_REQUEST = 'GET /api/rest/public/service-stack/worker-service';
const BEFORE_READ_RETRY = '2999 millis';

/** The HttpClient seam: records each request URL and answers with a project env file. */
const zeropsGateway = (envFile: string) => {
  const urls: URL[] = [];
  const client = HttpClient.make((request, url) => {
    urls.push(url);
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ envFile })));
  });
  // The token is read per request, so the provider must cover each call, not only construction.
  const layer = Layer.merge(
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
  );
  return { layer, urls };
};

const workerState = (status: string) =>
  Response.json({ id: 'worker-service', name: 'worker', status, subdomainAccess: false });

/** Keeps the one stop mutation and finished process separate from independently controlled service reads. */
const stopGateway = (
  readService: (
    request: HttpClientRequest.HttpClientRequest,
    read: number,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) => {
  const requests: string[] = [];
  let reads = 0;
  const client = HttpClient.make((request, url) => {
    requests.push(`${request.method} ${url.pathname}`);
    let answer: Effect.Effect<Response, HttpClientError.HttpClientError>;
    if (url.pathname.endsWith('/stop')) {
      answer = Effect.succeed(Response.json({ id: 'stop-process', status: 'PENDING' }));
    } else if (url.pathname.endsWith(STOP_PROCESS_PATH)) {
      answer = Effect.succeed(Response.json({ id: 'stop-process', status: 'FINISHED' }));
    } else {
      answer = readService(request, reads);
      reads += 1;
    }
    return answer.pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)));
  });
  const layer = Layer.merge(
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
  );
  return { layer, requests };
};

const stopWorker = Effect.gen(function* stopWorkerThroughPublicApi() {
  const api = yield* ZeropsPublicApi;
  yield* api.stopService('worker-service');
});

const transportFailure = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ cause: new Error(TEST_TOKEN), request }),
    }),
  );

it.effect('reads the project env file without the project env isolation, so service variables are visible', () =>
  Effect.gen(function* readsServiceVariables() {
    const { layer, urls } = zeropsGateway('catalog_zeropsSubdomain=https://catalog.example\n');
    const environment = yield* Effect.gen(function* readEnvFile() {
      const api = yield* ZeropsPublicApi;
      return yield* api.projectEnvFile('project-id');
    }).pipe(Effect.provide(layer));

    expect(environment.get('catalog_zeropsSubdomain')).toBe('https://catalog.example');
    expect(urls.map((url) => `${url.pathname}${url.search}`)).toEqual([
      '/api/rest/public/project/project-id/env-file?name=&overrideEnvIsolation=none&userOnly=false&reveal=false',
    ]);
  }),
);

it.effect('stops a service once, waits for the process, and independently verifies STOPPED', () =>
  Effect.gen(function* stopsService() {
    const { layer, requests } = stopGateway(() => Effect.succeed(workerState('STOPPED')));
    yield* stopWorker.pipe(Effect.provide(layer));

    expect(requests).toEqual([STOP_REQUEST, PROCESS_REQUEST, READ_REQUEST]);
  }),
);

it.effect('does not accept FINISHED while the service remains ACTIVE and rechecks after three seconds', () =>
  Effect.gen(function* waitsForStoppedLifecycle() {
    let confirmedStopped = false;
    const { layer, requests } = stopGateway((_request, read) =>
      Effect.succeed(workerState(read === 0 ? 'ACTIVE' : 'STOPPED')),
    );
    const fiber = yield* stopWorker.pipe(
      Effect.provide(layer),
      Effect.tap(() =>
        Effect.sync(() => {
          confirmedStopped = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust('0 seconds');
    expect(requests).toHaveLength(3);
    expect(confirmedStopped).toBe(false);
    yield* TestClock.adjust(BEFORE_READ_RETRY);
    expect(requests).toHaveLength(3);
    yield* TestClock.adjust('1 millis');
    yield* Fiber.join(fiber);
    expect(confirmedStopped).toBe(true);
    expect(requests).toEqual([STOP_REQUEST, PROCESS_REQUEST, READ_REQUEST, READ_REQUEST]);
  }),
);

it.effect('retries 429, 503, and transport failures through reads without issuing another stop', () =>
  Effect.gen(function* retriesTransientStopReadback() {
    const { layer, requests } = stopGateway((request, read) => {
      if (read === 0 || read === 1) {
        return Effect.succeed(Response.json({ error: { message: TEST_TOKEN } }, { status: read === 0 ? 429 : 503 }));
      }
      return read === 2 ? transportFailure(request) : Effect.succeed(workerState('STOPPED'));
    });
    const fiber = yield* stopWorker.pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust('0 seconds');
    expect(requests).toHaveLength(3);
    for (const expectedRequests of [4, 5, 6]) {
      yield* TestClock.adjust('3 seconds');
      expect(requests).toHaveLength(expectedRequests);
    }
    yield* Fiber.join(fiber);
    expect(requests.filter((request) => request.startsWith('PUT '))).toEqual([STOP_REQUEST]);
    expect(requests.filter((request) => request.endsWith(STOP_PROCESS_PATH))).toHaveLength(1);
  }),
);

it.effect('bounds a stalled service request and retries the read after the timeout', () =>
  Effect.gen(function* retriesTimedOutStopReadback() {
    const { layer, requests } = stopGateway((_request, read) =>
      read === 0 ? Effect.never : Effect.succeed(workerState('STOPPED')),
    );
    const fiber = yield* stopWorker.pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust('30 seconds');
    expect(requests).toHaveLength(3);
    yield* TestClock.adjust(BEFORE_READ_RETRY);
    expect(requests).toHaveLength(3);
    yield* TestClock.adjust('1 millis');
    yield* Fiber.join(fiber);
    expect(requests).toEqual([STOP_REQUEST, PROCESS_REQUEST, READ_REQUEST, READ_REQUEST]);
  }),
);

it.effect('bounds a stalled transient response body and releases it before retrying the read', () =>
  Effect.gen(function* releasesTransientReadbackBody() {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const { layer, requests } = stopGateway((_request, read) =>
      Effect.succeed(read === 0 ? new Response(stream, { status: 503 }) : workerState('STOPPED')),
    );
    const fiber = yield* stopWorker.pipe(Effect.provide(layer), Effect.forkChild);
    yield* TestClock.adjust('30 seconds');
    expect(cancelled).toBe(true);
    expect(requests).toHaveLength(3);
    yield* TestClock.adjust(BEFORE_READ_RETRY);
    expect(requests).toHaveLength(3);
    yield* TestClock.adjust('1 millis');
    yield* Fiber.join(fiber);
    expect(requests).toEqual([STOP_REQUEST, PROCESS_REQUEST, READ_REQUEST, READ_REQUEST]);
  }),
);

it.effect(
  'fails stop readback immediately on authentication, invalid JSON or state, foreign identity, and disappearance',
  () =>
    Effect.gen(function* rejectsPermanentStopReadbackFailures() {
      const cases = [
        {
          message: 'Zerops service stop readback failed with HTTP 403',
          response: () => Response.json({ error: { message: TEST_TOKEN } }, { status: 403 }),
        },
        { message: 'Zerops service stop readback returned invalid JSON', response: () => new Response('{') },
        {
          message: 'Zerops service stop readback returned an invalid service state',
          response: () => Response.json({ name: 'worker', subdomainAccess: false }),
        },
        {
          message: 'Zerops service stop readback returned a different service identity',
          response: () =>
            Response.json({ id: 'another-service', name: 'worker', status: 'STOPPED', subdomainAccess: false }),
        },
        {
          message: 'Zerops service disappeared while verifying its stop',
          response: () => Response.json({ error: { code: 'serviceStackNotFound' } }, { status: 400 }),
        },
      ];
      for (const scenario of cases) {
        const { layer, requests } = stopGateway(() => Effect.succeed(scenario.response()));
        const error = yield* stopWorker.pipe(Effect.provide(layer), Effect.flip);
        expect(Schema.is(ZeropsApiError)(error)).toBe(true);
        expect(error.message).toBe(scenario.message);
        expect(error.message).not.toContain(TEST_TOKEN);
        expect(requests).toEqual([STOP_REQUEST, PROCESS_REQUEST, READ_REQUEST]);
      }
    }),
);

it.effect('bounds non-STOPPED readback to sixty seconds and reports only the last safe native context', () =>
  Effect.gen(function* timesOutStopReadback() {
    const scenarios = [
      {
        answer: (_request: HttpClientRequest.HttpClientRequest) => Effect.succeed(workerState('ACTIVE')),
        context: 'HTTP 200; status ACTIVE',
      },
      {
        answer: (_request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(Response.json({ error: { message: TEST_TOKEN } }, { status: 503 })),
        context: 'HTTP 503',
      },
      { answer: transportFailure, context: 'transport failure' },
      { answer: () => Effect.never, context: 'request timed out' },
    ];
    for (const scenario of scenarios) {
      const { layer, requests } = stopGateway(scenario.answer);
      const fiber = yield* stopWorker.pipe(Effect.provide(layer), Effect.flip, Effect.forkChild);
      yield* TestClock.adjust('60 seconds');
      const error = yield* Fiber.join(fiber);
      expect(Schema.is(ZeropsApiError)(error)).toBe(true);
      expect(error.message).toBe(
        `Zerops service did not become STOPPED within 60 seconds; last read: ${scenario.context}`,
      );
      expect(error.message).not.toContain(TEST_TOKEN);
      expect(requests.filter((request) => request.startsWith('PUT '))).toHaveLength(1);
      expect(requests.filter((request) => request.endsWith(STOP_PROCESS_PATH))).toHaveLength(1);
      expect(requests.length).toBeGreaterThan(3);
    }
  }),
);

it.effect('creates a sensitive service secret and waits for its process to finish', () =>
  Effect.gen(function* createsServiceSecret() {
    const requests: string[] = [];
    const client = HttpClient.make((request, url) => {
      const body = Match.value(request.body).pipe(
        Match.tag('Uint8Array', (bytes) => new TextDecoder().decode(bytes.body)),
        Match.orElse(() => ''),
      );
      requests.push(`${request.method} ${url.pathname} ${body}`.trim());
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, Response.json({ id: 'secret-process', status: 'FINISHED' })),
      );
    });
    const layer = Layer.merge(
      ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
    );
    yield* Effect.gen(function* storeSecret() {
      const api = yield* ZeropsPublicApi;
      yield* api.createServiceSecret('spicedb-service', 'SPICEDB_GRPC_TLS_KEY', 'pem');
    }).pipe(Effect.provide(layer));

    expect(requests).toEqual([
      'POST /api/rest/public/service-stack/spicedb-service/user-data {"content":"pem","key":"SPICEDB_GRPC_TLS_KEY","sensitive":true}',
      'GET /api/rest/public/process/secret-process',
    ]);
  }),
);

it.effect('reads a deleted service as absent and any other failed read as an error', () =>
  Effect.gen(function* findsServices() {
    const client = HttpClient.make((request, url) => {
      const answer = Match.value(url.pathname).pipe(
        Match.when('/api/rest/public/service-stack/live', () =>
          Response.json({ name: 'worker', status: 'STOPPED', subdomainAccess: false }),
        ),
        Match.when('/api/rest/public/service-stack/deleted', () =>
          Response.json(
            { error: { code: 'serviceStackNotFound', message: 'Service stack not found.' } },
            { status: 400 },
          ),
        ),
        Match.orElse(() => Response.json({ error: { code: 'forbidden', message: 'Forbidden' } }, { status: 403 })),
      );
      return Effect.succeed(HttpClientResponse.fromWeb(request, answer));
    });
    const layer = Layer.merge(
      ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
    );
    const [live, deleted, forbidden] = yield* Effect.gen(function* findAll() {
      const api = yield* ZeropsPublicApi;
      return yield* Effect.all([
        api.findServiceStack('live'),
        api.findServiceStack('deleted'),
        api.findServiceStack('forbidden').pipe(Effect.flip),
      ]);
    }).pipe(Effect.provide(layer));

    expect(live.pipe(Option.map(({ status }) => status))).toStrictEqual(Option.some('STOPPED'));
    expect(Option.isNone(deleted)).toBe(true);
    expect(forbidden.message).toBe('Zerops service read failed with HTTP 403');
  }),
);

it.effect('does not accept a service-not-found payload on authentication or server errors as deletion', () =>
  Effect.gen(function* rejectsAmbiguousDeletion() {
    for (const status of [401, 403, 404, 500]) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ error: { code: 'serviceStackNotFound' } }, { status })),
        ),
      );
      const layer = Layer.merge(
        ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
      );
      const error = yield* Effect.gen(function* readOldService() {
        const api = yield* ZeropsPublicApi;
        return yield* api.findServiceStack('deleted');
      }).pipe(Effect.provide(layer), Effect.flip);
      expect(error.message).toBe(`Zerops service read failed with HTTP ${String(status)}`);
    }
  }),
);
