import { DateTime, Option, Schema } from 'effect';

import type { CustomerListItem } from '../../../../../shared/apis/customer-list.ts';
import type { AresSubjectEvidence } from '../../../../../shared/domain/ares-evidence.ts';

const DAY_MS = 86_400_000;
const NEW_CUSTOMER_WINDOW_MS = 30 * DAY_MS;

const epochMillisOf = (iso: string): Option.Option<number> =>
  Option.map(DateTime.make(iso), (value) => DateTime.toEpochMillis(value));

/** Missing or empty text renders as an em dash. */
export const orDash = (value: string | null): string => (value === null || value.length === 0 ? '—' : value);

/** Reason stored on every party archived from the bulk-edit dialog. */
export const bulkArchiveReason = 'Hromadná archivace ze seznamu zákazníků';

export interface CustomerStats {
  readonly archived: number;
  readonly newLast30Days: number;
  readonly total: number;
  readonly withEmail: number;
}

/** Total, new, e-mail and archived counts. Active customers only, except the archived count. */
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
    total: active.length,
    withEmail: active.filter((item) => item.email !== null && item.email.length > 0).length,
  };
};

/** Search covers name, IČO, e-mail and city only, matching the list's search contract. */
export const matchesCustomerSearch = (item: CustomerListItem, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase('cs-CZ');
  if (needle.length === 0) {
    return true;
  }
  return [item.displayName, item.companyId, item.email, item.city].some(
    (field) => field !== null && field.toLocaleLowerCase('cs-CZ').includes(needle),
  );
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
      prefill.postalCode = postalCode;
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
