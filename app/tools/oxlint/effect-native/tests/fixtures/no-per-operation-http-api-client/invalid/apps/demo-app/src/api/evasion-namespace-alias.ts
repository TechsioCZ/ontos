// expect-count: 2
// Aliased namespace / aliased named imports of the HttpApiClient namespace.
import { Effect } from 'effect';
import * as Client from 'effect/http-api/HttpApiClient';
import { HttpApiClient as HC } from 'effect/http-api';
import { contactsApi } from './api.ts';

export const readiness = (baseUrl: string) =>
  Client.make(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.foundation.readiness({})),
  );

export const listCustomers = (baseUrl: string) =>
  HC.makeWith(contactsApi, { baseUrl }).pipe(
    Effect.flatMap((client) => client.customerList.list({})),
  );
