import { expect, it } from 'effect-rstest';
import { Effect, Exit } from 'effect';
import { verifySnapshot } from '../../scripts/verify-db-schema.mts';

const state = { activities: [] };
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
