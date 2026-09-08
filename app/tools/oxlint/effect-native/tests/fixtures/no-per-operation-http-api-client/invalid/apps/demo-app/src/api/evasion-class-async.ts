// expect-count: 4
// Class members, curried arrows, async functions and async generators are all operation bodies.
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from './api.ts';

export class ContactsGateway {
  list(page: number) {
    return makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' }).pipe(
      Effect.flatMap((client) => client.customerList.list({ payload: { page } })),
    );
  }

  readonly remove = (id: string) =>
    makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' }).pipe(
      Effect.flatMap((client) => client.customerList.remove({ path: { id } })),
    );
}

export const signIn = (baseUrl: string) => async (email: string) =>
  Effect.runPromise(
    makeEffectHttpApiClient(contactsApi, { baseUrl }).pipe(
      Effect.flatMap((client) => client.authentication.signIn({ payload: { email } })),
    ),
  );

export async function* streamCustomers(baseUrl: string) {
  yield await Effect.runPromise(makeEffectHttpApiClient(contactsApi, { baseUrl }));
}
