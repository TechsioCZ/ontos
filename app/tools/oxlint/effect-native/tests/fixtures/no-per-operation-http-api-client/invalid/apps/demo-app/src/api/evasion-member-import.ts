// expect-count: 2
// EVASION: importing the constructor MEMBER directly instead of the namespace.
// `shared/effect-imports.ts` already understands `effect/unstable/httpapi/HttpApiClient`, so the
// module is known — only the member form is checked.
import { Effect } from 'effect';
import { make, makeWith as makeClientWith } from 'effect/unstable/httpapi/HttpApiClient';
import { contactsApi } from './api.ts';

export const readiness = (baseUrl: string) =>
  make(contactsApi, { baseUrl }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));

export const listCustomers = (baseUrl: string) =>
  makeClientWith(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.customerList.list({})),
  );
