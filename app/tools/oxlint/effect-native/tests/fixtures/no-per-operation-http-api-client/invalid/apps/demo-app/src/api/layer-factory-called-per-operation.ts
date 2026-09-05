// expect-count: 1
// The `make*Live` effect factory is blessed where it feeds `Layer.effect` at module level, but it is
// still a client factory: calling it from an operation builds one more client per call.
import { Context, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

interface ContactsClientService {
  readonly foundation: { readonly readiness: (input: Record<string, never>) => Effect.Effect<unknown> };
}

const ContactsClientTag = Context.GenericTag<ContactsClientService>('ContactsClient');

const makeContactsClientLive = (baseUrl: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* HttpApiClient.make(contactsApi, { baseUrl, httpClient: http });
  });

export const ContactsClientLive = Layer.effect(ContactsClientTag, makeContactsClientLive('/api'));

export const readinessAdHoc = (baseUrl: string) =>
  makeContactsClientLive(baseUrl).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );
