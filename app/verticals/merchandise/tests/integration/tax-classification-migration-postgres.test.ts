// The tax-classification migration on a database holding the catalog as stage holds it before the migration:
// products at 21, 12 and 10 % (BOOK-IT), stored gross prices that are not net plus VAT, order lines at 21, 12, 10 and
// 0 % and an order without lines. A product at any other rate stops the migration and leaves nothing changed; once it
// is decided the migration maps 21 to standard and 12/10 to reduced, gives history lines a classification only where
// it is unambiguous, and changes no stored price or amount.
import { fileURLToPath } from 'node:url';

import { PrincipalRefSchema } from '@app/core-runtime/permissions/principal-ref';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Array as Arr, Clock, Crypto, DateTime, Effect, FileSystem, Layer, Order, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandSchema } from '../../shared/actions/apply-command.ts';
import { grossUnitPriceMinor } from '../../shared/domain/merchandise-model.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { loadHead, loadWorkingSet, persistChange, replaceSnapshot } from '../../src/services/merchandise-store.ts';
import { evolveMerchandiseState, workingSetRequestOf } from '../../src/services/persistence.service.ts';
import { CompanyTaxRatesSchema } from '../../src/services/tax-rates.ts';
import { TEST_PRICING, TEST_RATES, TEST_TAX } from '../support/tax-fixtures.ts';
import { at, decodeState } from './support/merchandise-database.ts';

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
/** PostgreSQL's own message of a refused statement, two causes down from the SQL failure. */
const DatabaseRefusalSchema = Schema.Struct({
  cause: Schema.Struct({ cause: Schema.Struct({ message: Schema.String }) }),
});
const refusalMessage = Schema.decodeUnknownSync(DatabaseRefusalSchema);

const classificationOf = (product: ProductFixture) => (product.vatRate === 21 ? 'cz.vat.standard' : 'cz.vat.reduced');

