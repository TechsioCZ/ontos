import { expect, it } from 'effect-rstest';
import { Effect, Exit } from 'effect';
import { verifySnapshot } from '../../scripts/verify-db-schema.mts';

const state = {
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: {
      moduleId: 'demo.sales-insights',
      resourceId: 'default',
      resourceType: 'demo.sales-insights.metric-collection',
      tenantId: '70000000-0000-4000-8000-000000000020',
    },
    title: 'Verifier fixture',
  },
  metrics: [],
};
const row = { revision: 0, state };

it.effect('accepts a fully migrated scope before any aggregate has been seeded', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot([], false)))).toBe(true);
  }),
);
it.effect('fails seeded acceptance when the aggregate is absent', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([], true)))).toBe(true);
  }),
);
it.effect('validates a present aggregate in both readiness and seeded modes', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot([row], false)))).toBe(true);
    expect(Exit.isSuccess(yield* Effect.exit(verifySnapshot([row], true)))).toBe(true);
  }),
);
it.effect('does not treat a malformed existing aggregate as an empty scope', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([{ revision: 0, state: {} }], false)))).toBe(true);
  }),
);
it.effect('rejects an invalid revision and multiple visible aggregates', () =>
  Effect.gen(function* verifyPredicate() {
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([{ ...row, revision: -1 }], false)))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([row, row], false)))).toBe(true);
  }),
);
it.effect('still rejects a present aggregate with a foreign tenant reference', () =>
  Effect.gen(function* verifyPredicate() {
    const foreign = {
      ...state,
      collection: {
        ...state.collection,
        ref: {
          ...state.collection.ref,
          tenantId: '70000000-0000-4000-8000-000000000021',
        },
      },
    };
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([{ revision: 0, state: foreign }], false)))).toBe(true);
  }),
);
