import { expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';
import { CatalogSchema, verifySnapshot, verifyTables } from '../../scripts/verify-db-schema.mts';

const state = { financialPlanEntries: [], invoices: [] };
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

const stateTable = {
  checks: ['CHECK ((revision >= 0))', "CHECK ((jsonb_typeof(state) = 'object'::text))"],
  forceRls: true,
  owner: 'admin',
  policies: ['a', 'd', 'r', 'w'],
  primaryKey: ['tenant_id', 'legal_entity_id'],
  rowSecurity: true,
  runtimeDelete: true,
  runtimeInsert: true,
  runtimeSelect: true,
  runtimeUpdate: true,
  tableName: 'finance_states',
};
const receiptTable = {
  ...stateTable,
  checks: [],
  forceRls: false,
  policies: [],
  primaryKey: ['issuer', 'audience', 'jti'],
  rowSecurity: false,
  runtimeUpdate: false,
  tableName: 'gateway_assertion_redemptions',
};
const documentTable = {
  ...stateTable,
  checks: [],
  primaryKey: ['tenant_id', 'legal_entity_id', 'document_id'],
  tableName: 'finance_document_contents',
};
it.effect('requires receipt immutability while retaining state CRUD and forced RLS', () =>
  Effect.gen(function* verifyPredicate() {
    const valid = yield* Schema.decodeEffect(Schema.Array(CatalogSchema))([documentTable, stateTable, receiptTable]);
    expect(Exit.isSuccess(yield* Effect.exit(verifyTables(valid, 'admin')))).toBe(true);
    for (const invalid of [
      [{ ...documentTable, forceRls: false }, stateTable, receiptTable],
      [{ ...documentTable, runtimeUpdate: false }, stateTable, receiptTable],
      [stateTable, receiptTable],
      [documentTable, stateTable, { ...receiptTable, runtimeUpdate: true }],
      [documentTable, { ...stateTable, runtimeUpdate: false }, receiptTable],
      [documentTable, { ...stateTable, forceRls: false }, receiptTable],
      [documentTable, stateTable, { ...receiptTable, runtimeInsert: false }],
      [documentTable, stateTable, { ...receiptTable, runtimeDelete: false }],
      [documentTable, stateTable, { ...receiptTable, primaryKey: ['jti'] }],
    ]) {
      const tables = yield* Schema.decodeEffect(Schema.Array(CatalogSchema))(invalid);
      expect(Exit.isFailure(yield* Effect.exit(verifyTables(tables, 'admin')))).toBe(true);
    }
  }),
);
