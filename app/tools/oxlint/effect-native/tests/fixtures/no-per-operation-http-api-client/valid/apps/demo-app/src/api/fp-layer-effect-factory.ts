// The repository's dominant Live-layer idiom: a module-level `make<X>Live` effect factory whose
// result is handed to `Layer.effect` at module level — see
// `packages/core-runtime/src/permissions/service.ts:207` + `:230`,
// `packages/core-runtime/src/permissions/context-access.ts:264` and
// `packages/core-runtime/src/reads/runtime.ts:746`.
//
// The client is built once per Layer build, which is precisely audit A1's target ("Construct
// HttpApi clients once from injected `HttpClient`") and A9's ("Long-lived HttpApi clients"), so the
// blessing follows the *value* (the factory's effect is consumed by a blessed `Layer.*` call in this
// module), not lexical nesting inside the `Layer.effect(...)` argument list.
//
// Both spellings must agree: `makeContactsClientLive` (arrow + `Effect.gen`) and `makeClientLiveFn`
// (`Effect.fn`) are the same program, and both are silent. Calling either from an operation is still
// reported — see `invalid/layer-factory-called-per-operation.ts`.
import { Context, Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

interface ContactsClientService {
  readonly foundation: {
    readonly readiness: (input: Record<string, never>) => Effect.Effect<unknown>;
  };
}

export const ContactsClientTag = Context.GenericTag<ContactsClientService>('FpContactsClient');

/** Reported today. Should not be: the only consumer is `Layer.effect` below. */
export const makeContactsClientLive = (
  baseUrl: string,
): Effect.Effect<ContactsClientService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    return yield* HttpApiClient.make(contactsApi, { baseUrl, httpClient: http });
  });

export const ContactsClientLive = Layer.effect(ContactsClientTag, makeContactsClientLive('/api'));

/** Not reported today — identical semantics, different spelling. */
export const makeClientLiveFn = Effect.fn('makeClientLiveFn')(function* (baseUrl: string) {
  const http = yield* HttpClient.HttpClient;
  return yield* HttpApiClient.make(contactsApi, { baseUrl, httpClient: http });
});

export const ContactsClientLiveFn = Layer.effect(ContactsClientTag, makeClientLiveFn('/api'));
