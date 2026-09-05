// expect-count: 2
// The root barrel (`import * as E from "effect"` -> `E.Effect.tryPromise`) is understood, but the
// `effect/unstable/http` barrel is not: one import-style change hides every HTTP request in the file.
import { Effect } from 'effect';
import * as Http from 'effect/unstable/http';

export const viaBarrelClient = Effect.gen(function* () {
  const barrelClient = yield* Http.HttpClient.HttpClient;
  return yield* barrelClient.get('https://example.test/a');
});

export const viaBarrelNamespace = Http.HttpClient.post('https://example.test/b');
