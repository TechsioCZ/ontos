// Same member names, different origins: none of these construct an HttpApi client.
import type * as HttpApiClient from 'effect/http-api/HttpApiClient';
import { make } from './local-factory.ts';
import { contactsApi } from './api.ts';

export type ContactsClient = HttpApiClient.Client<never>;

const registry = {
  make: (api: unknown) => api,
  makeEffectHttpApiClient: (api: unknown) => api,
};

export const buildLocal = (name: string) => make(name);
export const buildFromRegistry = () => registry.make(contactsApi);
export const buildComputed = () => registry['makeEffectHttpApiClient'](contactsApi);
