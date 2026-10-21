import { expect, it } from 'effect-rstest';
import { rentalReferencesReadable } from '../../src/routes/[lang]/smlouvy/rental-reference-access.ts';

it('does not load rental owners for the commercial company even when legacy lease contracts exist', () => {
  expect(rentalReferencesReadable({ navigation: [{ moduleId: 'legal.agreements' }], state: 'available' })).toBe(
    false,
  );
  expect(rentalReferencesReadable({ navigation: [{ moduleId: 'property.portfolio' }], state: 'available' })).toBe(false);
  expect(
    rentalReferencesReadable({
      navigation: [{ moduleId: 'property.portfolio' }, { moduleId: 'property.leasing' }],
      state: 'available',
    }),
  ).toBe(true);
  expect(
    rentalReferencesReadable({
      navigation: [{ moduleId: 'property.portfolio' }, { moduleId: 'property.leasing' }],
      state: 'access_blocked',
    }),
  ).toBe(false);
});
