import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { legacyRentalBaseline } from '../../scripts/legacy-rental-baseline.mts';
import { AgreementsStateSchema, ContractSchema } from '../../shared/apis/records.ts';
import {
  LegacyRentalCleanupRejected,
  legacyRentalScope,
  retireLegacyRental,
} from '../../scripts/legacy-rental-cleanup.mts';

const baseline = Schema.decodeUnknownSync(AgreementsStateSchema)(legacyRentalBaseline);

it.effect('retires only original fixtures, retains unrelated contracts and is idempotent', () =>
  Effect.gen(function* retiresOriginalFixtures() {
    const [fixture] = baseline.contracts;
    const original = yield* Effect.fromNullishOr(fixture);
    const commercial = yield* Schema.decodeEffect(ContractSchema)({
      ...original,
      contractRef: {
        ...original.contractRef,
        resourceId: '99999999-9999-4999-8999-999999999999',
      },
      kind: 'OTHER',
      subject: 'Rámcová obchodní smlouva',
    });
    const state = { ...baseline, contracts: [...baseline.contracts, commercial] };
    const next = yield* retireLegacyRental(legacyRentalScope, state, baseline);
    expect(next.contracts).toEqual([commercial]);
    expect(next.documents).toEqual([]);
    expect(yield* retireLegacyRental(legacyRentalScope, next, baseline)).toBe(next);
    expect(state.contracts).toHaveLength(baseline.contracts.length + 1);
  }),
);

it.effect('fails closed for Siampark, edited fixtures and references from successor contracts', () =>
  Effect.gen(function* rejectsUnsafeCleanup() {
    const wrongScope = yield* retireLegacyRental(
      { ...legacyRentalScope, legalEntityId: '71000000-0000-4000-8000-000000000021' },
      baseline,
      baseline,
    ).pipe(Effect.flip);
    expect(wrongScope).toBeInstanceOf(LegacyRentalCleanupRejected);
    expect(wrongScope.reason).toBe('Legacy rental cleanup is restricted to the Obchodní firma demo scope');
    const edited = yield* retireLegacyRental(
      legacyRentalScope,
      { ...baseline, contracts: baseline.contracts.map((row) => ({ ...row, subject: 'Upravená smlouva' })) },
      baseline,
    ).pipe(Effect.flip);
    expect(edited).toBeInstanceOf(LegacyRentalCleanupRejected);
    expect(edited.reason).toBe('Legacy rental fixture was edited; no records removed');
    const [fixture] = baseline.contracts;
    const original = yield* Effect.fromNullishOr(fixture);
    const successor = yield* Schema.decodeEffect(ContractSchema)({
      ...original,
      contractRef: {
        ...original.contractRef,
        resourceId: '99999999-9999-4999-8999-999999999999',
      },
      supersedesContractRef: original.contractRef,
    });
    const linkedSuccessor = yield* retireLegacyRental(
      legacyRentalScope,
      { ...baseline, contracts: [...baseline.contracts, successor] },
      baseline,
    ).pipe(Effect.flip);
    expect(linkedSuccessor).toBeInstanceOf(LegacyRentalCleanupRejected);
    expect(linkedSuccessor.reason).toBe('Legacy contract has a successor; preserve it for manual review');
  }),
);
