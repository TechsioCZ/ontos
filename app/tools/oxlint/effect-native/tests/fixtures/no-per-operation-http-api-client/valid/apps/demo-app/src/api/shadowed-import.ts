// Module-level construction plus a parameter that shadows the imported constructor.
import { makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import { contactsApi } from './api.ts';

export const clientAtModuleLevel = makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' });

export const withInjectedFactory = (makeEffectHttpApiClient: (api: unknown) => unknown) =>
  makeEffectHttpApiClient(contactsApi);
