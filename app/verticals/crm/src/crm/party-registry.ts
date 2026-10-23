// Browser side of the CRM ↔ Party Registry link (CRM.md §3, ADR-0015). The registry owns the Party, its Contact
// Points and the CUSTOMER role; the CRM only stores the verified PartyRef. Every call runs with the signed-in user's
// own registry rights: a salesperson without registry access cannot create or read registry customers, so the link
// is made by a správce / vedoucí on the client card.
import { createCustomer, listCustomers } from '@app/party-registry/api/client';
import type { CustomerListItem } from '@app/party-registry/api/client';
import { Effect } from 'effect';
import type { Client, PartyLinkInput } from '../../shared/domain/clients.ts';

export type RegistryFailure = 'ambiguous' | 'forbidden' | 'unavailable';

const statusOf = (error: unknown): number | undefined => {
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
};

const failureOf = (error: unknown): RegistryFailure => {
  if (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'CustomerCreateAmbiguous') {
    return 'ambiguous';
  }
  const status = statusOf(error);
  return status === 401 || status === 403 ? 'forbidden' : 'unavailable';
};

export const registryFailureMessage: Record<RegistryFailure, string> = {
  ambiguous:
    'V Evidence zákazníků je firma se stejným názvem. Rozhodněte shodu v Prodej › Zákazníci, nebo vyberte existujícího zákazníka.',
  forbidden:
    'Zakládat firmy v evidenci zákazníků smí jen správce. Vyberte existujícího zákazníka, nebo požádejte správce.',
  unavailable: 'Evidence zákazníků je dočasně nedostupná. Zkuste to prosím za chvíli.',
};

/** "Ulice 12, 602 00 Brno" -> street / postal code / city for the registry address Contact Point. */
export const addressParts = (address: string | undefined) => {
  if (address === undefined || address.trim() === '') {
    return {};
  }
  const parts = address.split(',').map((part) => part.trim());
  const last = parts.at(-1) ?? '';
  const zip = /^(\d{3}\s?\d{2})\s+(.+)$/u.exec(last);
  const street = parts.length > 1 ? parts.slice(0, -1).join(', ') : '';
  const postalCode = zip?.[1] ?? '';
  const city = zip === null ? last : (zip[2] ?? '');
  return {
    ...(street === '' ? {} : { street }),
    ...(city === '' ? {} : { city }),
    ...(postalCode === '' ? {} : { postalCode }),
  };
};

export interface RegisteredCustomer {
  readonly link: PartyLinkInput;
  readonly outcome: 'CREATED' | 'EXISTING_CUSTOMER' | 'LINKED_EXISTING_PARTY';
}

type ClientFacts = Pick<Client, 'address' | 'email' | 'kind' | 'name' | 'phone' | 'regNo' | 'vatNo'>;

/**
 * Creates (or reuses by IČO) the ORGANIZATION Party and its CUSTOMER role in Party Registry, with the e-mail, phone
 * and address as Contact Points. Fails with a typed reason instead of throwing.
 */
export const registerClientInRegistry = (client: ClientFacts) =>
  createCustomer({
    address: { ...addressParts(client.address), countryCode: 'CZ' },
    displayName: client.name,
    evidenceReference: `crm-client:${client.name}`.slice(0, 200),
    ...(client.kind === 'organization' && client.regNo !== undefined ? { companyId: client.regNo } : {}),
    ...(client.kind === 'organization' && client.vatNo !== undefined ? { vatId: client.vatNo } : {}),
    ...(client.email === undefined ? {} : { email: client.email }),
    ...(client.phone === undefined ? {} : { phone: client.phone }),
  }).pipe(
    Effect.map((created): RegisteredCustomer => ({
      link: { counterpartyId: created.counterpartyRef.resourceId, partyId: created.partyRef.resourceId },
      outcome: created.outcome,
    })),
    Effect.mapError(failureOf),
  );

export interface RegistryCustomer {
  readonly companyId: string | undefined;
  readonly displayName: string;
  readonly link: PartyLinkInput;
}

/** Current (non-archived) CUSTOMER counterparties of the company the user may read in the registry. */
export const loadRegistryCustomers = listCustomers({ includeArchived: false, limit: 500 }).pipe(
  Effect.map((items: readonly CustomerListItem[]) =>
    items
      .filter((item) => item.status === 'ACTIVE')
      .map((item): RegistryCustomer => ({
        companyId: item.companyId ?? undefined,
        displayName: item.displayName ?? 'Bez názvu',
        link: { counterpartyId: item.counterpartyId, partyId: item.partyId },
      }))
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName, 'cs')),
  ),
  Effect.mapError(failureOf),
);
