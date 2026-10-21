import type {
  AddressPurposeAssignment,
  ContactPointInput,
  PartyContactPoint,
} from '../../../../../shared/domain/contact-point.ts';
import { foldSearchText } from '@app/admin-ui';
import { DateTime, Option, Schema } from 'effect';

import type { CustomerListItem } from '../../../../../shared/apis/customer-list.ts';
import type { AresSubjectEvidence } from '../../../../../shared/domain/ares-evidence.ts';
import type { Party } from '../../../../../shared/domain/identity-contracts.ts';
import type { OfficialIdentifierAssertion } from '../../../../../shared/domain/identifier-contracts.ts';
import { isValidCzechIco } from '../../../../../shared/domain/identifier-contracts.ts';

const DAY_MS = 86_400_000;
const NEW_CUSTOMER_WINDOW_MS = 30 * DAY_MS;

const epochMillisOf = (iso: string): Option.Option<number> =>
  Option.map(DateTime.make(iso), (value) => DateTime.toEpochMillis(value));

/** Missing or empty text renders as an em dash. */
export const orDash = (value: string | null): string => (value === null || value.length === 0 ? '—' : value);

/** Czech alphabetical order, so diacritics sort as Czech letters (č after c, š after s). */
export const czechCollator = new Intl.Collator('cs-CZ');

/** Reason stored on every party archived from the bulk-edit dialog. */
export const bulkArchiveReason = 'Hromadná archivace ze seznamu zákazníků';

export interface CustomerStats {
  readonly archived: number;
  readonly newLast30Days: number;
  readonly total: number;
  readonly withEmail: number;
}

/**
 * Total, new, e-mail and archived counts. The total counts every listed customer, archived included, so the tiles
 * describe the whole register whatever the table filter shows. New and e-mail counts stay active only.
 */
export const computeCustomerStats = (items: readonly CustomerListItem[], nowMillis: number): CustomerStats => {
  const active = items.filter((item) => item.status === 'ACTIVE');
  const threshold = nowMillis - NEW_CUSTOMER_WINDOW_MS;
  return {
    archived: items.length - active.length,
    newLast30Days: active.filter((item) =>
      Option.match(epochMillisOf(item.createdAt), {
        onNone: () => false,
        onSome: (created) => created >= threshold,
      }),
    ).length,
    total: items.length,
    withEmail: active.filter((item) => item.email !== null && item.email.length > 0).length,
  };
};

const PHONE_QUERY = /^[\d\s()+./-]+$/u;
const NON_DIGITS = /\D/gu;

/** Digits of a phone number without the Czech country prefix, so `777 642 318` finds `+420 777 642 318`. */
const phoneDigits = (value: string): string => value.replaceAll(NON_DIGITS, '').replace(/^(?:00)?420(?=\d{9}$)/u, '');

/**
 * Search covers name, IČO, DIČ, e-mail, city and phone. Case and diacritics are folded on both sides, so `dvorak`
 * finds `Dvořák` and `usti` finds `Ústí`. A query made of digits (spaces, `+`, `-` and brackets allowed) also matches
 * phone numbers by their digits, whichever way they are grouped or prefixed.
 */
export const matchesCustomerSearch = (item: CustomerListItem, query: string): boolean => {
  const trimmed = query.trim();
  const needle = foldSearchText(trimmed);
  if (needle.length === 0) {
    return true;
  }
  if (
    [item.displayName, item.companyId, item.vatId, item.email, item.city, item.phone].some(
      (field) => field !== null && foldSearchText(field).includes(needle),
    )
  ) {
    return true;
  }
  const digits = PHONE_QUERY.test(trimmed) ? phoneDigits(trimmed) : '';
  return digits.length >= 3 && item.phone !== null && phoneDigits(item.phone).includes(digits);
};

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/u;

const csvCell = (value: string): string => {
  const guarded = CSV_FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
};

