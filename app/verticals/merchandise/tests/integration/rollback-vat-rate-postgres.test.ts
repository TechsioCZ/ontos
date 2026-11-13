// Until the contract step ships, a rollback to the release before classifications must still decode every product this
// release writes: that release requires a `vatRate` in the product document. This release writes one from a single
// mapping (a held product its held rate, reduced 12 %, standard 21 %) that the window's triggers map back to the same
// classification, and never reads it: altering it changes nothing this release reads.
import { NodeCrypto } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  catalogHeads,
  merchandiseRelations,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../src/database/schema.ts';
import { loadProducts, replaceSnapshot, whereScope } from '../../src/services/merchandise-store.ts';
import { TEST_RATES } from '../support/tax-fixtures.ts';
import { at, decodeState } from './support/merchandise-database.ts';

const base = {
  active: true,
  category: 'Katalog',
  createdAt: at,
  lowStockThreshold: 0,
  priceHistory: [],
  unit: 'ks',
  updatedAt: at,
};
const product = (id: string, taxClassificationCode: string, currentPriceMinor: number) => ({
  ...base,
  currentPriceMinor,
  id,
  name: id,
  sku: id.toUpperCase(),
  taxClassificationCode,
});
const state = decodeState({
  categories: [],
  movements: [],
  orders: [],
  products: [
    product('standard', 'cz.vat.standard', 1000),
    product('reduced', 'cz.vat.reduced', 2000),
    product('held', 'cz.vat.reduced', 49_000),
  ],
});

it.live('every product document keeps a vatRate the previous release decodes, and this release never reads it', () =>
  Effect.scoped(
    Effect.gen(function* rollbackVatRate() {
      const connections = yield* loadDatabaseConnectionPair();
      const client = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
      const admin = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
      const company = { legalEntityId: randomUUID(), tenantId: randomUUID() };
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [priceTiers, productVariants, stockMovements, products, catalogHeads].map((table) =>
            admin.delete(table).where(whereScope(table, company)),
          ),
          { concurrency: 1 },
        ).pipe(Effect.orDie),
      );
      yield* admin.transaction((tx) => replaceSnapshot(tx, company, state, { held: { held: 10 }, rates: TEST_RATES }));
      const stored = client.unsafe<{ readonly classification: string; readonly id: string; readonly rate: unknown }>(
        `select id, tax_classification_code as classification, document -> 'vatRate' as rate
           from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2 order by id`,
        [company.tenantId, company.legalEntityId],
      );
      // The mapping, and the window's trigger kept each classification exactly as this release chose it.
      expect(yield* stored).toEqual([
        { classification: 'cz.vat.reduced', id: 'held', rate: 10 },
        { classification: 'cz.vat.reduced', id: 'reduced', rate: 12 },
        { classification: 'cz.vat.standard', id: 'standard', rate: 21 },
      ]);

      // This release reads the same products whatever the document's rate says (the trigger is bypassed for the probe,
      // which no write path can do).
      const read = loadProducts(admin, company).pipe(Effect.map((loaded) => loaded.map(({ product: entry }) => entry)));
      const before = yield* read;
      yield* client.unsafe("set session_replication_role = 'replica'");
      yield* client.unsafe(
        `update demo_merchandise.products set document = document || '{"vatRate": 99}'::jsonb
          where tenant_id = $1 and legal_entity_id = $2`,
        [company.tenantId, company.legalEntityId],
      );
      yield* client.unsafe("set session_replication_role = 'origin'");
      expect(yield* read).toEqual(before);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
