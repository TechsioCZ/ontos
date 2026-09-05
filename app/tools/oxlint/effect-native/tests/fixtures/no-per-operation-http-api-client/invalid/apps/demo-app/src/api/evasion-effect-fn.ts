// expect-count: 3
// EVASION: `Effect.fn` / `Effect.fnUntraced` are in `transparentMembers`, so the rule walks
// through the generator body — but unlike `Effect.gen` these return a FUNCTION, so the client is
// rebuilt on every invocation. Audit B4 makes `Effect.fn` the target vocabulary, so this shape
// will become the dominant one.
import { Effect } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

export const readiness = Effect.fn('readiness')(function* (baseUrl: string) {
  const client = yield* HttpApiClient.make(contactsApi, { baseUrl });
  return yield* client.foundation.readiness({});
});

export const listCustomers = Effect.fn(function* (baseUrl: string) {
  const client = yield* HttpApiClient.make(contactsApi, { baseUrl });
  return yield* client.customerList.list({});
});

export const removeCustomer = Effect.fnUntraced(function* (baseUrl: string, id: string) {
  const client = yield* HttpApiClient.make(contactsApi, { baseUrl });
  return yield* client.customerList.remove({ path: { id } });
});
