// Blessed shapes: Layer.unwrap, Effect.cachedWithTTL, and top-level construction.
import { Context, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

interface ContactsClientService {
  readonly foundation: { readonly readiness: (input: Record<string, never>) => Effect.Effect<unknown> };
}

const ContactsClientTag = Context.GenericTag<ContactsClientService>('ContactsClient');

export const ContactsClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return Layer.succeed(ContactsClientTag, yield* HttpApiClient.make(contactsApi, { httpClient: http }));
  }),
);

export const cachedClient = Effect.cachedWithTTL(
  HttpApiClient.make(contactsApi, { baseUrl: '/api' }),
  '1 minute',
);

export const eagerClient = await Effect.runPromise(HttpApiClient.make(contactsApi, { baseUrl: '/api' }));
