// expect-count: 3
// Optional-call / optional-member forms of the constructor and of a client factory, in TSX.
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

const createClient = (baseUrl: string) => makeEffectHttpApiClient?.(contactsApi, { baseUrl });

export const readiness = (baseUrl: string) =>
  HttpApiClient?.make(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );

export function ContactsPanel({ baseUrl }: { readonly baseUrl: string }) {
  const onOpen = () => Effect.runPromise(createClient?.(baseUrl));
  return (
    <button type="button" onClick={onOpen}>
      Open
    </button>
  );
}
