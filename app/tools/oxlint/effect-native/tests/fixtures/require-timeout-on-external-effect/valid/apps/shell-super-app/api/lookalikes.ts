// Shapes that look external but are not the tracked Effect/HttpClient calls.
import { Effect } from 'effect';
import { HttpClientRequest } from 'effect/unstable/http';

declare const fetchJson: { get: (url: string) => Promise<string> };
declare const repository: { execute: (sql: string) => Promise<void>; head: () => Promise<void> };

// Request *construction*, not request execution.
export const statusRequest = HttpClientRequest.get('https://example.test/status');

// `.get`/`.execute`/`.head` on bindings this file never proved to be an `HttpClient`.
export const raw = fetchJson.get('https://example.test/status');
export const sql = repository.execute('select 1');
export const probe = repository.head();

// A local `tryPromise` lookalike that is not the Effect import.
const Promises = { tryPromise: (thunk: () => Promise<string>) => thunk() };
export const local = Promises.tryPromise(() => fetchJson.get('https://example.test'));

export const pure = Effect.succeed(1);
