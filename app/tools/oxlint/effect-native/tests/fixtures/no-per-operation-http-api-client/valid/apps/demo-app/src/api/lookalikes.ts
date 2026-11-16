// Syntactic look-alikes that are not HttpApi client construction.
import { Effect } from 'effect';
import type { HttpApiClient } from 'effect/unstable/httpapi';
import { contactsApi } from './api.ts';

/** Locally defined helper with the constructor's name: not an import binding. */
const makeEffectHttpApiClient = (api: unknown, options: unknown) => ({ api, options });

export const localLookalike = () => makeEffectHttpApiClient(contactsApi, { baseUrl: '/api' });

/** Type-only use of the HttpApiClient namespace never constructs anything. */
export type ContactsClient = HttpApiClient.Client<never>;

/** A non-Effect object that happens to expose `.make`. */
const HttpApiClientFactory = { make: (api: unknown) => api };

export const notEffect = () => HttpApiClientFactory.make(contactsApi);

/** Ordinary module helpers called from a function must not report. */
const buildHeaders = (token: string) => ({ authorization: token });

export const operation = (token: string) => Effect.succeed(buildHeaders(token));
