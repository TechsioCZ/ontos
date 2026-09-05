// expect-count: 4
// The factory set closes transitively through functions that return the client directly.
import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from './api.ts';

interface ContactsClientOptions {
  readonly baseUrl?: string;
  readonly locale?: string;
}

const makeClient = (options: ContactsClientOptions) => {
  const config = {
    baseUrl: options.baseUrl ?? '/api',
    requestContext: { locale: options.locale },
  };
  return makeEffectHttpApiClient(contactsApi, config);
};

export const createContactsClient = (options: ContactsClientOptions = {}) => makeClient(options);

export const getContactsReadiness = (options: ContactsClientOptions = {}) =>
  createContactsClient(options).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );

export const listCustomers = (options: ContactsClientOptions = {}) =>
  createContactsClient(options).pipe(Effect.flatMap((client) => client.customerList.list({})));
