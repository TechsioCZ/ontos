// The tax-classification migration on a database holding the catalog as stage holds it before the migration:
// products at 21, 12 and 10 % (BOOK-IT), stored gross prices that are not net plus VAT, order lines at 21, 12, 10 and
// 0 % and an order without lines. A product at any other rate stops the migration and leaves nothing changed; once it
// is decided the migration maps 21 to standard and 12/10 to reduced, gives history lines a classification only where
// it is unambiguous, and changes no stored price or amount.
import { fileURLToPath } from 'node:url';

import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Array as Arr, Crypto, Effect, FileSystem, Layer, Order, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { CompanyTaxRatesSchema } from '../../src/services/tax-rates.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const TAX_CLASSIFICATION = '20261112010127_tax-classification';
const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const migrationOptions = (folder: string) => ({
  migrationsFolder: folder,
  migrationsSchema: 'drizzle',
  migrationsTable: '__drizzle_migrations_demo_merchandise',
});

interface ProductFixture {
  readonly gross: number | null;
  readonly id: string;
  readonly net: number;
  readonly vatRate: number;
}
/** As on stage: off by one (N1), off by a lot (AKROS `10520900`), BOOK-IT at 10 % and a reduced coffee. */
const PRODUCTS: readonly ProductFixture[] = [
  { gross: 1211, id: 'n1-off-by-one', net: 1000, vatRate: 21 },
  { gross: 646, id: 'akros-10520900', net: 446, vatRate: 21 },
  { gross: 53_900, id: 'book-it', net: 49_000, vatRate: 10 },
  { gross: 28_900, id: 'kava', net: 25_804, vatRate: 12 },
];
const LINE_RATES = [21, 12, 10, 0] as const;
const SORTED_PRODUCTS = Arr.sort(
  PRODUCTS,
  Order.mapInput(Order.String, (product: ProductFixture) => product.id),
);
const classificationOf = (product: ProductFixture) => (product.vatRate === 21 ? 'cz.vat.standard' : 'cz.vat.reduced');

