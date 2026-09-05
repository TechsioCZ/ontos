// A1/A9 target shape: the client is constructed once while building the Layer.
import { Context, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

interface ContactsClientService {
  readonly customerList: { readonly list: (input: Record<string, never>) => Effect.Effect<unknown> };
  readonly foundation: { readonly readiness: (input: Record<string, never>) => Effect.Effect<unknown> };
}

export const ContactsClientTag = Context.GenericTag<ContactsClientService>('ContactsClient');

export const ContactsClientLive = Layer.effect(
  ContactsClientTag,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* HttpApiClient.make(contactsApi, { httpClient: http });
  }),
);

/** A Layer factory still builds the client once per Layer, not once per operation. */
export const makeContactsClientLayer = (baseUrl: string) =>
  Layer.effect(
    ContactsClientTag,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return yield* HttpApiClient.make(contactsApi, { baseUrl, httpClient: http });
    }),
  );

/** Module-level construction: one client for the module. */
export const sharedClient = HttpApiClient.make(contactsApi, { baseUrl: '/api' });

/** Memoised construction is explicitly allowed. */
export const cachedClient = Effect.cached(HttpApiClient.make(contactsApi, { baseUrl: '/api' }));

/** A suspended Layer still builds the client once per Layer build, through two nested wrappers. */
export const SuspendedContactsClientLive = Layer.suspend(() =>
  Layer.effect(
    ContactsClientTag,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return yield* HttpApiClient.make(contactsApi, { httpClient: http });
    }),
  ),
);

/** Operations yield the shared service instead of building a client. */
export const listCustomers = Effect.gen(function* () {
  const client = yield* ContactsClientTag;
  return yield* client.customerList.list({});
});

export const readiness = (correlationId: string) =>
  Effect.gen(function* () {
    const client = yield* ContactsClientTag;
    return yield* Effect.annotateLogs(client.foundation.readiness({}), { correlationId });
  });
