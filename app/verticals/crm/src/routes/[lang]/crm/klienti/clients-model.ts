// Pure view helpers of the clients area (owned by crm-clients). Security filtering is done on the server; these
// only search, sort and label what the signed-in principal already may see.
import { DateTime } from 'effect';
import { matchesSearch } from '@app/admin-ui';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import { toCsv } from '../../../../../shared/domain/reports.ts';
import type { Client, ClientEventKind, ContactPerson, clientSegments } from '../../../../../shared/domain/clients.ts';

export type ClientSegment = (typeof clientSegments)[number];
export { clientSegments } from '../../../../../shared/domain/clients.ts';

export const segmentLabels = {
  bakery: 'Pekárna / výrobna',
  cafe: 'Kavárna / cukrárna',
  catering: 'Catering',
  hotel: 'Hotel',
  institution: 'Instituce / jídelna',
  restaurant: 'Restaurace',
  retail: 'Maloobchod',
  wholesale: 'Velkoobchod',
} satisfies Record<ClientSegment, string>;

const segmentLabelByKey = new Map(Object.entries(segmentLabels));

export const segmentLabel = (segment: string | undefined) =>
  segment === undefined ? undefined : (segmentLabelByKey.get(segment) ?? segment);

export const kindLabels = { organization: 'Firma', person: 'Fyzická osoba' } as const;

/** Known demo principals of Velkoobchod Hanák (companies lane personas) for readable history rows. */
const knownPrincipals = new Map(
  Object.entries({
    '72000000-0000-4000-8000-000000000021': 'Vedení Siampark',
    '849fdb3c-fab6-5c14-b20a-d885dc27313d': 'Karel Hanák (správce)',
    '8abb7df7-c19d-5d49-836a-2146dbe5064c': 'Lucie Dvořáková (vedoucí obchodu)',
    // scripts/demo/crm-party-intake.mts: the CRM service account that writes clients into Party Registry.
    'b0442ea3-0560-5337-9012-406ef4b5e028': 'Systém CRM (zápis do evidence zákazníků)',
  }),
);

/** Display name of whoever ran a command: salesperson, known persona, or a neutral label. */
export const principalLabel = (records: RecordsResponse, principalId: string) => {
  const salesperson = records.state.salespeople.find((person) => person.principalId === principalId);
  if (salesperson !== undefined) {
    return salesperson.name;
  }
  const known = knownPrincipals.get(principalId);
  if (known !== undefined) {
    return known;
  }
  return principalId === records.viewer.principalId ? 'Vy' : 'Jiný uživatel';
};

/** Is the client linked to its canonical identity in Evidence zákazníků (CRM.md §3)? */
export const partyLinked = (client: Client) => client.partyRef?.counterpartyId !== undefined;

export const activeContactsOf = (records: RecordsResponse, clientId: string): readonly ContactPerson[] =>
  records.state.clients.contacts
    .filter((contact) => contact.clientId === clientId && contact.status === 'active')
    .toSorted((left, right) => Number(right.primary === true) - Number(left.primary === true));

export const primaryContactOf = (records: RecordsResponse, clientId: string): ContactPerson | undefined =>
  activeContactsOf(records, clientId)[0];

export const lastVisitOf = (records: RecordsResponse, clientId: string) => {
  let latest: DateTime.Utc | undefined;
  for (const visit of records.state.visits.items) {
    if (visit.clientId === clientId && (latest === undefined || DateTime.isGreaterThan(visit.occurredAt, latest))) {
      latest = visit.occurredAt;
    }
  }
  return latest;
};

/** City from a free-text address "Ulice 12, 602 00 Brno" -> "Brno". */
export const cityOf = (address: string | undefined) => {
  if (address === undefined) {
    return address;
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

export const eventLabels = {
  assigned: 'Změna obchodníka',
  client_archived: 'Klient archivován',
  client_created: 'Klient založen',
  client_restored: 'Klient obnoven z archivu',
  client_updated: 'Údaje klienta upraveny',
  contact_added: 'Přidána kontaktní osoba',
  contact_removed: 'Odebrána kontaktní osoba',
  contact_updated: 'Upravena kontaktní osoba',
  party_linked: 'Propojeno s evidencí zákazníků',
} satisfies Record<ClientEventKind, string>;

export const fieldLabels = new Map(
  Object.entries({
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
  }),
);

/**
 * Contacts export (S15-02, C01): one row per active contact person of the given clients, a client without contact
 * persons gets one row with its own phone / e-mail. Built only from the server-projected records, so a principal
 * never exports a client (counterparty) it may not see.
 */
export const contactsCsv = (records: RecordsResponse, clients: readonly Client[]) => {
  const owner = (client: Client) =>
    records.state.salespeople.find((person) => person.id === client.ownerSalespersonId)?.name ?? '';
  const rows = clients.flatMap((client) => {
    const base = [
      client.name,
      client.kind === 'organization' ? 'Firma' : 'Fyzická osoba',
      client.regNo,
      client.status === 'active' ? 'aktivní' : 'archivovaný',
      owner(client),
      client.phone,
      client.email,
      client.address,
      partyLinked(client) ? 'propojeno' : 'nepropojeno',
    ];
    const contacts = activeContactsOf(records, client.id);
    return contacts.length === 0
      ? [[...base, '', '', '', '', '']]
      : contacts.map((contact) => [
          ...base,
          contact.name,
          contact.role,
          contact.phone,
          contact.email,
          contact.primary === true ? 'ano' : '',
        ]);
  });
  return toCsv(
    [
      'Klient',
      'Typ',
      'IČO',
      'Stav',
      'Obchodník',
      'Telefon klienta',
      'E-mail klienta',
      'Adresa',
      'Evidence zákazníků',
      'Kontaktní osoba',
      'Pracovní role',
      'Telefon osoby',
      'E-mail osoby',
      'Hlavní kontakt',
    ],
    rows,
  );
};
