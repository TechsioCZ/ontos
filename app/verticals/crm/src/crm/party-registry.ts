// Browser side of the CRM ↔ Party Registry link (CRM.md §3, ADR-0015). The registry owns the Party, its Contact
// Points and the CUSTOMER role; the CRM only stores the verified PartyRef. The list runs with the signed-in user's
// own registry rights through Party Registry's customer-list read: a salesperson without registry access cannot
// read registry customers, so the link is made by a správce / vedoucí on the client card. CRM creates registry
// records only through its declared intake workload (`../services/party-intake.ts`), never from the browser.
import { executeCustomerList } from '@app/party-registry/apis/customer-list/client';
import { Effect, Option, Random, Schema } from 'effect';

import { RegistryCompanyIdSchema } from '../../shared/domain/common.ts';
import { PartyLinkInputSchema } from '../../shared/domain/clients.ts';

const RegistryFailureSchema = Schema.Literals(['forbidden', 'unavailable']);
export type RegistryFailure = typeof RegistryFailureSchema.Type;

type RegistryRequestFailure = Effect.Error<ReturnType<typeof executeCustomerList>> | Schema.SchemaError;

const ErrorStatusSchema = Schema.Struct({ status: Schema.Finite });
const failureOf = (error: RegistryRequestFailure): RegistryFailure => {
  const decoded = Schema.decodeUnknownOption(ErrorStatusSchema)(error);
  const status = Option.isSome(decoded) ? decoded.value.status : undefined;
  return status === 401 || status === 403 ? 'forbidden' : 'unavailable';
};

/** Current CUSTOMER Counterparties of the selected Legal Entity through Party Registry's customer-list read. */
const listCustomers = (request: Parameters<typeof executeCustomerList>[0]) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.flatMap(([first, second]) =>
      executeCustomerList(request, `party-registry:customer-list:${first}:${second}`),
    ),
    Effect.map(({ items }) => items),
  );

export const RegistryCustomerSchema = Schema.Struct({
  companyId: Schema.OptionFromUndefinedOr(RegistryCompanyIdSchema),
  displayName: Schema.String,
  link: PartyLinkInputSchema,
});
export type RegistryCustomer = typeof RegistryCustomerSchema.Type;

/** Current (non-archived) CUSTOMER counterparties of the company the user may read in the registry. */
export const loadRegistryCustomers = listCustomers({ includeArchived: false, limit: 500 }).pipe(
  Effect.flatMap((items) =>
    Effect.forEach(
      items.filter((item) => item.status === 'ACTIVE'),
      (item) =>
        Schema.decodeEffect(RegistryCustomerSchema)({
          companyId: item.companyId ?? undefined,
          displayName: item.displayName ?? 'Bez názvu',
          link: { counterpartyId: item.counterpartyId, partyId: item.partyId },
        }),
      { concurrency: 1 },
    ),
  ),
  Effect.map((items) => items.toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs'))),
  Effect.mapError(failureOf),
);
