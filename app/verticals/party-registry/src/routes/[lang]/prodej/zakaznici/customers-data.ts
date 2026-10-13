import { DateTime, Effect, Predicate, Random, Schema } from 'effect';

import { executeAresLookup } from '../../../../api/ares-lookup-client.ts';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { createCustomer, listCustomers, updateCustomer } from '../../../../api/customers-client.ts';
import { AresLookupRequestSchema } from '../../../../../shared/apis/ares-lookup.ts';
import type { CreateDraft } from './customers-model.ts';

export interface CustomersSnapshot {
  readonly items: readonly CustomerListItem[];
  readonly nowMillis: number;
}

const correlation = (operation: string) =>
  Effect.map(
    Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }),
    ([first, second]) => `party-registry:${operation}:${first}:${second}`,
  );

/** Every current customer, archived included so the Archivovaní stat is real. */
export const loadCustomers = Effect.all(
  {
    items: listCustomers({ includeArchived: true, limit: 500 }),
    now: DateTime.now,
  },
  { concurrency: 1 },
).pipe(Effect.map(({ items, now }): CustomersSnapshot => ({ items, nowMillis: DateTime.toEpochMillis(now) })));

export const lookupAres = Effect.fn('CustomersData.lookupAres')(function* lookupAresEffect(ico: string) {
  const payload = yield* Schema.decodeEffect(AresLookupRequestSchema)({ ico });
  const requestCorrelation = yield* correlation('ares-lookup');
  return yield* executeAresLookup(payload, requestCorrelation);
});

/** The client trims every field, drops empty ones and sends an address only when two of its parts are present. */
export const createCustomerFromDraft = (draft: CreateDraft) =>
  createCustomer({
    address: { city: draft.city, countryCode: 'CZ', postalCode: draft.postalCode, street: draft.street },
    companyId: draft.ico,
    displayName: draft.name.trim(),
    email: draft.email,
    phone: draft.phone,
    vatId: draft.vatId,
  });

export const renameCustomer = (customer: Pick<CustomerListItem, 'partyRef' | 'partyRevision'>, displayName: string) =>
  updateCustomer(customer, { displayName });

/** Translation key (under `create`) for a failed ARES lookup. */
export const aresFailureKey = (error: Effect.Error<ReturnType<typeof lookupAres>>) =>
  Predicate.isTagged(error, 'AresLookupNotFoundProblem') ? 'aresNotFound' : 'aresUnavailable';

/** Translation key (under `create`) for a failed create. */
export const createFailureKey = (error: Effect.Error<ReturnType<typeof createCustomerFromDraft>>) =>
  Predicate.isTagged(error, 'CustomerCreateAmbiguous') ? 'errorAmbiguous' : 'errorGeneric';

/** Translation key (under `detail`) for a failed rename. */
export const renameFailureKey = (error: Effect.Error<ReturnType<typeof renameCustomer>>) =>
  Predicate.isTagged(error, 'PartyCommandConflictProblem') ? 'conflict' : 'errorRename';
