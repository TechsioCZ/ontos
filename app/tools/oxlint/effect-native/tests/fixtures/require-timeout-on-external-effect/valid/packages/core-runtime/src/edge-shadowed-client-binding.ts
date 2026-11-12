// Proving that *one* binding named `client` is an `HttpClient` must not turn every same-named
// binding in the file into one. `.get`/`.post` are the most common method names in the codebase.
import { Effect } from 'effect';
import { HttpClient } from 'effect/unstable/http';

export const remote = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get('https://example.test').pipe(Effect.timeout('2 seconds'));
});

// A `Map`, not an `HttpClient`.
export const cached = (client: Map<string, string>) => client.get('key');

// A local repository object, not an `HttpClient`.
export const stored = (client: { post: (body: string) => void }) => {
  client.post('x');
};
