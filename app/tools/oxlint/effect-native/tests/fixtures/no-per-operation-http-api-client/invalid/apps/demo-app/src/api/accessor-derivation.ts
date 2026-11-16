// expect-count: 2
// `HttpApiClient.group` / `HttpApiClient.endpoint` take an already-built `httpClient`, so they do not
// rebuild the transport — but deriving the accessor, its Schema wiring and its error channel per
// operation is still A9 per-operation wiring. They get their own message.
import { Effect } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

export const listCustomers = (page: number) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const customers = yield* HttpApiClient.group(contactsApi, 'customerList', { httpClient });
    return yield* customers.list({ payload: { page } });
  });

export const readiness = () =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const check = yield* HttpApiClient.endpoint(contactsApi, 'foundation', 'readiness', { httpClient });
    return yield* check({});
  });
