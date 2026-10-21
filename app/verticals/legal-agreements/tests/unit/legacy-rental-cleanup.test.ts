import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { legacyRentalBaseline } from '../../scripts/legacy-rental-baseline.mts';
import { AgreementsStateSchema } from '../../shared/apis/records.ts';
import { legacyRentalScope, retireLegacyRental } from '../../scripts/legacy-rental-cleanup.mts';

const baseline = Schema.decodeUnknownSync(AgreementsStateSchema)(legacyRentalBaseline);

it('retires only original fixtures, retains unrelated contracts and is idempotent', () => {
  const original = baseline.contracts[0];
  if (original === undefined) throw new Error('Missing legacy fixture');
  const commercial = {
    ...original,
    contractRef: {
      ...original.contractRef,
      resourceId: '99999999-9999-4999-8999-999999999999' as typeof original.contractRef.resourceId,
    },
    kind: 'OTHER' as const,
    subject: 'Rámcová obchodní smlouva',
  };
  const state = { ...baseline, contracts: [...baseline.contracts, commercial] };
  const next = retireLegacyRental(legacyRentalScope, state, baseline);
  expect(next.contracts).toEqual([commercial]);
  expect(next.documents).toEqual([]);
  expect(next.signatureObservations).toEqual([]);
  expect(retireLegacyRental(legacyRentalScope, next, baseline)).toBe(next);
  expect(state.contracts).toHaveLength(baseline.contracts.length + 1);
});

it('fails closed for Siampark, edited fixtures and references from successor contracts', () => {
  expect(() =>
    retireLegacyRental(
      { ...legacyRentalScope, legalEntityId: '71000000-0000-4000-8000-000000000021' },
      baseline,
      baseline,
    ),
  ).toThrow();
  expect(() =>
    retireLegacyRental(
      legacyRentalScope,
      { ...baseline, contracts: baseline.contracts.map((row) => ({ ...row, subject: 'Upravená smlouva' })) },
      baseline,
    ),
  ).toThrow();
  const original = baseline.contracts[0];
  if (original === undefined) throw new Error('Missing legacy fixture');
  const successor = {
    ...original,
    contractRef: {
      ...original.contractRef,
      resourceId: '99999999-9999-4999-8999-999999999999' as typeof original.contractRef.resourceId,
    },
    supersedesContractRef: original.contractRef,
  };
  expect(() =>
    retireLegacyRental(legacyRentalScope, { ...baseline, contracts: [...baseline.contracts, successor] }, baseline),
  ).toThrow();
});
