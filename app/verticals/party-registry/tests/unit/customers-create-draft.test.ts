import { Result, Schema, SchemaIssue } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CreateDraftSchema,
  customerNameMaxLength,
  czechCollator,
  formatPostalCode,
  normalizedCustomerName,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';
import type { CreateDraft } from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';

const VALIDATION = 'party-registry.pages.customers.create.validation';

/** The failed checks of a create draft: the translation key each one shows, by the field it names. */
const decodeDraft = Schema.decodeUnknownResult(CreateDraftSchema);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const problems = (draft: CreateDraft): Readonly<Record<string, string>> =>
  Result.match(decodeDraft(draft, { errors: 'all' }), {
    onFailure: (error) =>
      Object.fromEntries(
        formatIssues(error.issue).issues.map((issue) => [(issue.path ?? []).map(String).join('.'), issue.message]),
      ),
    onSuccess: () => ({}),
  });

const emptyDraft: CreateDraft = {
  city: '',
  email: '',
  ico: '',
  name: 'Ústí servis s.r.o.',
  phone: '',
  postalCode: '',
  street: '',
  vatId: '',
};

it('flags a lone address part, because the owner would drop it silently', () => {
  expect(problems({ ...emptyDraft, city: 'Ústí nad Orlicí' })).toEqual({ city: `${VALIDATION}.addressIncomplete` });
  expect(problems({ ...emptyDraft, postalCode: '56201' })).toEqual({ postalCode: `${VALIDATION}.addressIncomplete` });
});

it('accepts an address with two parts and an empty address', () => {
  expect(problems({ ...emptyDraft, city: 'Ústí nad Orlicí', postalCode: '56201' })).toEqual({});
  expect(problems(emptyDraft)).toEqual({});
});

it('checks the IČO format first and the mod-11 checksum second', () => {
  expect(problems({ ...emptyDraft, ico: '2574113' })).toEqual({ ico: `${VALIDATION}.icoInvalid` });
  expect(problems({ ...emptyDraft, ico: '25741137' })).toEqual({ ico: `${VALIDATION}.icoChecksum` });
  expect(problems({ ...emptyDraft, ico: '25741136' })).toEqual({});
});

it('keeps the name length limit that the owner subject key enforces', () => {
  expect(customerNameMaxLength).toBe(200);
});

it('writes a Czech postal code with the space, and leaves other codes as they are', () => {
  expect(formatPostalCode('17000')).toBe('170 00');
  expect(formatPostalCode('170 00')).toBe('170 00');
  expect(formatPostalCode('')).toBe('');
});

it('treats names that differ only by case or spacing as the same customer name', () => {
  expect(normalizedCustomerName('  Ústí   Servis s.r.o. ')).toBe(normalizedCustomerName('ústí servis s.r.o.'));
  expect(normalizedCustomerName('Ústí servis')).not.toBe(normalizedCustomerName('Ustí servis'));
});

it('sorts names by Czech collation, so č follows c and š follows s', () => {
  const sorted = ['Šprynar', 'Zeman', 'Čermák', 'Hora', 'Dvořák'].toSorted((left, right) =>
    czechCollator.compare(left, right),
  );
  expect(sorted).toEqual(['Čermák', 'Dvořák', 'Hora', 'Šprynar', 'Zeman']);
});
