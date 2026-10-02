import { ConfigProvider, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';

import { ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY } from '../../packages/core-runtime/src/modules/active-application-composition-edge.ts';
import { ActiveApplicationCompositionPublicationError } from '../active-application-composition.mts';
import {
  configureRuntimeCompositionSource,
  validateNativeCompositionSourceUrl,
} from '../configure-runtime-composition-source.mts';
import { ZeropsPublicApiLive } from '../zerops-public-api.mts';
import { ZeropsApiError } from '../zerops-public-api-error.mts';

const SOURCE_URL = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}/values/${ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY}`;
const READ_TOKEN = 'read-only-test-credential';
const input = { projectId: 'project-id', readToken: Redacted.make(READ_TOKEN), url: SOURCE_URL };

interface Request {
  readonly body: string;
  readonly method: string;
  readonly path: string;
}

const provider = (
  existing: readonly { readonly content: string; readonly id: string; readonly key: string }[] = [],
  rejectWrites = false,
) => {
  const requests: Request[] = [];
  const client = HttpClient.make((request, destination) => {
    requests.push({
      body: Match.value(request.body).pipe(
        Match.tag('Uint8Array', (bytes) => new TextDecoder().decode(bytes.body)),
        Match.orElse(() => ''),
      ),
      method: request.method,
      path: destination.pathname,
    });
    const response = Match.value(destination.pathname).pipe(
      Match.when('/api/rest/public/project/project-id', () => Response.json({ clientId: 'client-id' })),
      Match.when('/api/rest/public/project/search', () => Response.json({ items: [{ envList: existing }] })),
      Match.orElse(() =>
        rejectWrites
          ? Response.json({ private: READ_TOKEN }, { status: 403 })
          : Response.json({ id: 'configuration-process', status: 'FINISHED' }),
      ),
    );
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = Layer.merge(
    ZeropsPublicApiLive.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ConfigProvider.layer(ConfigProvider.fromUnknown({ ZEROPS_TOKEN: 'test-configuration-token' })),
  );
  return { layer, requests };
};

it.effect('configures one stable URL and a sensitive read credential without restarting any service', () =>
  Effect.gen(function* configuresNativeSource() {
    const { layer, requests } = provider();
    yield* configureRuntimeCompositionSource(input).pipe(Effect.provide(layer));
    const writes = requests.filter(({ path }) => path === '/api/rest/public/project/project-id/env');
    expect(writes.map(({ method }) => method)).toEqual(['POST', 'POST']);
    expect(writes.map(({ body }) => body)).toEqual([
      `{"content":"${SOURCE_URL}","key":"ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL","sensitive":false}`,
      `{"content":"${READ_TOKEN}","key":"ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN","sensitive":true}`,
    ]);
    expect(requests.some(({ path }) => path.includes('/service-stack/'))).toBe(false);
  }),
);

it.effect('retains the configured URL and enforces credential sensitivity on repeated configuration', () =>
  Effect.gen(function* enforcesSensitiveCredential() {
    const { layer, requests } = provider([
      { content: SOURCE_URL, id: 'source-id', key: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL' },
      { content: READ_TOKEN, id: 'token-id', key: 'ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN' },
    ]);
    yield* configureRuntimeCompositionSource(input).pipe(Effect.provide(layer));
    const writes = requests.filter(({ method }) => method === 'PUT');
    expect(writes).toEqual([
      {
        body: `{"content":"${READ_TOKEN}","key":"ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN","sensitive":true}`,
        method: 'PUT',
        path: '/api/rest/public/project-env/token-id',
      },
    ]);
  }),
);

it.effect('rejects non-native destinations and URL credentials before touching Zerops', () =>
  Effect.gen(function* rejectsForeignDestinations() {
    const { layer, requests } = provider();
    for (const url of [
      SOURCE_URL.replace('api.cloudflare.com', 'untrusted.example'),
      SOURCE_URL.replace('https://', 'http://'),
      SOURCE_URL.replace('https://', 'https://credential@'),
      `${SOURCE_URL}?credential=secret`,
      `${SOURCE_URL}#fragment`,
      SOURCE_URL.replace('/namespaces/', '/unexpected/'),
    ]) {
      const rejected = yield* configureRuntimeCompositionSource({ ...input, url }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(Schema.is(ActiveApplicationCompositionPublicationError)(rejected)).toBe(true);
    }
    expect(requests).toEqual([]);
    expect(yield* validateNativeCompositionSourceUrl(SOURCE_URL)).toBe(SOURCE_URL);
  }),
);

it.effect('rejects KV keys that differ from the Worker reader before storing runtime configuration', () =>
  Effect.gen(function* rejectsDifferentCompositionKeys() {
    const { layer, requests } = provider();
    const valueEndpoint = SOURCE_URL.slice(0, -ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY.length);
    for (const key of ['stage', 'production', 'other', '%73tage', '%61ctive', 'active%2Fother', 'active/other']) {
      const rejected = yield* configureRuntimeCompositionSource({ ...input, url: `${valueEndpoint}${key}` }).pipe(
        Effect.provide(layer),
        Effect.match({
          onFailure: Schema.is(ActiveApplicationCompositionPublicationError),
          onSuccess: () => false,
        }),
      );
      expect(rejected).toBe(true);
    }
    expect(requests).toEqual([]);
    expect(yield* validateNativeCompositionSourceUrl(SOURCE_URL)).toBe(SOURCE_URL);
  }),
);

it.effect('rejects an empty read credential before storing runtime configuration', () =>
  Effect.gen(function* rejectsEmptyCredential() {
    const { layer, requests } = provider();
    const rejected = yield* configureRuntimeCompositionSource({ ...input, readToken: Redacted.make(' ') }).pipe(
      Effect.provide(layer),
      Effect.flip,
    );
    expect(Schema.is(ActiveApplicationCompositionPublicationError)(rejected)).toBe(true);
    expect(requests).toEqual([]);
  }),
);

it.effect('keeps provider errors from carrying read credentials into diagnostics', () =>
  Effect.gen(function* sanitizesConfigurationFailure() {
    const { layer } = provider([], true);
    const rejected = yield* configureRuntimeCompositionSource(input).pipe(Effect.provide(layer), Effect.flip);
    expect(Schema.is(ZeropsApiError)(rejected)).toBe(true);
    expect(rejected.message).toBe('runtime composition source configuration failed');
    expect(rejected.cause).toBeUndefined();
  }),
);
