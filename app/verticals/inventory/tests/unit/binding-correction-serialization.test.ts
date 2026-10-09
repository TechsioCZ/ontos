import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';

import { ExactCatalogSelectionMeaningSchema } from '../../shared/domain/stock-item.ts';
import { lockBindingCorrectionScopes } from '../../src/persistence/binding-correction-serialization.ts';

const meaningA = Schema.decodeUnknownSync(ExactCatalogSelectionMeaningSchema)({
  id: 'meaning-a',
  kind: 'PACKAGE_OPTION',
});
const meaningZ = Schema.decodeUnknownSync(ExactCatalogSelectionMeaningSchema)({
  id: 'meaning-z',
  kind: 'PRODUCT_VARIANT',
});

const lockedParams = (statements: readonly { readonly params: readonly unknown[]; readonly sql: string }[]) =>
  statements.filter(({ sql }) => sql.includes('for update')).map(({ params }) => params);

it.effect('locks unique binding meanings in one deterministic owner order', () =>
  Effect.gen(function* serializeBindingMeanings() {
    const statements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const database = yield* makeTestDatabase((sql, params) => {
      statements.push({ params, sql });
      return Effect.succeed([]);
    });

    yield* database.transaction((transaction) =>
      lockBindingCorrectionScopes(transaction, [
        { exactSelectionMeaning: meaningZ, tenantId: 'tenant-b' },
        { exactSelectionMeaning: meaningA, tenantId: 'tenant-a' },
        { exactSelectionMeaning: meaningZ, tenantId: 'tenant-b' },
      ]),
    );

    const bindingLocks = statements.filter(({ sql }) => sql.includes('for update'));
    expect(bindingLocks).toHaveLength(2);
    expect(bindingLocks.map(({ params }) => params)).toEqual([
      ['tenant-a', 'PACKAGE_OPTION', 'meaning-a'],
      ['tenant-b', 'PRODUCT_VARIANT', 'meaning-z'],
    ]);
  }),
);

it.effect('uses the same canonical lock order for opposite caller demand orders', () =>
  Effect.gen(function* oppositeDemandOrders() {
    const firstStatements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const secondStatements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const firstDatabase = yield* makeTestDatabase((sql, params) => {
      firstStatements.push({ params, sql });
      return Effect.succeed([]);
    });
    const secondDatabase = yield* makeTestDatabase((sql, params) => {
      secondStatements.push({ params, sql });
      return Effect.succeed([]);
    });
    const scopeA = { exactSelectionMeaning: meaningA, tenantId: 'shared-tenant' };
    const scopeZ = { exactSelectionMeaning: meaningZ, tenantId: 'shared-tenant' };

    yield* Effect.all(
      [
        firstDatabase.transaction((transaction) => lockBindingCorrectionScopes(transaction, [scopeZ, scopeA])),
        secondDatabase.transaction((transaction) => lockBindingCorrectionScopes(transaction, [scopeA, scopeZ])),
      ],
      { concurrency: 'unbounded' },
    );

    const canonicalOrder = [
      ['shared-tenant', 'PACKAGE_OPTION', 'meaning-a'],
      ['shared-tenant', 'PRODUCT_VARIANT', 'meaning-z'],
    ];
    expect(lockedParams(firstStatements)).toEqual(canonicalOrder);
    expect(lockedParams(secondStatements)).toEqual(canonicalOrder);
  }),
);
