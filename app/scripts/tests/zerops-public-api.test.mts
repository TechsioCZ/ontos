import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { ZeropsPublicApi, ZeropsPublicApiLive } from '../zerops-public-api.mts';

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
    ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: 'test-token' })),
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
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: 'test-token' })),
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
