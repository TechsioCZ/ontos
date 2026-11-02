import { expect, it } from 'effect-rstest';

import { contactFieldsInvalid, sameContactFields } from '../../src/routes/[lang]/prodej/zakaznici/customers-model.ts';

it('a contact-point draft differing only in surrounding spaces is the same draft', () => {
  expect(sameContactFields({ value: ' ana@akros.cz ' }, { value: 'ana@akros.cz' })).toBe(true);
  expect(sameContactFields({ value: 'ana@akros.cz' }, { value: 'petr@akros.cz' })).toBe(false);
});

it('an added or removed address line is a change', () => {
  expect(sameContactFields({ addressLine1: 'Vinohradská 1', city: 'Praha' }, { city: 'Praha' })).toBe(false);
  expect(
    sameContactFields(
      { addressLine1: 'Vinohradská 1', city: 'Praha' },
      { addressLine1: ' Vinohradská 1', city: 'Praha ' },
    ),
  ).toBe(true);
});

it('an address needs only its first line, a phone only its value, and an e-mail has to look like one', () => {
  expect(contactFieldsInvalid('ADDRESS', { addressLine1: '', city: 'Praha' })).toBe(true);
  expect(contactFieldsInvalid('ADDRESS', { addressLine1: 'Vinohradská 1' })).toBe(false);
  expect(contactFieldsInvalid('PHONE', { value: '+420 777 123 456' })).toBe(false);
  expect(contactFieldsInvalid('PHONE', { value: '  ' })).toBe(true);
  expect(contactFieldsInvalid('EMAIL', { value: 'ana.akros' })).toBe(true);
  expect(contactFieldsInvalid('EMAIL', { value: 'ana@akros.cz' })).toBe(false);
});
