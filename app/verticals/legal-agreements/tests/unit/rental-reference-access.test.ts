import { expect, it } from 'effect-rstest';
import { rentalReferencesReadable } from '../../src/routes/[lang]/smlouvy/rental-reference-access.ts';

it('does not load rental owners for the commercial company even when legacy lease contracts exist', () => {
  expect(rentalReferencesReadable(new Set(['legal.agreements']))).toBe(false);
  expect(rentalReferencesReadable(new Set(['property.portfolio']))).toBe(false);
  expect(rentalReferencesReadable(new Set(['property.portfolio', 'property.leasing']))).toBe(true);
  expect(rentalReferencesReadable()).toBe(false);
});
