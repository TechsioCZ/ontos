import { expect, it } from 'effect-rstest';
import { Effect, Exit } from 'effect';
import { catalogMatches, verifySnapshot } from '../../scripts/verify-db-schema.mts';
import { initialCrmState } from '../../shared/domain/state.ts';

const state = initialCrmState;
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

const catalog = {
  enabled: true,
  forced: true,
  no_external_fk: true,
  optimistic_revision: true,
  policies: 4,
  primary_key: true,
  runtime_bypass: false,
  runtime_create: false,
  runtime_delete: true,
  runtime_insert: true,
  runtime_select: true,
  runtime_super: false,
  runtime_update: true,
  runtime_usage: true,
  unique_redemption: true,
};
it('does not weaken FORCE RLS to accommodate the incomplete baseline migration', () => {
  expect(catalogMatches(catalog)).toBe(true);
  expect(catalogMatches({ ...catalog, forced: false })).toBe(false);
  expect(catalogMatches({ ...catalog, runtime_bypass: true })).toBe(false);
  expect(catalogMatches({ ...catalog, runtime_update: false })).toBe(false);
  expect(catalogMatches({ ...catalog, policies: 3 })).toBe(false);
});
it.effect('retains aggregate uniqueness checks for present state', () =>
  Effect.gen(function* verifyPredicate() {
    const client = {
      createdAt: '2026-10-20T08:00:00.000Z',
      createdBy: 'p-admin',
      id: 'client-1',
      kind: 'organization',
      name: 'Client',
      status: 'active',
      updatedAt: '2026-10-20T08:00:00.000Z',
    };
    const duplicate = { ...state, clients: { ...state.clients, items: [client, client] } };
    expect(Exit.isFailure(yield* Effect.exit(verifySnapshot([{ revision: 0, state: duplicate }], false)))).toBe(true);
  }),
);
