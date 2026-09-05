// The runtime constructs its shared client once, using the production defaults.
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { contactsApi } from '../api.ts';
export const browserContactsClient = makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' });