/** Semicolon-separated CSV with a UTF-8 BOM so Czech spreadsheet apps read diacritics correctly. */
export const buildCustomersCsv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  `﻿${[header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}`;

export interface AresPrefill {
  city?: string;
  name?: string;
  postalCode?: string;
  street?: string;
  vatId?: string;
}

const textOf = (value: Option.Option<string>): string | undefined => Option.getOrUndefined(value);

/** Czech postal codes are written as `170 00`; ARES returns five bare digits. */
export const formatPostalCode = (value: string): string =>
  /^\d{5}$/u.test(value) ? `${value.slice(0, 3)} ${value.slice(3)}` : value;

/** Name key for duplicate checks: whitespace collapsed and case folded the way Czech text compares. */
export const normalizedCustomerName = (value: string): string =>
  value.trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('cs-CZ');

/** Maps an ARES subject onto the create form. Missing provider fields stay undefined. */
export const prefillFromAres = (evidence: AresSubjectEvidence): AresPrefill => {
  const address = Option.getOrUndefined(evidence.subject.registeredAddress);
  const prefill: AresPrefill = {};
  const name = textOf(evidence.subject.businessName);
  const vatId = Option.getOrUndefined(evidence.subject.dic);
  if (name !== undefined) {
    prefill.name = name;
  }
  if (vatId !== undefined) {
    prefill.vatId = vatId;
  }
  if (address !== undefined) {
    const city = textOf(address.municipality);
    const postalCode = textOf(address.postalCode);
    const streetName = textOf(address.street) ?? city;
    const houseNumber = [textOf(address.buildingNumber), textOf(address.orientationNumber)]
      .filter((part): part is string => part !== undefined)
      .join('/');
    const street = [streetName, houseNumber].filter((part): part is string => part !== undefined && part.length > 0);
    if (street.length > 0) {
      prefill.street = street.join(' ');
    }
    if (city !== undefined) {
      prefill.city = city;
    }
    if (postalCode !== undefined) {
      prefill.postalCode = formatPostalCode(postalCode);
    }
  }
  return prefill;
};

export interface CreateDraft {
  readonly city: string;
  readonly email: string;
  readonly ico: string;
  readonly name: string;
  readonly phone: string;
  readonly postalCode: string;
  readonly street: string;
  readonly vatId: string;
}

/**
 * Longest name the create form accepts. A customer without an IČO uses its name as the subject key, and the
 * owner caps subject keys at 200 characters.
 */
export const customerNameMaxLength = 200;

export const CreateValidationKeySchema = Schema.Literals([
  'addressIncomplete',
  'emailInvalid',
  'icoChecksum',
  'icoInvalid',
  'nameRequired',
  'vatIdInvalid',
]);
export type CreateValidationKey = typeof CreateValidationKeySchema.Type;

/** Failing create-form fields mapped to their translation key under `create.validation`. */
export interface CreateDraftErrors {
  city?: CreateValidationKey;
  email?: CreateValidationKey;
  ico?: CreateValidationKey;
  name?: CreateValidationKey;
  phone?: CreateValidationKey;
  postalCode?: CreateValidationKey;
  street?: CreateValidationKey;
  vatId?: CreateValidationKey;
}

/** Returns translation keys (under `create.validation`) for every failing field. */
export const validateCreateDraft = (draft: CreateDraft): CreateDraftErrors => {
  const errors: CreateDraftErrors = {};
  const ico = draft.ico.trim();
  const vatId = draft.vatId.trim().toUpperCase();
  const email = draft.email.trim();
  if (draft.name.trim().length === 0) {
    errors.name = 'nameRequired';
  }
  if (ico.length > 0 && !/^\d{8}$/u.test(ico)) {
    errors.ico = 'icoInvalid';
  } else if (ico.length > 0 && !isValidCzechIco(ico)) {
    // The owner rejects a bad mod-11 checksum with a generic error, so the form names the field first.
    errors.ico = 'icoChecksum';
  }
  if (vatId.length > 0 && !/^CZ\d{8,10}$/u.test(vatId)) {
    errors.vatId = 'vatIdInvalid';
  }
  if (email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    errors.email = 'emailInvalid';
  }
  // The owner (domain rule and database check) keeps an address only with two parts; the client drops a lone one.
  const addressFields = (['street', 'city', 'postalCode'] as const).filter((field) => draft[field].trim().length > 0);
  const [onlyAddressField] = addressFields;
  if (addressFields.length === 1 && onlyAddressField !== undefined) {
    errors[onlyAddressField] = 'addressIncomplete';
  }
  return errors;
};

