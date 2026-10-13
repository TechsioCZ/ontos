import { expect, it } from 'effect-rstest';

import {
  customerNameMaxLength,
  validateCreateDraft,
} from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';
import type { CreateDraft } from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';

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
  expect(validateCreateDraft({ ...emptyDraft, city: 'Ústí nad Orlicí' })).toEqual({ city: 'addressIncomplete' });
  expect(validateCreateDraft({ ...emptyDraft, postalCode: '56201' })).toEqual({ postalCode: 'addressIncomplete' });
});

it('accepts an address with two parts and an empty address', () => {
  expect(validateCreateDraft({ ...emptyDraft, city: 'Ústí nad Orlicí', postalCode: '56201' })).toEqual({});
  expect(validateCreateDraft(emptyDraft)).toEqual({});
});

it('checks the IČO format first and the mod-11 checksum second', () => {
  expect(validateCreateDraft({ ...emptyDraft, ico: '2574113' })).toEqual({ ico: 'icoInvalid' });
  expect(validateCreateDraft({ ...emptyDraft, ico: '25741137' })).toEqual({ ico: 'icoChecksum' });
  expect(validateCreateDraft({ ...emptyDraft, ico: '25741136' })).toEqual({});
});

it('keeps the name length limit that the owner subject key enforces', () => {
  expect(customerNameMaxLength).toBe(200);
});
