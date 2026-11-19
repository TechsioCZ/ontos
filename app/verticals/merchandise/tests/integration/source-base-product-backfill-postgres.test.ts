// Stage stores the AKROS import as it was before `sourceBaseProduct` existed: no product carries the key, so the
// AKROS and SroubShop listings show the orphan source variants the import marks. The data migration
// 20261119120000_orphan-source-products marks them in every company holding the import (here the real company and a
// playground copy of another tenant) and never overwrites a stored value.
import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { StorefrontCatalogQuerySchema } from '../../shared/apis/records.ts';
import { buildAkrosEncoded } from '../../scripts/akros-catalog.mts';
import { products } from '../../src/database/schema.ts';
import { storefrontProducts } from '../../src/services/merchandise-queries.ts';
import { whereScope } from '../../src/services/merchandise-store.ts';
import type { MerchandiseFixture } from './support/merchandise-database.ts';
import { decodeState, withMerchandise } from './support/merchandise-database.ts';

const migration = readFileSync(
  new URL('../../drizzle/20261119120000_orphan-source-products/migration.sql', import.meta.url),
  'utf-8',
);

/** The migration as the migrator runs it: its statements in order, in one transaction. */
const runMigration = (fixture: MerchandiseFixture) =>
  fixture.db.transaction((transaction) =>
    Effect.forEach(
      migration.split('--> statement-breakpoint'),
      (statement) => transaction.execute(sql.raw(statement)),
      { discard: true },
    ),
  );

const decodeQuery = Schema.decodeUnknownSync(StorefrontCatalogQuerySchema);
const listedIds = (fixture: MerchandiseFixture, query: typeof StorefrontCatalogQuerySchema.Encoded) =>
  storefrontProducts(fixture.db, fixture.scope, {
    query: decodeQuery({ fields: 'card', pageSize: 250, ...query }),
  }).pipe(Effect.map((page) => page.products.map((product) => product.id)));
const maticeIds = (fixture: MerchandiseFixture, storefrontAppId: string) =>
  listedIds(fixture, { categorySlug: 'matice', storefrontAppId });

/** How many stored product documents say orphan (`false`) and main (`true`). */
const marksOf = (fixture: MerchandiseFixture) =>
  fixture.db
    .select({
      main: sql<number>`(count(*) filter (where ${products.document} -> 'sourceBaseProduct' = 'true'::jsonb))::int`,
      orphan: sql<number>`(count(*) filter (where ${products.document} -> 'sourceBaseProduct' = 'false'::jsonb))::int`,
    })
    .from(products)
    .where(whereScope(products, fixture.scope))
    .pipe(Effect.map(([row]) => row));

it.live('the backfill marks the orphan source variants of every stored AKROS import exactly once', () =>
  Effect.gen(function* orphanSourceBackfill() {
    const encoded = yield* buildAkrosEncoded();
    const orphanIds = encoded.products
      .filter((product) => product.sourceBaseProduct === false)
      .map((product) => product.id);
    // The migration lists the source groups itself; they are exactly the import's orphans.
    const groups = /ARRAY\[(?<groups>[^\]]*)\]/u.exec(migration)?.groups?.groups ?? '';
    const listed = [...groups.matchAll(/'(?<group>\d+)'/gu)].map((match) => `product-${match.groups?.group}`);
    expect([orphanIds.length, listed.length]).toEqual([232, 232]);
    expect(new Set(listed)).toEqual(new Set(orphanIds));

    const stripped = encoded.products.map(({ sourceBaseProduct: _mark, ...product }) => product);
    const stage = decodeState({ ...encoded, products: stripped });
    // A copy of another tenant: one orphan already stored as a main product (a person's choice) and one unmarked.
    const [chosen] = orphanIds;
    const copy = decodeState({
      ...encoded,
      homepageFeaturedProductIds: [],
      products: stripped
        .filter((product) => product.id === chosen || product.id === 'product-31935')
        .map((product) => (product.id === chosen ? { ...product, sourceBaseProduct: true } : product)),
    });
    yield* withMerchandise(stage, (akros) =>
      withMerchandise(copy, (playground) =>
        Effect.gen(function* migrateStage() {
          expect(yield* maticeIds(akros, 'akros-storefront')).toHaveLength(101);
          expect(yield* marksOf(akros)).toEqual({ main: 0, orphan: 0 });

          yield* runMigration(akros);
          expect(yield* marksOf(akros)).toEqual({ main: 0, orphan: 232 });
          expect(yield* marksOf(playground)).toEqual({ main: 1, orphan: 1 });
          const akrosNuts = yield* maticeIds(akros, 'akros-storefront');
          expect(akrosNuts).toHaveLength(84);
          expect(akrosNuts).not.toContain('product-31935');
          expect(yield* maticeIds(akros, 'sroubshop-storefront')).toHaveLength(84);
          expect(yield* maticeIds(akros, 'n1-storefront')).toHaveLength(101);
          expect(
            yield* listedIds(akros, { productIds: ['product-31935'], storefrontAppId: 'akros-storefront' }),
          ).toEqual(['product-31935']);

          // A second run finds nothing to mark.
          yield* runMigration(akros);
          expect([yield* marksOf(akros), yield* marksOf(playground)]).toEqual([
            { main: 0, orphan: 232 },
            { main: 1, orphan: 1 },
          ]);
        }),
      ),
    );
  }),
);
