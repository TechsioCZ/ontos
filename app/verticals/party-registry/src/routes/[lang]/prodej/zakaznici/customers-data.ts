import { DateTime, Effect, Predicate, Random, Ref, Schema } from 'effect';

import { executeAresLookup } from '../../../../api/ares-lookup-client.ts';
import type { CustomerListItem } from '../../../../api/customers-client.ts';
import { createCustomer, listCustomers, updateCustomer } from '../../../../api/customers-client.ts';
import { AresLookupRequestSchema } from '../../../../../shared/apis/ares-lookup.ts';
import { PartyCommandForbiddenProblemSchema } from '../../../../../shared/command-api.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
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

/** True for the owner's 403 on a customer write (create, archive). */
export const isCustomerWriteForbidden = Schema.is(PartyCommandForbiddenProblemSchema);

/**
 * Set once the owner refuses a customer write with 403 in this document. A role only changes with a sign-out, which
 * reloads the document, so from then on the page hides its write actions instead of letting each one wait for the
 * owner's refusal again.
 */
const customerWriteRefusal = browserRuntime.runSync(Ref.make(false));
export const customerWritesRefused = (): boolean => browserRuntime.runSync(Ref.get(customerWriteRefusal));
export const rememberCustomerWriteRefusal = (): void => browserRuntime.runSync(Ref.set(customerWriteRefusal, true));

/** Translation key (under `create`) for a failed ARES lookup. */
export const aresFailureKey = (error: Effect.Error<ReturnType<typeof lookupAres>>) =>
  Predicate.isTagged(error, 'AresLookupNotFoundProblem') ? 'aresNotFound' : 'aresUnavailable';

/** Translation key (under `create`) for a failed create. A 403 says so instead of suggesting a retry. */
export const createFailureKey = (error: Effect.Error<ReturnType<typeof createCustomerFromDraft>>) => {
  if (Predicate.isTagged(error, 'CustomerCreateAmbiguous')) {
    return 'errorAmbiguous';
  }
  return isCustomerWriteForbidden(error) ? 'errorForbidden' : 'errorGeneric';
};

/** Translation key (under `detail`) for a failed rename. */
export const renameFailureKey = (error: Effect.Error<ReturnType<typeof renameCustomer>>) =>
  Predicate.isTagged(error, 'PartyCommandConflictProblem') ? 'conflict' : 'errorRename';
