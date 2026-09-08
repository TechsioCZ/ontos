// A local declaration inside the operation shadows the imported constructor.
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from './api.ts';

export const sharedClient = makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' });

export const withLocalHelper = (baseUrl: string) => {
  const makeEffectHttpApiClient = (api: unknown, options: unknown) => ({ api, options });
  return makeEffectHttpApiClient(contactsApi, { baseUrl });
};
