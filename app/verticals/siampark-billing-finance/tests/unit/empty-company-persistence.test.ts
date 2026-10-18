import { Effect, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import type { FinanceStateSchema, FinanceState } from '../../shared/apis/records.ts';
import { financeStateRepository } from '../../src/services/finance-state-repository.ts';

type EncodedState = typeof FinanceStateSchema.Encoded;
interface Row {
  readonly revision: number;
  readonly state: EncodedState;
}
const empty: FinanceState = {
  accountingObservations: [],
  financialPlanEntries: [],
  invoices: [],
  paymentObservations: [],
};
const fixture = (initial?: Row, conflictOnInsert = false) => {
  const calls: string[] = [];
  let row = initial;
  const persistence = {
    insert: (state: EncodedState) =>
      Effect.sync(() => {
        calls.push('insert');
        if (conflictOnInsert || row !== undefined) {
          return [];
        }
        row = { revision: 1, state };
        return [{ revision: 1 }];
      }),
    load: Effect.sync(() => {
      calls.push('load');
      return row;
    }),
    update: (state: EncodedState, revision: number) =>
      Effect.sync(() => {
        calls.push('update');
        if (row === undefined || row.revision !== revision) {
          return [];
        }
        row = { revision: revision + 1, state };
        return [{ revision: row.revision }];
      }),
  };
  return { calls, repository: financeStateRepository(persistence) };
};
it.effect('reads a fresh company as empty revision zero without writes, then persists its first Action save', () =>
  Effect.gen(function* firstCompanyWrite() {
    const { calls, repository } = fixture();
    expect(yield* repository.load()).toEqual({ revision: 0, state: empty });
    expect(yield* repository.load()).toEqual({ revision: 0, state: empty });
    expect(calls).toEqual(['load', 'load']);
    expect(yield* repository.save(empty, 0)).toBe(1);
    expect(calls).toEqual(['load', 'load', 'update', 'insert']);
    expect(yield* repository.load()).toEqual({ revision: 1, state: empty });
  }),
);
it.effect('uses optimistic update for an existing revision zero row without inserting', () =>
  Effect.gen(function* existingCompanyWrite() {
    const { calls, repository } = fixture({
      revision: 0,
      state: { accountingObservations: [], financialPlanEntries: [], invoices: [], paymentObservations: [] },
    });
    expect(yield* repository.save(empty, 0)).toBe(1);
    expect(calls).toEqual(['update']);
  }),
);
it.effect('reports concurrent first writers and stale revisions as typed conflicts without overwriting state', () =>
  Effect.gen(function* conflictingCompanyWrite() {
    const { calls, repository } = fixture(undefined, true);
    expect(Predicate.isTagged(yield* repository.save(empty, 0).pipe(Effect.flip), 'FinanceConflict')).toBe(true);
    expect(calls).toEqual(['update', 'insert']);
    calls.length = 0;
    expect(Predicate.isTagged(yield* repository.save(empty, 7).pipe(Effect.flip), 'FinanceConflict')).toBe(true);
    expect(calls).toEqual(['update']);
  }),
);
