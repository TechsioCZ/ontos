import { expect, it } from 'effect-rstest';
import { contactCountLabel } from '../../src/routes/[lang]/siampark/occupancy/contact-count.ts';

it('uses Czech singular, few and other contact-count forms', () => {
  for (const [count, expected] of [
    [0, '0 kontaktních osob'],
    [1, '1 kontaktní osoba'],
    [2, '2 kontaktní osoby'],
    [3, '3 kontaktní osoby'],
    [4, '4 kontaktní osoby'],
    [5, '5 kontaktních osob'],
    [11, '11 kontaktních osob'],
    [21, '21 kontaktních osob'],
  ] as const) {
    expect(contactCountLabel(count)).toBe(expected);
  }
});
