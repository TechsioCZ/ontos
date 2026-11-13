// The companies stage had when the tax-classification migration ran: one with a catalogue and a product stored at 10 %
// (held), one with a catalogue and no held product, and one without a catalogue row. That migration stored
// `"heldProductRates": null` for the second, which Merchandise refuses to decode, so its staff and storefront reads
// answered unavailable. The corrective migration removes the null key (and only it), advancing the head's revision;
// afterwards every company reads.
import { fileURLToPath } from 'node:url';

import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Crypto, Effect, FileSystem, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { RecordsViewSchema } from '../../shared/apis/records.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { staffProducts, storefrontProducts } from '../../src/services/merchandise-queries.ts';
import { currentPricingOf } from '../../src/services/merchandise-store.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const TAX_CLASSIFICATION = '20261112010127_tax-classification';
const HELD_NULL_REPAIR = '20261113130000_tax-rates-held-null';
const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const migrationOptions = (folder: string) => ({
  migrationsFolder: folder,
  migrationsSchema: 'drizzle',
  migrationsTable: '__drizzle_migrations_demo_merchandise',
});

interface HeadRow {
  readonly hasKey: boolean;
  readonly held: unknown;
  readonly revision: number;
}

it.layer(nativeServices, { excludeTestServices: true })(
  'held rates stored as null by the tax-classification migration',
  (suite) => {
    suite.effect('a company without held products reads again once the null key is removed', () =>
      Effect.gen(function* heldRatesNull() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const client = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const db = yield* makeTestDatabaseFromClient(client, merchandiseRelations);

        // The Merchandise migrations as a folder: every one before `upTo`, and `upTo` itself when `including`.
        const fs = yield* FileSystem.FileSystem;
        const folderUpTo = Effect.fn('HeldNull.folderUpTo')(function* folderUpTo(upTo: string, including: boolean) {
          const folder = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-merchandise-held-null-' });
          for (const name of yield* fs.readDirectory(migrations)) {
            if (
              !(yield* fs.exists(`${migrations}/${name}/migration.sql`)) ||
              name > upTo ||
              (name === upTo && !including)
            ) {
              continue;
            }
            yield* fs.makeDirectory(`${folder}/${name}`);
            yield* fs.copyFile(`${migrations}/${name}/migration.sql`, `${folder}/${name}/migration.sql`);
            yield* fs.copyFile(`${migrations}/${name}/snapshot.json`, `${folder}/${name}/snapshot.json`);
          }
          return folder;
        });
        yield* migrate(db, migrationOptions(yield* folderUpTo(TAX_CLASSIFICATION, false)));

        const crypto = yield* Crypto.Crypto;
        const tenantId = yield* crypto.randomUUIDv4();
        const held = { legalEntityId: yield* crypto.randomUUIDv4(), tenantId };
        const notHeld = { legalEntityId: yield* crypto.randomUUIDv4(), tenantId };
        const noCatalogue = { legalEntityId: yield* crypto.randomUUIDv4(), tenantId };
        const insertProduct = (company: typeof held, id: string, vatRate: number) =>
          client.unsafe(
            `insert into demo_merchandise.products (
             tenant_id, legal_entity_id, id, active, archived, availability, category, created_at,
             current_price_minor, document, gross_price_minor, has_photo, is_action, is_new, is_recommended, is_sale,
             low_stock, name, name_key, published, search_text, sku, sku_key, stock_on_hand, stock_value_minor,
             updated_at
           ) values (
             $1, $2, $3, true, false, 'IN_STOCK', 'Katalog', now(), 1000, $4::jsonb, null, false, false, false,
             false, false, false, $3, $3, true, $3, $3, $3, 0, 0, now()
           )`,
            [
              company.tenantId,
              company.legalEntityId,
              id,
              JSON.stringify({ currentPriceMinor: 1000, name: id, vatRate }),
            ],
          );
        for (const company of [held, notHeld]) {
          yield* client.unsafe(
            'insert into demo_merchandise.catalog_heads (tenant_id, legal_entity_id) values ($1, $2)',
            [company.tenantId, company.legalEntityId],
          );
        }
        yield* insertProduct(held, 'book-it', 10);
        yield* insertProduct(notHeld, 'screw', 21);

        const headOf = (company: typeof held) =>
          client
            .unsafe<HeadRow>(
              `select tax_rates -> 'heldProductRates' as held, tax_rates ? 'heldProductRates' as "hasKey", revision
               from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2`,
              [company.tenantId, company.legalEntityId],
            )
            .pipe(Effect.map(([row]) => row));
        const view = Schema.decodeUnknownSync(RecordsViewSchema)({ limit: 10, ordersLimit: 0 });
        const reads = (company: typeof held) =>
          Effect.all(
            [
              currentPricingOf(db, company),
              staffProducts(db, company, view, false),
              storefrontProducts(db, company, { query: { fields: 'card' } }),
            ],
            { concurrency: 1 },
          );

        // The tax-classification migration as stage ran it: the company without a held product gets a JSON null.
        yield* migrate(db, migrationOptions(yield* folderUpTo(TAX_CLASSIFICATION, true)));
        expect(yield* headOf(held)).toEqual({ hasKey: true, held: { 'book-it': 10 }, revision: 0 });
        expect(yield* headOf(notHeld)).toEqual({ hasKey: true, held: null, revision: 0 });
        expect(yield* headOf(noCatalogue)).toBeUndefined();
        // The reads below are about the company's stored VAT rates, not its product rows (the rows above carry only what the
        // migration reads): the products go, the heads stay as the migration wrote them.
        yield* client.unsafe('delete from demo_merchandise.products where tenant_id = $1', [tenantId]);
        const broken = yield* reads(notHeld).pipe(Effect.flip);
        expect(broken.reason).toContain('do not decode');
        const brokenStaff = yield* staffProducts(db, notHeld, view, false).pipe(Effect.flip);
        expect(brokenStaff.reason).toContain('do not decode');

        // The corrective migration: the null key goes and the revision advances; the held company stays as it was.
        yield* migrate(db, migrationOptions(yield* folderUpTo(HELD_NULL_REPAIR, true)));
        expect(yield* headOf(held)).toEqual({ hasKey: true, held: { 'book-it': 10 }, revision: 0 });
        expect(yield* headOf(notHeld)).toEqual({ hasKey: false, held: null, revision: 1 });
        const [heldPricing, heldStaff, heldStorefront] = yield* reads(held);
        expect(heldPricing.held).toEqual({ 'book-it': 10 });
        expect([heldStaff.products.length, heldStorefront.products.length]).toEqual([0, 0]);
        const [notHeldPricing, notHeldStaff, notHeldStorefront] = yield* reads(notHeld);
        expect(notHeldPricing.held).toEqual({});
        expect([notHeldStaff.products.length, notHeldStorefront.products.length]).toEqual([0, 0]);
        const [, noCatalogueStaff, noCatalogueStorefront] = yield* reads(noCatalogue);
        expect([noCatalogueStaff.products.length, noCatalogueStorefront.products.length]).toEqual([0, 0]);

        // Run again (a database already repaired, as stage after a manual repair): nothing changes.
        yield* client.unsafe('delete from drizzle.__drizzle_migrations_demo_merchandise where name = $1', [
          HELD_NULL_REPAIR,
        ]);
        yield* migrate(db, migrationOptions(yield* folderUpTo(HELD_NULL_REPAIR, true)));
        expect(yield* headOf(notHeld)).toEqual({ hasKey: false, held: null, revision: 1 });
      }).pipe(Effect.scoped),
    );
  },
);
