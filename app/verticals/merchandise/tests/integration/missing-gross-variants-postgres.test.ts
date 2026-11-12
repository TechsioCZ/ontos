// Prices stored without their gross, as stage holds some (2 variants without one; 1,766 variants and many products
// whose gross is unrelated to their net), filled on PostgreSQL by the backfill a read or a write runs:
// - a variant or product with no gross in its column nor its document gets one at the rate its classification sells
//   at now; a held product (BOOK-IT, 10 %) gets its held rate, its variants too;
// - a stored gross is never touched, however unrelated to its net, nor one only its document carries.
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { grossUnitPriceMinor } from '../../shared/domain/merchandise-model.ts';
import {
  catalogHeads,
  merchandiseRelations,
  priceTiers,
  productVariants,
  products,
  stockMovements,
} from '../../src/database/schema.ts';
import {
  missingGrossPricesExist,
  replaceSnapshot,
  storeMissingGrossPrices,
  whereScope,
} from '../../src/services/merchandise-store.ts';
import { TEST_PRICING, TEST_RATES } from '../support/tax-fixtures.ts';
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

/** A stage-shaped catalog: variants whose gross is unrelated to their net, and prices without any gross. */
const state = decodeState({
  categories: [],
  movements: [],
  orders: [],
  products: [
    {
      ...base,
      currentPriceMinor: 100,
      id: 'variants',
      name: 'Varianty',
      sku: 'VARIANTS',
      taxClassificationCode: 'cz.vat.standard',
      variants: [
        // Stage: gross and net simply unrelated (1,001,643 minor units apart at worst).
        { attributes: '', grossPriceMinor: 1_001_743, id: 'unrelated', name: 'Nesouvisí', priceMinor: 100, sku: 'V1' },
        { attributes: '', id: 'missing', name: 'Bez ceny s DPH', priceMinor: 200, sku: 'V2' },
        {
          attributes: '',
          grossPriceMinor: 777,
          id: 'document-only',
          name: 'Jen v dokumentu',
          priceMinor: 300,
          sku: 'V3',
        },
      ],
    },
    {
      ...base,
      currentPriceMinor: 50,
      id: 'plain',
      name: 'Bez ceny s DPH',
      sku: 'PLAIN',
      taxClassificationCode: 'cz.vat.standard',
    },
    {
      ...base,
      currentPriceMinor: 49_000,
      id: 'held',
      name: 'BOOK-IT',
      sku: 'BOOK-IT',
      taxClassificationCode: 'cz.vat.reduced',
    },
    {
      ...base,
      currentPriceMinor: 1000,
      id: 'held-variants',
      name: 'BOOK-IT s variantami',
      sku: 'BOOK-IT-V',
      taxClassificationCode: 'cz.vat.reduced',
      variants: [{ attributes: '', id: 'held-missing', name: 'Roční', priceMinor: 1000, sku: 'BOOK-IT-Y' }],
    },
  ],
});

it.live('a missing gross is entered at its rate, a held product at its held rate, a stored one is never touched', () =>
  Effect.scoped(
    Effect.gen(function* missingGrossVariants() {
      const connections = yield* loadDatabaseConnectionPair();
      const admin = yield* makeTestDatabaseFromClient(
        yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 }),
        merchandiseRelations,
      );
      const company = { legalEntityId: randomUUID(), tenantId: randomUUID() };
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [priceTiers, productVariants, stockMovements, products, catalogHeads].map((table) =>
            admin.delete(table).where(whereScope(table, company)),
          ),
          { concurrency: 1 },
        ).pipe(Effect.orDie),
      );
      yield* admin.transaction((tx) => replaceSnapshot(tx, company, state, TEST_PRICING));
      // As stage stores them: no gross in the column nor the document for these, only the document for one variant.
      const clearVariant = (id: string) =>
        admin
          .update(productVariants)
          .set({ grossPriceMinor: null })
          .where(and(whereScope(productVariants, company), eq(productVariants.variantId, id)));
      yield* clearVariant('missing');
      yield* clearVariant('document-only');
      yield* clearVariant('held-missing');
      for (const id of ['plain', 'held']) {
        yield* admin
          .update(products)
          .set({ grossPriceMinor: null })
          .where(and(whereScope(products, company), eq(products.id, id)));
      }
      const variantGross = (id: string) =>
        admin
          .select({ gross: productVariants.grossPriceMinor })
          .from(productVariants)
          .where(and(whereScope(productVariants, company), eq(productVariants.variantId, id)))
          .pipe(Effect.map(([row]) => row?.gross));
      const productGross = (id: string) =>
        admin
          .select({ gross: products.grossPriceMinor })
          .from(products)
          .where(and(whereScope(products, company), eq(products.id, id)))
          .pipe(Effect.map(([row]) => row?.gross));
      const held = { held: 10, 'held-variants': 10 };

      expect(yield* missingGrossPricesExist(admin, company, TEST_RATES, held)).toBe(true);
      const filled = yield* storeMissingGrossPrices(admin, company, TEST_RATES, held);
      expect(filled).toBe(4);
      expect(yield* missingGrossPricesExist(admin, company, TEST_RATES, held)).toBe(false);
      // Entered at the classification's rate now (21 %) …
      expect(yield* variantGross('missing')).toBe(grossUnitPriceMinor(200, 21));
      expect(yield* productGross('plain')).toBe(grossUnitPriceMinor(50, 21));
      // … a held product at its held 10 %, its variant too, never at today's 12 %.
      expect(yield* productGross('held')).toBe(grossUnitPriceMinor(49_000, 10));
      expect(yield* variantGross('held-missing')).toBe(grossUnitPriceMinor(1000, 10));
      // A stored gross, however unrelated to its net, stays; one only the document carries is left to the document.
      expect(yield* variantGross('unrelated')).toBe(1_001_743);
      expect(yield* variantGross('document-only')).toBeNull();
      // Running again fills nothing: the backfill is idempotent.
      expect(yield* storeMissingGrossPrices(admin, company, TEST_RATES, held)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeCrypto.layer)),
);
