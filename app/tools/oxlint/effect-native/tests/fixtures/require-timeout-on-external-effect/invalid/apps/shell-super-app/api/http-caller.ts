// expect-count: 4
import { Effect } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

const statusRequest = HttpClientRequest.get('https://example.test/status');

export const viaService = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient.execute(statusRequest);
  const listed = yield* httpClient.get('https://example.test/list');
  return [response, listed] as const;
});

export const viaNamespace = HttpClient.post('https://example.test/items');

export const viaParameter = (client: HttpClient.HttpClient) =>
  client.put('https://example.test/items/1').pipe(Effect.mapError(() => new Error('failed')));
