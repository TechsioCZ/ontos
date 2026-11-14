// expect-count: 2
// EVASION: `layerConstructorMembers` is an unconditional lexical shield, so wrapping the
// per-operation client in a per-operation Layer that is immediately `Effect.provide`d silences
// the rule while rebuilding the transport (and the whole layer graph) on every call.
import { Context, Effect, Layer } from 'effect';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

interface ContactsClientService {
  readonly foundation: { readonly readiness: (input: Record<string, never>) => Effect.Effect<unknown> };
}

const ContactsClientTag = Context.GenericTag<ContactsClientService>('ContactsClient');

const program = Effect.gen(function* () {
  const client = yield* ContactsClientTag;
  return yield* client.foundation.readiness({});
});

export const readiness = (baseUrl: string) =>
  Effect.provide(program, Layer.effect(ContactsClientTag, HttpApiClient.make(contactsApi, { baseUrl })));

export const readinessScoped = (baseUrl: string) =>
  Effect.provide(program, Layer.scoped(ContactsClientTag, HttpApiClient.make(contactsApi, { baseUrl })));