/** Explicit fields for contact editing; structured addresses never pass through a display string. */
export type CustomerContactFields = Readonly<Record<string, string>>;
export const customerContactFields = (contact: PartyContactPoint) => {
  if (contact.value.type === 'ADDRESS') {
    return Object.fromEntries(Object.entries(contact.value.address).map(([key, value]) => [key, value ?? '']));
  }
  return { value: contact.value.displayValue };
};

interface CustomerPhoneInput {
  countryCode?: string;
  extension?: string;
  preferred: boolean;
  type: 'PHONE';
  value: string;
}

const customerPhoneInput = (
  values: CustomerContactFields,
  existing: PartyContactPoint | undefined,
): ContactPointInput => {
  const input: CustomerPhoneInput = {
    preferred: existing?.value.type === 'PHONE' ? existing.value.preferred : false,
    type: 'PHONE',
    value: values['value'] ?? '',
  };
  const countryCode = existing?.value.type === 'PHONE' ? existing.value.countryCode : null;
  if (countryCode !== null) {
    input.countryCode = countryCode;
  } else if (!input.value.trim().startsWith('+')) {
    input.countryCode = 'CZ';
  }
  if (existing?.value.type === 'PHONE' && existing.value.extension !== null) {
    input.extension = existing.value.extension;
  }
  return input;
};

export const customerContactInput = (
  type: 'EMAIL' | 'PHONE' | 'ADDRESS',
  values: CustomerContactFields,
  existing?: PartyContactPoint,
): ContactPointInput => {
  if (type === 'EMAIL') {
    return {
      preferred: existing?.value.type === 'EMAIL' ? existing.value.preferred : false,
      type,
      value: values['value'] ?? '',
    };
  }
  if (type === 'PHONE') {
    return customerPhoneInput(values, existing);
  }
  const purposes: AddressPurposeAssignment[] = [];
  if (existing?.value.type === 'ADDRESS') {
    for (const purpose of existing.value.purposes) {
      if (purpose.current) {
        if (purpose.registryContext === undefined) {
          purposes.push({ preferred: purpose.preferred, purpose: purpose.purpose });
        } else {
          purposes.push({
            preferred: purpose.preferred,
            purpose: purpose.purpose,
            registryContext: purpose.registryContext,
          });
        }
      }
    }
  } else {
    purposes.push({ preferred: false, purpose: 'CORRESPONDENCE' });
  }
  return {
    address: {
      countryCode: values['countryCode'] ?? 'CZ',
      ...Object.fromEntries(
        Object.entries(values).filter(([key, value]) => key !== 'countryCode' && value.trim() !== ''),
      ),
    },
    purposes,
    type,
  };
};

export const discardCustomerDraftKeys = (draft: Readonly<Record<string, string>>, keys: readonly string[]) => {
  const confirmed = new Set(keys);
  return Object.fromEntries(Object.entries(draft).filter(([key]) => !confirmed.has(key)));
};

