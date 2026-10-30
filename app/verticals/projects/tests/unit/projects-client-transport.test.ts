import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import { projectsOperationContexts } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { getProjectsReadiness } from '../../src/api/projects-client.ts';

const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

it.effect('sends the owner operation context, locale and caller traceparent on the native client', () =>
  Effect.gen(function* projectsClientTransport() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(
        Response.json({
          checks: { api: 'ready', moduleFederation: 'ready', ssr: 'ready', translations: 'ready' },
          marker: ultramodernApiMarker,
          status: 'ready',
          versionSkew: 'none',
        }),
      );
    };

    yield* getProjectsReadiness({ baseUrl: 'https://owner.example/projects-api', locale: 'cs', traceparent }).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    );

    const { method, operationId, routePath, source } = projectsOperationContexts.readiness;
    expect(requests.map(({ url }) => url)).toEqual(['https://owner.example/projects-api/projects/readiness']);
    expect(Object.fromEntries(requests[0]?.headers ?? [])).toEqual({
      'accept-language': 'cs',
      traceparent,
      'x-modernjs-bff-operation-context': JSON.stringify({ method, operationId, routePath, source }),
      'x-operation-id': operationId,
    });
  }),
);
