// Pure view helpers of the clients area (owned by crm-clients). Security filtering is done on the server; these
// only search, sort and label what the signed-in principal already may see.
import { matchesSearch } from '@app/admin-ui';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { Client, ClientEventKind, ContactPerson } from '../../../../../shared/domain/clients.ts';
import { clientSegments } from '../../../../../shared/domain/clients.ts';

export type ClientSegment = (typeof clientSegments)[number];
export { clientSegments };

export const segmentLabels: Record<ClientSegment, string> = {
  bakery: 'Pekárna / výrobna',
  cafe: 'Kavárna / cukrárna',
  catering: 'Catering',
  hotel: 'Hotel',
  institution: 'Instituce / jídelna',
  restaurant: 'Restaurace',
  retail: 'Maloobchod',
  wholesale: 'Velkoobchod',
};

export const segmentLabel = (segment: string | undefined) =>
  segment === undefined ? undefined : (segmentLabels[segment as ClientSegment] ?? segment);

export const kindLabels = { organization: 'Firma', person: 'Fyzická osoba' } as const;

/** Known demo principals of Velkoobchod Hanák (companies lane personas) for readable history rows. */
const knownPrincipals: Record<string, string> = {
  '849fdb3c-fab6-5c14-b20a-d885dc27313d': 'Karel Hanák (správce)',
  '8abb7df7-c19d-5d49-836a-2146dbe5064c': 'Lucie Dvořáková (vedoucí obchodu)',
};

/** Display name of whoever ran a command: salesperson, known persona, or a neutral label. */
export const principalLabel = (records: RecordsResponse, principalId: string) => {
  const salesperson = records.state.salespeople.find((person) => person.principalId === principalId);
  if (salesperson !== undefined) {
    return salesperson.name;
  }
  const known = knownPrincipals[principalId];
  if (known !== undefined) {
    return known;
  }
  return principalId === records.viewer.principalId ? 'Vy' : 'Jiný uživatel';
};

export const activeContactsOf = (records: RecordsResponse, clientId: string): readonly ContactPerson[] =>
  records.state.clients.contacts
    .filter((contact) => contact.clientId === clientId && contact.status === 'active')
    .toSorted((left, right) => Number(right.primary === true) - Number(left.primary === true));

export const primaryContactOf = (records: RecordsResponse, clientId: string): ContactPerson | undefined =>
  activeContactsOf(records, clientId)[0];

export const lastVisitOf = (records: RecordsResponse, clientId: string) =>
  records.state.visits.items
    .filter((visit) => visit.clientId === clientId)
    .reduce<string | undefined>(
      (latest, visit) => (latest === undefined || visit.occurredAt > latest ? visit.occurredAt : latest),
      undefined,
    );

/** City from a free-text address "Ulice 12, 602 00 Brno" -> "Brno". */
export const cityOf = (address: string | undefined) => {
  if (address === undefined) {
    return undefined;
  }
  const last = address.split(',').at(-1)?.trim() ?? '';
  const withoutZip = last.replace(/^\d{3}\s?\d{2}\s+/u, '').trim();
  return withoutZip === '' ? undefined : withoutZip;
};

/** Search over name, IČO, DIČ, e-mail, phone, address and every active contact person (C01). */
export const clientMatches = (records: RecordsResponse, client: Client, query: string) => {
  if (query.trim() === '') {
    return true;
  }
  const digits = query.replaceAll(/\s/gu, '');
  const contacts = activeContactsOf(records, client.id);
  const haystack = [
    client.name,
    client.regNo,
    client.vatNo,
    client.email,
    client.phone,
    client.address,
    client.website,
    segmentLabel(client.segment),
    ...contacts.flatMap((contact) => [contact.name, contact.email, contact.phone, contact.role]),
  ]
    .filter((value) => value !== undefined)
    .join(' | ');
  if (matchesSearch(haystack, query)) {
    return true;
  }
  // Phone numbers are typed with or without spaces / +420.
  return /^\+?\d{3,}$/u.test(digits) && haystack.replaceAll(/\s/gu, '').includes(digits);
};

export const eventLabels: Record<ClientEventKind, string> = {
  assigned: 'Změna obchodníka',
  client_archived: 'Klient archivován',
  client_created: 'Klient založen',
  client_restored: 'Klient obnoven z archivu',
  client_updated: 'Údaje klienta upraveny',
  contact_added: 'Přidána kontaktní osoba',
  contact_removed: 'Odebrána kontaktní osoba',
  contact_updated: 'Upravena kontaktní osoba',
};

export const fieldLabels: Record<string, string> = {
  address: 'adresa',
  email: 'e-mail',
  kind: 'typ klienta',
  name: 'název',
  note: 'poznámka',
  phone: 'telefon',
  primary: 'hlavní kontakt',
  regNo: 'IČO',
  role: 'pracovní role',
  segment: 'segment',
  vatNo: 'DIČ',
  website: 'web',
};

/** Builds `?klient=<id>` on the current list URL (drill-down links from other pages use the same param). */
export const clientHref = (language: string, clientId: string) =>
  `/${language}/crm/klienti?klient=${encodeURIComponent(clientId)}`;