export interface CustomerContactRow {
  readonly existing?: PartyContactPoint;
  readonly id: string;
  readonly type: 'EMAIL' | 'PHONE' | 'ADDRESS';
}
export const customerContactRows = (contacts: readonly PartyContactPoint[]): CustomerContactRow[] => {
  const rows: CustomerContactRow[] = contacts.flatMap((existing) =>
    existing.current ? [{ existing, id: existing.contactPointRef.resourceId, type: existing.value.type }] : [],
  );
  for (const type of ['EMAIL', 'PHONE', 'ADDRESS'] as const) {
    rows.push({ id: `new-${type}`, type });
  }
  return rows;
};

export interface CustomerIdentifierRow {
  readonly existing?: OfficialIdentifierAssertion;
  readonly id: string;
  readonly type: 'ICO' | 'CZ_DIC';
}
export const customerIdentifierRows = (
  identifiers: readonly OfficialIdentifierAssertion[],
  now: string,
): CustomerIdentifierRow[] => {
  const current = identifiers.filter(
    (item) => item.state === 'ACTIVE' && item.validFrom <= now && (item.validTo === null || item.validTo > now),
  );
  const rows: CustomerIdentifierRow[] = current.map((existing) => ({
    existing,
    id: existing.officialIdentifierRef.resourceId,
    type: existing.identifierType,
  }));
  for (const type of ['ICO', 'CZ_DIC'] as const) {
    if (!current.some((item) => item.identifierType === type)) {
      rows.push({ id: `new-${type}`, type });
    }
  }
  return rows;
};

export const customerIdentitySummary = (customer: CustomerListItem, party: Party | undefined) => {
  if (party === undefined) {
    return { name: customer.displayName ?? '', status: customer.status };
  }
  return {
    name: Option.getOrElse(party.displayName, () => ''),
    status: Option.isSome(party.archivedAt) ? 'ARCHIVED' : 'ACTIVE',
  };
};

export const emptyCustomerContactFields = (type: CustomerContactRow['type']): CustomerContactFields =>
  type === 'ADDRESS'
    ? { addressLine1: '', addressLine2: '', city: '', countryCode: 'CZ', postalCode: '', region: '' }
    : { value: '' };

export const customerContactRequiresAuthoritativeEdit = (existing: PartyContactPoint | undefined): boolean =>
  existing?.value.type === 'ADDRESS' &&
  existing.value.purposes.some((purpose) => purpose.current && purpose.purpose === 'REGISTERED');

export const customerContactEditable = (existing: PartyContactPoint | undefined, hasParty: boolean): boolean =>
  hasParty && !customerContactRequiresAuthoritativeEdit(existing);

export const customerContactFieldLabel = (type: CustomerContactRow['type'], field: string): string => {
  if (type === 'ADDRESS') {
    return `party-registry.pages.customers.detail.address.${field}`;
  }
  return type === 'EMAIL'
    ? 'party-registry.pages.customers.detail.email'
    : 'party-registry.pages.customers.detail.phone';
};

export const relatedCustomerUrl = (
  language: string,
  path: string,
  customer: CustomerListItem,
  invoices: boolean,
): string => {
  const params = new URLSearchParams({ partyId: customer.partyId });
  if (invoices) {
    params.set('counterpartyId', customer.counterpartyId);
    params.set('tenantId', customer.counterpartyRef.tenantId);
  }
  return `/${language}${path}?${params.toString()}`;
};

export const customerHistoryRows = (
  contacts: readonly PartyContactPoint[],
  identifiers: readonly OfficialIdentifierAssertion[],
) => [
  ...identifiers.flatMap((item) =>
    item.state === 'ACTIVE'
      ? []
      : [
          {
            id: item.officialIdentifierRef.resourceId,
            label: item.normalizedValue,
            recordedAt: item.recordedAt,
            state: item.state,
          },
        ],
  ),
  ...contacts.flatMap((item) =>
    item.current
      ? []
      : [
          {
            id: item.contactPointRef.resourceId,
            label: item.value.type === 'ADDRESS' ? orDash(item.value.address.city) : item.value.displayValue,
            recordedAt: DateTime.formatIso(item.recordedAt),
            state: item.state,
          },
        ],
  ),
];