/** One ChangePrice of `p1` the way persistence runs it: locked head, working set, pure evolve, delta write. */
const changePriceOnce = Effect.fn('TaxClassificationMigration.changePriceOnce')(function* changePriceOnce(
  tx: Parameters<typeof loadHead>[0],
  company: { readonly legalEntityId: string; readonly tenantId: string },
  actor: typeof PrincipalRefSchema.Type,
  priceMinor: number,
) {
  const command = Schema.decodeUnknownSync(MerchandiseCommandSchema)({ _tag: 'ChangePrice', id: 'p1', priceMinor });
  const head = yield* loadHead(tx, company, { lock: true });
  if (head === undefined || command._tag !== 'ChangePrice') {
    return yield* Effect.die('missing head');
  }
  const working = yield* loadWorkingSet(tx, company, head, workingSetRequestOf(command, 'p1'));
  const now = DateTime.makeUnsafe('2026-11-13T10:00:00.000Z');
  const change = yield* evolveMerchandiseState(working.state, command, { actor, now, resourceId: 'p1', tax: TEST_TAX });
  return yield* persistChange(tx, company, working, change.state, now, TEST_RATES, {});
});

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
          if (name >= TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
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
        // The document gains its classification and keeps its rate for the release still serving.
        expect(migrated.map((row) => row.document)).toEqual(
          SORTED_PRODUCTS.map((product) => ({
            currentPriceMinor: product.net,
            name: product.id,
            taxClassificationCode: classificationOf(product),
            vatRate: product.vatRate,
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

        // Until the new release publishes, the old one keeps serving and writes in its own shape. Each row it writes is
        // complete for the new release exactly as a migrated row is, and no stored amount moves.
        const heldOf = Effect.gen(function* heldProductRates() {
          const [head] = yield* client.unsafe<{ readonly held: unknown }>(
            `select tax_rates -> 'heldProductRates' as held from demo_merchandise.catalog_heads where tenant_id = $1`,
            [tenantId],
          );
          return head?.held;
        });
        const productRow = (id: string) =>
          client
            .unsafe<{
              readonly classification: string;
              readonly document: unknown;
              readonly gross: number | null;
              readonly net: number;
            }>(
              `select tax_classification_code as classification, document, current_price_minor::integer as net,
                      gross_price_minor::integer as gross
                 from demo_merchandise.products where tenant_id = $1 and id = $2`,
              [tenantId, id],
            )
            .pipe(Effect.map(([row]) => row));
        // A product it creates at 10 %: reduced in its column and document, and NOT held: holds come only from the data
        // as it stood before the deploy, so it sells at its stored gross with the reduced rate's split.
        yield* insertProduct({ gross: 33_000, id: 'old-release-book', net: 30_000, vatRate: 10 });
        expect(yield* productRow('old-release-book')).toEqual({
          classification: 'cz.vat.reduced',
          document: {
            currentPriceMinor: 30_000,
            name: 'old-release-book',
            taxClassificationCode: 'cz.vat.reduced',
            vatRate: 10,
          },
          gross: 33_000,
          net: 30_000,
        });
        expect(yield* heldOf).toEqual({ 'book-it': 10 });
        // Rewriting BOOK-IT at its 10 % keeps its hold.
        yield* client.unsafe(
          `update demo_merchandise.products set document = $3::jsonb where tenant_id = $1 and id = $2`,
          [tenantId, 'book-it', JSON.stringify({ currentPriceMinor: 49_000, name: 'book-it', vatRate: 10 })],
        );
        expect(yield* heldOf).toEqual({ 'book-it': 10 });
        // It rewrites BOOK-IT at 21 % with a document that names no classification: standard, and no longer held.
        yield* client.unsafe(
          `update demo_merchandise.products set document = $3::jsonb where tenant_id = $1 and id = $2`,
          [tenantId, 'book-it', JSON.stringify({ currentPriceMinor: 49_000, name: 'book-it', vatRate: 21 })],
        );
        expect(yield* productRow('book-it')).toEqual({
          classification: 'cz.vat.standard',
          document: {
            currentPriceMinor: 49_000,
            name: 'book-it',
            taxClassificationCode: 'cz.vat.standard',
            vatRate: 21,
          },
          gross: 53_900,
          net: 49_000,
        });
        // Its company's last hold: the key goes (absent, never null and never an empty map).
        expect(yield* heldOf).toBeNull();
        // Written at 10 % again: reduced, and its hold does not come back.
        yield* client.unsafe(
          `update demo_merchandise.products set document = $3::jsonb where tenant_id = $1 and id = $2`,
          [tenantId, 'book-it', JSON.stringify({ currentPriceMinor: 49_000, name: 'book-it', vatRate: 10 })],
        );
        expect([(yield* productRow('book-it'))?.classification, yield* heldOf]).toEqual(['cz.vat.reduced', null]);
        // A rate nothing maps is refused by name, never stored without a classification.
        const zero = yield* insertProduct({ gross: 500, id: 'old-release-zero', net: 500, vatRate: 0 }).pipe(
          Effect.flip,
        );
        expect(refusalMessage(zero).cause.cause.message).toContain(
          'old-release-zero has VAT rate 0 %, which names no VAT classification',
        );
        // It rewrites the order with lines that name no classification (and adds one): classified as migrated.
        yield* client.unsafe(
          `update demo_merchandise.orders set document = $3::jsonb where tenant_id = $1 and id = $2`,
          [
            tenantId,
            'OBJ-2026-0006',
            JSON.stringify({
              id: 'OBJ-2026-0006',
              lines: [...lines, { ...lines[0], quantity: 9 }],
              totalMinor: 107_800,
            }),
          ],
        );
        const [rewritten] = yield* client.unsafe<{ readonly document: unknown; readonly total: number }>(
          `select document, total_minor::integer as total from demo_merchandise.orders where tenant_id = $1 and id = $2`,
          [tenantId, 'OBJ-2026-0006'],
        );
        expect(rewritten).toEqual({
          document: {
            id: 'OBJ-2026-0006',
            lines: [
              { ...lines[0], taxClassificationCode: 'cz.vat.standard' },
              { ...lines[1], taxClassificationCode: 'cz.vat.reduced' },
              lines[2],
              lines[3],
              { ...lines[0], quantity: 9, taxClassificationCode: 'cz.vat.standard' },
            ],
            totalMinor: 107_800,
          },
          total: 107_800,
        });
        // A row the new release writes (no rate in the document, its own classification) is left exactly as written.
        yield* client.unsafe(
          `update demo_merchandise.products set document = $3::jsonb, tax_classification_code = 'cz.vat.reduced'
            where tenant_id = $1 and id = $2`,
          [
            tenantId,
            'kava',
            JSON.stringify({ currentPriceMinor: 25_804, name: 'kava', taxClassificationCode: 'cz.vat.reduced' }),
          ],
        );
        expect((yield* productRow('kava'))?.document).toEqual({
          currentPriceMinor: 25_804,
          name: 'kava',
          taxClassificationCode: 'cz.vat.reduced',
        });
      }),
    180_000,
  );

  suite.effect(
    'fills a held price without gross at its held rate, reads a rate however JSON spells it, pins every search path',
    () =>
      Effect.gen(function* deployDetails() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const client = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const db = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
        const fs = yield* FileSystem.FileSystem;
        const before = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-merchandise-before-tax-' });
        for (const name of yield* fs.readDirectory(migrations)) {
          if (name >= TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
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
        const insertProduct = (id: string, net: number, vatRate: number | string) =>
          client.unsafe(
            `insert into demo_merchandise.products (
               tenant_id, legal_entity_id, id, active, archived, availability, category, created_at,
               current_price_minor, document, gross_price_minor, has_photo, is_action, is_new, is_recommended, is_sale,
               low_stock, name, name_key, published, search_text, sku, sku_key, stock_on_hand, stock_value_minor,
               updated_at
             ) values (
               $1, $2, $3, true, false, 'IN_STOCK', 'Katalog', now(), $4, $5::jsonb, null, false, false, false, false,
               false, false, $3, $3, true, $3, $3, $3, 0, 0, now()
             )`,
            [tenantId, legalEntityId, id, net, JSON.stringify({ currentPriceMinor: net, name: id, vatRate })],
          );
        const insertVariant = (productId: string, variantId: string, net: number, active: boolean, position: number) =>
          client.unsafe(
            `insert into demo_merchandise.product_variants (
               tenant_id, legal_entity_id, product_id, variant_id, active, document, name, position, price_minor,
               stock_on_hand, unit
             ) values ($1, $2, $3, $4, $5, $6::jsonb, $4, $8, $7, 0, 'ks')`,
            [tenantId, legalEntityId, productId, variantId, active, JSON.stringify({ id: variantId }), net, position],
          );
        // Held products (stored at 10 %) with no gross anywhere, one plain and one with variants; an order the old
        // release stored without any `lines` key.
        yield* insertProduct('held-plain', 30_000, 10);
        yield* insertProduct('held-variants', 1000, 10);
        yield* insertVariant('held-variants', 'yearly', 1000, true, 0);
        yield* insertVariant('held-variants', 'monthly', 90, false, 1);
        yield* client.unsafe(
          `insert into demo_merchandise.orders (
             tenant_id, legal_entity_id, id, created_at, document, number, party_id, removed, search_text, status,
             total_minor, updated_at
           ) values ($1, $2, 'no-lines', now(), '{"id": "no-lines", "totalMinor": 0}'::jsonb, 'no-lines', 'party',
             false, 'no-lines', 'NEW', 0, now())`,
          [tenantId, legalEntityId],
        );
        yield* migrate(db, migrationOptions(migrations));

        // Held prices got their gross at 10 %, rounded as `grossUnitPriceMinor`; the product with variants their lowest
        // active one.
        const grosses = yield* client.unsafe<{ readonly gross: number | null; readonly id: string }>(
          `select id, gross_price_minor::integer as gross from demo_merchandise.products where tenant_id = $1
           union all
           select product_id || '/' || variant_id, gross_price_minor::integer from demo_merchandise.product_variants
            where tenant_id = $1 order by 1`,
          [tenantId],
        );
        expect(grosses).toEqual([
          { gross: grossUnitPriceMinor(30_000, 10), id: 'held-plain' },
          { gross: grossUnitPriceMinor(1000, 10), id: 'held-variants' },
          { gross: grossUnitPriceMinor(90, 10), id: 'held-variants/monthly' },
          { gross: grossUnitPriceMinor(1000, 10), id: 'held-variants/yearly' },
        ]);
        // An order stored without `lines` stays exactly as stored, at deploy and when the old release rewrites it.
        const orderDocument = client
          .unsafe<{ readonly document: unknown }>(
            `select document from demo_merchandise.orders where tenant_id = $1 and id = 'no-lines'`,
            [tenantId],
          )
          .pipe(Effect.map(([row]) => row?.document));
        expect(yield* orderDocument).toEqual({ id: 'no-lines', totalMinor: 0 });
        yield* client.unsafe(
          `update demo_merchandise.orders set document = '{"id": "no-lines", "totalMinor": 1}'::jsonb
            where tenant_id = $1 and id = 'no-lines'`,
          [tenantId],
        );
        expect(yield* orderDocument).toEqual({ id: 'no-lines', totalMinor: 1 });

        // The old release's rate maps however its JSON spells it; a rate nothing maps is refused naming product and rate.
        yield* insertProduct('spelled-decimal', 100, 21);
        yield* client.unsafe(
          `update demo_merchandise.products set document = document || '{"vatRate": 21.0}'::jsonb
            where tenant_id = $1 and id = 'spelled-decimal'`,
          [tenantId],
        );
        yield* insertProduct('spelled-string', 100, '12');
        const classified = yield* client.unsafe<{ readonly classification: string; readonly id: string }>(
          `select id, tax_classification_code as classification from demo_merchandise.products
            where tenant_id = $1 and id like 'spelled-%' order by id`,
          [tenantId],
        );
        expect(classified).toEqual([
          { classification: 'cz.vat.standard', id: 'spelled-decimal' },
          { classification: 'cz.vat.reduced', id: 'spelled-string' },
        ]);
        const unsupported = yield* insertProduct('half-rate', 100, 21.5).pipe(Effect.flip);
        expect(refusalMessage(unsupported).cause.cause.message).toContain(
          'half-rate has VAT rate 21.5 %, which names no VAT classification',
        );

        // Every function the deploy adds runs with a fixed search path.
        const unpinned = yield* client.unsafe<{ readonly name: string }>(
          `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'demo_merchandise'
              and not coalesce(p.proconfig @> array['search_path=pg_catalog, pg_temp'], false)
            order by 1`,
        );
        expect(unpinned).toEqual([]);
      }),
    180_000,
  );

  suite.effect(
    'fails fast, changing nothing, while a transaction of the release still serving holds products',
    () =>
      Effect.gen(function* lockTimeout() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const client = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const db = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
        const fs = yield* FileSystem.FileSystem;
        const before = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-merchandise-before-tax-' });
        for (const name of yield* fs.readDirectory(migrations)) {
          if (name >= TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
            continue;
          }
          yield* fs.makeDirectory(`${before}/${name}`);
          yield* fs.copyFile(`${migrations}/${name}/migration.sql`, `${before}/${name}/migration.sql`);
          yield* fs.copyFile(`${migrations}/${name}/snapshot.json`, `${before}/${name}/snapshot.json`);
        }
        yield* migrate(db, migrationOptions(before));
        // The old release in the middle of a long write: its transaction holds products as any write does.
        const oldRelease = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        yield* oldRelease.unsafe('begin');
        yield* oldRelease.unsafe('lock table demo_merchandise.products in row exclusive mode');
        const started = yield* Clock.currentTimeMillis;
        const failed = yield* migrate(db, migrationOptions(migrations)).pipe(Effect.flip);
        const waited = (yield* Clock.currentTimeMillis) - started;
        yield* oldRelease.unsafe('rollback');
        // It gave up after its 5 s lock timeout with PostgreSQL's own reason, never queueing behind the old release.
        const reason = Predicate.hasProperty(failed, 'cause') ? String(failed.cause) : String(failed);
        expect(reason).toContain('canceling statement due to lock timeout');
        expect(waited).toBeGreaterThanOrEqual(4500);
        expect(waited).toBeLessThan(15_000);
        // Nothing of it was applied: no classification column, no function, no journal entry.
        const applied = yield* client.unsafe<{
          readonly column: boolean;
          readonly fn: boolean;
          readonly journal: boolean;
        }>(
          `select exists(select 1 from information_schema.columns where table_schema = 'demo_merchandise'
                          and table_name = 'products' and column_name = 'tax_classification_code') as column,
                  exists(select 1 from pg_proc where proname = 'product_tax_classification') as fn,
                  exists(select 1 from drizzle.__drizzle_migrations_demo_merchandise
                          where name = '${TAX_CLASSIFICATION}') as journal`,
        );
        expect(applied).toEqual([{ column: false, fn: false, journal: false }]);
        // The next deploy runs it again and it applies.
        yield* migrate(db, migrationOptions(migrations));
      }),
    180_000,
  );

  suite.effect(
    'records which release serves: its composition revision, on its first catalogue write; a later release replaces it',
    () =>
      Effect.gen(function* servedMarker() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const client = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const db = yield* makeTestDatabaseFromClient(client, merchandiseRelations);
        yield* migrate(db, migrationOptions(migrations));
        const marker = client.unsafe<{ readonly revision: string }>(
          'select composition_revision as revision from demo_merchandise.tax_classification_live',
        );
        // The deploy itself (migration, backfill) and the release still serving record nothing.
        expect(yield* marker).toEqual([]);
        /** The composition the app host published: the one its fence admits this release's writes under. */
        const serving = (revision: string) =>
          client.unsafe(
            `insert into core.application_composition_authority
               (authority_key, revision, phase, valid_until, subscriptions_json)
             values ('active', $1, 'active', now() + interval '1 hour', '[]'::jsonb)
             on conflict (authority_key) do update set revision = excluded.revision`,
            [revision],
          );
        const crypto = yield* Crypto.Crypto;
        const company = { legalEntityId: yield* crypto.randomUUIDv4(), tenantId: yield* crypto.randomUUIDv4() };
        const actor = Schema.decodeUnknownSync(PrincipalRefSchema)({
          principalId: yield* crypto.randomUUIDv4(),
          tenantId: company.tenantId,
        });
        const product = {
          active: true,
          category: 'Katalog',
          createdAt: at,
          currentPriceMinor: 1000,
          id: 'p1',
          lowStockThreshold: 0,
          name: 'Šroub',
          priceHistory: [],
          sku: 'P1',
          taxClassificationCode: 'cz.vat.standard',
          unit: 'ks',
          updatedAt: at,
        };
        const state = decodeState({ categories: [], movements: [], orders: [], products: [product] });
        const base = yield* db.transaction((tx) => replaceSnapshot(tx, company, state, TEST_PRICING));
        const write = (priceMinor: number) => db.transaction((tx) => changePriceOnce(tx, company, actor, priceMinor));
        // The first write of the release serving composition `a…` records it.
        const releaseA = 'a'.repeat(64);
        yield* serving(releaseA);
        expect(yield* write(1100)).toBe(base + 1);
        expect(yield* marker).toEqual([{ revision: releaseA }]);
        // A later release with the classification (composition `b…`) replaces it on its own first write.
        const releaseB = 'b'.repeat(64);
        yield* serving(releaseB);
        expect(yield* write(1200)).toBe(base + 2);
        expect(yield* marker).toEqual([{ revision: releaseB }]);
        // When recording fails the product write still succeeds: the marker is never a reason to refuse a write.
        yield* serving('c'.repeat(64));
        yield* client.unsafe('alter table demo_merchandise.tax_classification_live rename to tax_classification_gone');
        expect(yield* write(1250)).toBe(base + 3);
        yield* client.unsafe('alter table demo_merchandise.tax_classification_gone rename to tax_classification_live');
        expect(yield* marker).toEqual([{ revision: releaseB }]);
        yield* serving(releaseB);
        // Once the row names this release, its process stops offering it: the row stays as it is.
        expect(yield* write(1300)).toBe(base + 4);
        expect(yield* write(1400)).toBe(base + 5);
        expect(yield* marker).toEqual([{ revision: releaseB }]);
        // The shared runtime role reads the row and nothing else: only the function writes it.
        const runtime = yield* makeTestPgClient(isolated.connections.runtime.connectionString, { maxConnections: 1 });
        expect(
          yield* runtime.unsafe(
            'select composition_revision as revision from demo_merchandise.tax_classification_live',
          ),
        ).toEqual([{ revision: releaseB }]);
        for (const statement of [
          `insert into demo_merchandise.tax_classification_live (composition_revision) values ('forged')`,
          `update demo_merchandise.tax_classification_live set composition_revision = 'forged'`,
          'delete from demo_merchandise.tax_classification_live',
          'truncate demo_merchandise.tax_classification_live',
        ]) {
          const refused = yield* runtime.unsafe(statement).pipe(Effect.flip);
          expect([statement, String(Predicate.hasProperty(refused, 'cause') ? refused.cause : refused)]).toEqual([
            statement,
            expect.stringContaining('AuthorizationError'),
          ]);
        }
        expect(yield* marker).toEqual([{ revision: releaseB }]);
      }),
    180_000,
  );
});
