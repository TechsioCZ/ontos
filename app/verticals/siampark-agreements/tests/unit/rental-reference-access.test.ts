import { expect, it } from 'effect-rstest';
import { rentalReferencesReadable } from '../../src/routes/[lang]/siampark/agreements/rental-reference-access.ts';

it('does not load rental owners for the commercial company even when legacy lease contracts exist', () => {
  expect(rentalReferencesReadable({ navigation: [{ moduleId: 'siampark.agreements' }], state: 'available' })).toBe(
    false,
  );
  expect(rentalReferencesReadable({ navigation: [{ moduleId: 'siampark.property' }], state: 'available' })).toBe(false);
  expect(
    rentalReferencesReadable({
      navigation: [{ moduleId: 'siampark.property' }, { moduleId: 'siampark.occupancy' }],
      state: 'available',
    }),
  ).toBe(true);
  expect(
    rentalReferencesReadable({
      navigation: [{ moduleId: 'siampark.property' }, { moduleId: 'siampark.occupancy' }],
      state: 'access_blocked',
    }),
  ).toBe(false);
});
