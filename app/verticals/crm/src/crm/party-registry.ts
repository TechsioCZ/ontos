import { RegistryCompanyIdSchema } from '../../shared/domain/common.ts';
// Browser side of the CRM ↔ Party Registry link (CRM.md §3, ADR-0015). The registry owns the Party, its Contact
// Points and the CUSTOMER role; the CRM only stores the verified PartyRef. Every call runs with the signed-in user's
// own registry rights: a salesperson without registry access cannot create or read registry customers, so the link
// is made by a správce / vedoucí on the client card.
import { createCustomer, listCustomers } from '@app/party-registry/api/client';
import type { CustomerListItem } from '@app/party-registry/api/client';

import { Effect, Option, Predicate, Schema } from 'effect';
import { PartyLinkInputSchema } from '../../shared/domain/clients.ts';
import type { Client } from '../../shared/domain/clients.ts';

export const RegistryFailureSchema = Schema.Literals(['ambiguous', 'forbidden', 'unavailable']);
export type RegistryFailure = typeof RegistryFailureSchema.Type;

const ErrorStatusSchema = Schema.Struct({ status: Schema.Finite });
const statusOf = (error: unknown): number | undefined => {
  const decoded = Schema.decodeUnknownOption(ErrorStatusSchema)(error);
  return Option.isSome(decoded) ? decoded.value.status : undefined;
};

type RegistryRequestFailure =
  | Effect.Error<ReturnType<typeof createCustomer>>
  | Effect.Error<ReturnType<typeof listCustomers>>
  | Schema.SchemaError;

const failureOf = (error: RegistryRequestFailure): RegistryFailure => {
  if (Predicate.isTagged(error, 'CustomerCreateAmbiguous')) {
    return 'ambiguous';
  }
  const status = statusOf(error);
  return status === 401 || status === 403 ? 'forbidden' : 'unavailable';
};

export const registryFailureMessage = {
  ambiguous:
    'V Evidence zákazníků je firma se stejným názvem. Rozhodněte shodu v Prodej › Zákazníci, nebo vyberte existujícího zákazníka.',
  forbidden:
    'Zakládat firmy v evidenci zákazníků smí jen správce. Vyberte existujícího zákazníka, nebo požádejte správce.',
  unavailable: 'Evidence zákazníků je dočasně nedostupná. Zkuste to prosím za chvíli.',
} satisfies Record<RegistryFailure, string>;

/** "Ulice 12, 602 00 Brno" -> street / postal code / city for the registry address Contact Point. */
export const addressParts = (address: string | undefined) => {
  if (address === undefined || address.trim() === '') {
    return {};
  }
  const parts = address.split(',').map((part) => part.trim());
  const last = parts.at(-1) ?? '';
  const zip = /^(?<postalCode>\d{3}\s?\d{2})\s+(?<city>.+)$/u.exec(last);
  const street = parts.length > 1 ? parts.slice(0, -1).join(', ') : '';
  const postalCode = zip?.[1] ?? '';
  const city = zip === null ? last : (zip[2] ?? '');
  type AddressFields = Pick<
    NonNullable<Parameters<typeof createCustomer>[0]['address']>,
    'city' | 'postalCode' | 'street'
  >;
  const parsedAddress: { -readonly [K in keyof AddressFields]: AddressFields[K] } = {};
  if (street !== '') {
    parsedAddress.street = street;
  }
  if (city !== '') {
    parsedAddress.city = city;
  }
  if (postalCode !== '') {
    parsedAddress.postalCode = postalCode;
  }
  return parsedAddress;
};

export const RegisteredCustomerSchema = Schema.Struct({
  link: PartyLinkInputSchema,
  outcome: Schema.Literals(['CREATED', 'EXISTING_CUSTOMER', 'LINKED_EXISTING_PARTY']),
});
export type RegisteredCustomer = typeof RegisteredCustomerSchema.Type;

type ClientFacts = Pick<Client, 'address' | 'email' | 'kind' | 'name' | 'phone' | 'regNo' | 'vatNo'>;

/**
 * Creates (or reuses by IČO) the ORGANIZATION Party and its CUSTOMER role in Party Registry, with the e-mail, phone
 * and address as Contact Points. Fails with a typed reason instead of throwing.
 */
export const registerClientInRegistry = (client: ClientFacts) => {
  const input: Parameters<typeof createCustomer>[0] = {
    address: { ...addressParts(client.address), countryCode: 'CZ' },
    displayName: client.name,
    evidenceReference: `crm-client:${client.name}`.slice(0, 200),
  };
  if (client.kind === 'organization' && client.regNo !== undefined) {
    Object.assign(input, { companyId: client.regNo });
  }
  if (client.kind === 'organization' && client.vatNo !== undefined) {
    Object.assign(input, { vatId: client.vatNo });
  }
  if (client.email !== undefined) {
    Object.assign(input, { email: client.email });
  }
  if (client.phone !== undefined) {
    Object.assign(input, { phone: client.phone });
  }
  return createCustomer(input).pipe(
    Effect.flatMap((created) =>
      Schema.decodeEffect(PartyLinkInputSchema)({
        counterpartyId: created.counterpartyRef.resourceId,
        partyId: created.partyRef.resourceId,
      }).pipe(Effect.map((link): RegisteredCustomer => ({ link, outcome: created.outcome }))),
    ),
    Effect.mapError(failureOf),
  );
};

export const RegistryCustomerSchema = Schema.Struct({
  companyId: Schema.OptionFromUndefinedOr(RegistryCompanyIdSchema),
  displayName: Schema.String,
  link: PartyLinkInputSchema,
});
export type RegistryCustomer = typeof RegistryCustomerSchema.Type;

/** Current (non-archived) CUSTOMER counterparties of the company the user may read in the registry. */
export const loadRegistryCustomers = listCustomers({ includeArchived: false, limit: 500 }).pipe(
  Effect.flatMap((items: readonly CustomerListItem[]) =>
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
