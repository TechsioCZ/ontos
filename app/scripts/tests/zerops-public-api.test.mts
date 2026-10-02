import { ConfigProvider, Effect, Layer, Match, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';

const TEST_TOKEN = 'test-token';

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

it.effect('stops a service through its stop action and waits for the stop process to finish', () =>
  Effect.gen(function* stopsService() {
    const requests: string[] = [];
    const client = HttpClient.make((request, url) => {
      requests.push(`${request.method} ${url.pathname}`);
      const body = url.pathname.endsWith('/stop')
        ? { id: 'stop-process', status: 'PENDING' }
        : { id: 'stop-process', status: 'FINISHED' };
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
    });
    const layer = Layer.merge(
      ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: TEST_TOKEN })),
    );
    yield* Effect.gen(function* stopWorker() {
      const api = yield* ZeropsPublicApi;
      yield* api.stopService('worker-service');
    }).pipe(Effect.provide(layer));

    expect(requests).toEqual([
      'PUT /api/rest/public/service-stack/worker-service/stop',
      'GET /api/rest/public/process/stop-process',
    ]);
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