it.layer(nativeServices, { excludeTestServices: true })('tax classification migration', (suite) => {
  suite.effect(
    'stops on an unmapped product rate, then maps classifications without changing any price',
    () =>
      Effect.gen(function* taxClassificationMigration() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const client = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const db = yield* makeTestDatabaseFromClient(client, merchandiseRelations);

        // Every Merchandise migration before this one, as the deployed database has them.
        const fs = yield* FileSystem.FileSystem;
        const before = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-merchandise-before-tax-' });
        for (const name of yield* fs.readDirectory(migrations)) {
          if (name === TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
            continue;
          }
          yield* fs.makeDirectory(`${before}/${name}`);
          yield* fs.copyFile(`${migrations}/${name}/migration.sql`, `${before}/${name}/migration.sql`);
          yield* fs.copyFile(`${migrations}/${name}/snapshot.json`, `${before}/${name}/snapshot.json`);
        }
        yield* migrate(db, migrationOptions(before));

        const crypto = yield* Crypto.Crypto;
        const tenantId = yield* crypto.randomUUIDv4();
        const legalEntityId = yield* crypto.randomUUIDv4();
        yield* client.unsafe(
          'insert into demo_merchandise.catalog_heads (tenant_id, legal_entity_id) values ($1, $2)',
          [tenantId, legalEntityId],
        );
        const insertProduct = (product: ProductFixture) =>
          client.unsafe(
            `insert into demo_merchandise.products (
               tenant_id, legal_entity_id, id, active, archived, availability, category, created_at,
               current_price_minor, document, gross_price_minor, has_photo, is_action, is_new, is_recommended, is_sale,
               low_stock, name, name_key, published, search_text, sku, sku_key, stock_on_hand, stock_value_minor,
               updated_at
             ) values (
               $1, $2, $3, true, false, 'IN_STOCK', 'Katalog', now(), $4, $5::jsonb, $6, false, false, false, false,
               false, false, $3, $3, true, $3, $3, $3, 0, 0, now()
             )`,
            [
              tenantId,
              legalEntityId,
              product.id,
              product.net,
              JSON.stringify({ currentPriceMinor: product.net, name: product.id, vatRate: product.vatRate }),
              product.gross,
            ],
          );
        yield* Effect.forEach(PRODUCTS, insertProduct, { concurrency: 1, discard: true });
        const lines = LINE_RATES.map((vatRate, position) => ({
          productId: 'book-it',
          productName: 'BOOK-IT',
          quantity: position + 1,
          sku: 'BOOK-IT',
          unitPriceMinor: 53_900,
          vatRate,
        }));
        const insertOrder = (id: string, orderLines: readonly unknown[]) =>
          client.unsafe(
            `insert into demo_merchandise.orders (
               tenant_id, legal_entity_id, id, created_at, document, number, party_id, removed, search_text, status,
               total_minor, updated_at
             ) values ($1, $2, $3, now(), $4::jsonb, $3, 'party', false, $3, 'NEW', 107800, now())`,
            [tenantId, legalEntityId, id, JSON.stringify({ id, lines: orderLines, totalMinor: 107_800 })],
          );
        yield* insertOrder('OBJ-2026-0006', lines);
        yield* insertOrder('OBJ-2026-0007', []);

        // A product at 0 % has no classification: the deploy stops and nothing is changed.
        yield* insertProduct({ gross: 500, id: 'zero-rated', net: 500, vatRate: 0 });
        const refused = yield* migrate(db, migrationOptions(migrations)).pipe(Effect.flip);
        // PostgreSQL's reason names the product and its rate.
        const reason = Predicate.hasProperty(refused, 'cause') ? String(refused.cause) : String(refused);
        expect(reason).toContain('Products without a VAT classification mapping');
        expect(reason).toContain('zero-rated: 0');
        const untouched = yield* client.unsafe<{ readonly columnName: string }>(
          `select column_name as "columnName" from information_schema.columns
            where table_schema = 'demo_merchandise' and table_name = 'products'
              and column_name = 'tax_classification_code'`,
        );
        expect(untouched).toEqual([]);

        // Once the product is decided, the migration runs.
        yield* client.unsafe('delete from demo_merchandise.products where id = $1', ['zero-rated']);
        yield* migrate(db, migrationOptions(migrations));
        const migrated = yield* client.unsafe<{
          readonly classification: string;
          readonly document: unknown;
          readonly gross: number | null;
          readonly id: string;
          readonly net: number;
        }>(
          `select id, tax_classification_code as classification, document, current_price_minor::integer as net,
                  gross_price_minor::integer as gross
             from demo_merchandise.products where tenant_id = $1 order by id`,
          [tenantId],
        );
        const expected = SORTED_PRODUCTS.map((product) => ({
          classification: classificationOf(product),
          gross: product.gross,
          id: product.id,
          net: product.net,
        }));
        expect(migrated.map(({ document: _document, ...row }) => row)).toEqual(expected);
        expect(migrated.map((row) => row.document)).toEqual(
          SORTED_PRODUCTS.map((product) => ({
            currentPriceMinor: product.net,
            name: product.id,
            taxClassificationCode: classificationOf(product),
          })),
        );

        const orders = yield* client.unsafe<{
          readonly document: unknown;
          readonly id: string;
          readonly total: number;
        }>(
          'select id, document, total_minor::integer as total from demo_merchandise.orders where tenant_id = $1 order by id',
          [tenantId],
        );
        // History keeps its rates and amounts; only 21 and 12 gain a classification, 10 and 0 % stay without one.
        expect(orders.map((order) => order.total)).toEqual([107_800, 107_800]);
        expect(orders[0]?.document).toEqual({
          id: 'OBJ-2026-0006',
          lines: [
            { ...lines[0], taxClassificationCode: 'cz.vat.standard' },
            { ...lines[1], taxClassificationCode: 'cz.vat.reduced' },
            lines[2],
            lines[3],
          ],
          totalMinor: 107_800,
        });
        expect(orders[1]?.document).toEqual({ id: 'OBJ-2026-0007', lines: [], totalMinor: 107_800 });
        // The company starts from its stored rates, unconfirmed by Tax: 21 and 12 %, BOOK-IT held at its 10 %.
        const heads = yield* client.unsafe<{ readonly taxRates: unknown }>(
          `select tax_rates - 'syncedAt' as "taxRates" from demo_merchandise.catalog_heads where tenant_id = $1`,
          [tenantId],
        );
        expect(heads).toEqual([
          {
            taxRates: {
              book: {
                fingerprint: 'migration:cz.vat.standard=21;cz.vat.reduced=12',
                periods: [
                  { code: 'cz.vat.standard', effectiveFrom: '1970-01-01T00:00:00.000Z', ratePercent: '21' },
                  { code: 'cz.vat.reduced', effectiveFrom: '1970-01-01T00:00:00.000Z', ratePercent: '12' },
                ],
                regime: 'VAT_PAYER',
              },
              heldProductRates: { 'book-it': 10 },
              source: 'MIGRATION',
            },
          },
        ]);
        const stored = yield* client.unsafe<{ readonly taxRates: unknown }>(
          'select tax_rates as "taxRates" from demo_merchandise.catalog_heads where tenant_id = $1',
          [tenantId],
        );
        // It decodes as the state a sync writes.
        expect(Schema.decodeUnknownSync(CompanyTaxRatesSchema)(stored[0]?.taxRates).source).toBe('MIGRATION');
      }),
    180_000,
  );
});
