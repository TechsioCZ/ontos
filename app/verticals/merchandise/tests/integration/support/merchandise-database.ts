// PostgreSQL fixture for merchandise storage tests: an admin (RLS-bypassing) Drizzle database, a fresh random
// tenant + legal entity per test, the given state written with `replaceSnapshot`, and every row of that scope
// deleted again when the test's scope closes.
import { randomUUID } from 'node:crypto';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

import { layerTestDatabase } from '../../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseStateSchema } from '../../../shared/apis/records.ts';
import type { MerchandiseState } from '../../../shared/apis/records.ts';
import {
  catalogHeads,
  categories,
  merchandiseRelations,
  orders,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../../src/database/schema.ts';
import { replaceSnapshot, whereScope } from '../../../src/services/merchandise-store.ts';
import type { StoreScope } from '../../../src/services/merchandise-store.ts';

export type MerchandiseTestDatabase = TestDatabaseFromClient<typeof merchandiseRelations>;
const MerchandiseDatabase = Context.Service<MerchandiseTestDatabase>('MerchandiseTests.Database');

export interface MerchandiseFixture {
  readonly db: MerchandiseTestDatabase;
  readonly revision: number;
  readonly scope: StoreScope;
}

export const decodeState = Schema.decodeUnknownSync(MerchandiseStateSchema);
export const encodeState = Schema.encodeSync(MerchandiseStateSchema);

const deleteScope = (db: MerchandiseTestDatabase, scope: StoreScope) =>
  db.transaction((transaction) =>
    Effect.gen(function* deleteMerchandiseScope() {
      yield* transaction.delete(priceTiers).where(whereScope(priceTiers, scope));
      yield* transaction.delete(productVariants).where(whereScope(productVariants, scope));
      yield* transaction.delete(products).where(whereScope(products, scope));
      yield* transaction.delete(stockMovements).where(whereScope(stockMovements, scope));
      yield* transaction.delete(orders).where(whereScope(orders, scope));
      yield* transaction.delete(categories).where(whereScope(categories, scope));
      yield* transaction.delete(catalogHeads).where(whereScope(catalogHeads, scope));
    }),
  );

/** Runs `run` against `state` stored in a fresh company scope; the scope's rows are removed afterwards. */
export const withMerchandise = <A, E>(
  state: MerchandiseState,
  run: (fixture: MerchandiseFixture) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* merchandiseFixture() {
      const connections = yield* loadDatabaseConnectionPair();
      const services = yield* Layer.build(
        layerTestDatabase(MerchandiseDatabase, {
          connectionString: connections.admin.connectionString,
          poolOptions: { maxConnections: 2 },
          relations: merchandiseRelations,
        }),
      );
      const db = Context.get(services, MerchandiseDatabase);
      const scope: StoreScope = { legalEntityId: randomUUID(), tenantId: randomUUID() };
      yield* Effect.addFinalizer(() => deleteScope(db, scope).pipe(Effect.orDie));
      const revision = yield* db.transaction((transaction) => replaceSnapshot(transaction, scope, state));
      return yield* run({ db, revision, scope });
    }),
  );

export const at = '2026-10-19T08:00:00.000Z';

const base = {
  active: true,
  createdAt: at,
  lowStockThreshold: 0,
  priceHistory: [],
  unit: 'ks',
  updatedAt: at,
  vatRate: 21,
};

/** Encoded catalog used by the storefront read tests (two categories, four products, two storefront orders). */
export const catalogInput = {
  categories: [
    {
      description: 'Krátký popis',
      hasChildren: true,
      heading: 'Šrouby',
      history: [],
      id: 'r',
      imageAlt: 'Šrouby',
      imageSrc: '',
      longDescription: 'Dlouhý popis kořene',
      name: 'Šrouby',
      parentId: null,
      position: 0,
      slug: 'srouby',
    },
    {
      description: '',
      hasChildren: false,
      heading: 'Metrické',
      history: [],
      id: 'c',
      imageAlt: 'Metrické',
      imageSrc: '',
      longDescription: 'Dlouhý popis',
      name: 'Metrické',
      parentId: 'r',
      position: 1,
      slug: 'metricke',
    },
  ],
  homepageFeaturedProductIds: ['p3'],
  movements: [{ at, delta: 5, id: 'receipt', productId: 'p1', reason: 'RECEIPT', variantId: 'v1' }],
  orders: [
    {
      channel: 'STOREFRONT',
      clientRequestId: 'secret-request-1',
      createdAt: at,
      id: 'o1',
      lines: [{ productId: 'p1', productName: 'P1', quantity: 1, sku: 'P1', unitPriceMinor: 100, vatRate: 21 }],
      number: 'OBJ-2026-0001',
      partyId: 'storefront-guest',
      status: 'NEW',
      totalMinor: 100,
      totalVatMinor: 17,
      updatedAt: at,
    },
    {
      channel: 'STOREFRONT',
      clientRequestId: 'secret-request-2',
      createdAt: at,
      demoCleanup: {
        actor: {
          principalId: '20000000-0000-4000-8000-000000000002',
          tenantId: '20000000-0000-4000-8000-000000000001',
        },
        at,
        reason: 'Ukázka skončila',
      },
      id: 'o2',
      lines: [{ productId: 'p1', productName: 'P1', quantity: 1, sku: 'P1', unitPriceMinor: 100, vatRate: 21 }],
      number: 'OBJ-2026-0002',
      partyId: 'storefront-guest',
      status: 'NEW',
      totalMinor: 100,
      totalVatMinor: 17,
      updatedAt: at,
    },
  ],
  products: [
    {
      ...base,
      category: 'Šrouby',
      categoryId: 'c',
      categoryPathIds: ['c', 'r'],
      currentPriceMinor: 100,
      description: 'První odstavec\n\nDruhý odstavec',
      id: 'p1',
      images: ['/a.jpg', '/b.jpg'],
      isRecommended: true,
      name: 'Šroub zinkovaný',
      parameters: [{ label: 'Materiál', unit: '', value: 'nerez A2' }],
      sku: 'P1',
      variants: [{ attributes: '', id: 'v1', name: 'M8 × 20', priceMinor: 100, sku: 'P1-M8' }],
    },
    {
      ...base,
      category: 'Podložky',
      categoryId: 'x',
      currentPriceMinor: 50,
      id: 'p2',
      isSale: true,
      lowStockThreshold: 1,
      name: 'Podložka',
      sku: 'P2',
    },
    {
      ...base,
      category: 'Matice',
      categoryId: 'r',
      categoryPathIds: ['r'],
      currentPriceMinor: 30,
      id: 'p3',
      lowStockThreshold: 1,
      name: 'Matice',
      sku: 'P3',
    },
    {
      ...base,
      category: 'Šrouby',
      currentPriceMinor: 10,
      id: 'p4',
      lowStockThreshold: 1,
      name: 'Skrytý výrobek',
      published: false,
      sku: 'P4',
    },
  ],
};

export const catalogState = decodeState(catalogInput);
