// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
// The expand step's triggers exist for the old release's writes: they classify what it writes and hold a product the old
// release prices at 10 % (`products_tax_classification`, `products_tax_hold`, `orders_tax_classification`). A write of
// this release must pass through them as a no-op. Each write this release can make (create, rename, price change,
// variant add / edit / remove, tier change, bulk change, market offer, storefront order, order edit and status change;
// an AI-approved change is one of those order operations, persisted the same way) runs on two identical companies:
// once as the deploy's runtime role with the triggers in force, once with them bypassed. The classification column,
// the migrated holds and every stored price come out identical, in a company still on the migrated rates (BOOK-IT held
// at 10 %, never moved by any write) and in one Tax has priced.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Crypto, DateTime, Effect, FileSystem, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema } from '../../shared/actions/apply-command.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { persistenceService } from '../../src/services/persistence.service.ts';
import type { PreparedTax } from '../../src/services/persistence.service.ts';
import { CompanyTaxRatesSchema } from '../../src/services/tax-rates.ts';
import type { FetchedTaxRates } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { TEST_TAX_BOOK } from '../support/tax-fixtures.ts';

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
const TABLES = [
  'catalog_heads',
  'categories',
  'products',
  'product_variants',
  'price_tiers',
  'stock_movements',
  'orders',
  'market_settings',
  'market_product_offers',
] as const;
const FixtureSchema = Schema.Struct({
  order: Schema.Struct({ command: Schema.Struct({ command: Schema.Record(Schema.String, Schema.Json) }) }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
});
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))(
  readFileSync(new URL('../fixtures/vat-transition-pre-migration.json', import.meta.url), 'utf-8'),
);
const MARKET_ID = '5f2d6c1e-7a3b-4c8d-9e0f-1a2b3c4d5e6f';
const NEW_PRODUCT_ID = '6a1f0d2e-3b4c-4d5e-8f60-718293a4b5c6';
const NOT_ASKED: PreparedTax = { fetched: Option.getOrUndefined(Option.none<FetchedTaxRates>()), refused: false };
const BOOK_IT_YEARLY = { attributes: 'Licence: roční', id: 'yearly', priceMinor: 30_000, sku: 'BOOK-IT-Y' };
const BOOK_IT_MONTHLY = { attributes: 'Licence: měsíční', id: 'monthly', name: 'Měsíční', sku: 'BOOK-IT-M' };

/**
 * Every write this release can make on its orders and catalogue, in order (the storefront order first, while its
 * expected prices still hold); `orderId` names the placed order.
 */
const writes = (orderId: () => string): readonly (() => Schema.Json)[] => [
  () => ({ ...fixture.order.command.command, clientRequestId: 'triggers-order' }),
  () => ({
    _tag: 'EditOrder',
    id: orderId(),
    lines: [
      { productId: 'p-reduced', quantity: 1 },
      { productId: 'p2', quantity: 2 },
    ],
    reason: 'Upraveno v novém vydání',
  }),
  () => ({ _tag: 'ChangeOrderStatus', id: orderId(), status: 'CONFIRMED' }),
  () => ({
    _tag: 'CreateProduct',
    active: true,
    category: 'Šrouby',
    lowStockThreshold: 0,
    name: 'Nový výrobek',
    priceMinor: 4000,
    sku: 'NEW-1',
    taxClassificationCode: 'cz.vat.reduced',
    unit: 'ks',
  }),
  () => ({ _tag: 'UpdateProduct', id: 'book-it', patch: { name: 'BOOK-IT přejmenováno' } }),
  () => ({ _tag: 'UpdateProduct', id: 'p-imported', patch: { name: 'Káva dovozová' } }),
  () => ({ _tag: 'ChangePrice', id: 'p-reduced', priceMinor: 30_000 }),
  () => ({
    _tag: 'UpdateProduct',
    id: 'book-it',
    patch: {
      variants: [
        { ...BOOK_IT_YEARLY, name: 'Roční' },
        { ...BOOK_IT_MONTHLY, priceMinor: 40_000 },
      ],
    },
  }),
  () => ({ _tag: 'ChangePrice', id: 'book-it', priceMinor: 41_000, variantId: 'monthly' }),
  () => ({
    _tag: 'UpdateProduct',
    id: 'book-it',
    patch: {
      variants: [
        { ...BOOK_IT_YEARLY, name: 'Roční licence' },
        { ...BOOK_IT_MONTHLY, priceMinor: 41_000 },
      ],
    },
  }),
  () => ({ _tag: 'UpdateProduct', id: 'book-it', patch: { variants: [{ ...BOOK_IT_YEARLY, name: 'Roční licence' }] } }),
  () => ({
    _tag: 'UpdateProduct',
    id: 'p-reduced',
    patch: {
      priceTiers: [
        { minimumQuantity: 1, priceExcludingVatMinor: 30_000, priceMinor: 33_600 },
        { minimumQuantity: 10, priceExcludingVatMinor: 27_000, priceMinor: 30_240 },
      ],
    },
  }),
  () => ({ _tag: 'BulkUpdateProducts', ids: ['book-it', 'p-reduced', 'p2'], patch: { priceChangePercent: 5 } }),
  () => ({ _tag: 'SetProductMarketOffer', marketId: MARKET_ID, offered: false, productId: 'p2' }),
];

type AdminClient = Effect.Success<ReturnType<typeof makeTestPgClient>>;
type RuntimeDb = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof merchandiseRelations>>>;
type Company = Effect.Success<ReturnType<typeof makeNativeReadTestContext>>['principal'];
const scopeOf = (company: Company) => [company.tenantId, company.legalEntityId ?? ''];

/** The expand step's triggers off (as their owner) for exactly one write, then on again. */
const triggerSwitch = (admin: AdminClient, state: 'DISABLE' | 'ENABLE') =>
  Effect.forEach(
    [
      ['products', 'products_tax_classification'],
      ['products', 'products_tax_hold'],
      ['orders', 'orders_tax_classification'],
    ] as const,
    ([table, trigger]) => admin.unsafe(`alter table demo_merchandise.${table} ${state} trigger ${trigger}`),
    { concurrency: 1, discard: true },
  );

/** One command through this release's write path, in a runtime-role transaction scoped to the company. */
const runCommand = (runtimeDb: RuntimeDb, scope: OperationalScope, command: Schema.Json, expectedRevision: number) => {
  const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({ command, expectedRevision });
  return runtimeDb.transaction((tx) =>
    installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        persistenceService(scoped, {
          prepared: { actionInvocationId: scope.correlationId, payload, tax: NOT_ASKED },
          scope,
        }),
      ),
      Effect.flatMap((services) => services.apply(payload.command, payload.expectedRevision, scope.correlationId)),
    ),
  );
};

/** One write as the deploy's runtime role; bypassed: with the expand step's triggers off. */
const apply = Effect.fn('TriggersNoOp.apply')(function* apply(
  database: { readonly admin: AdminClient; readonly runtimeDb: RuntimeDb },
  company: Company,
  bypassed: boolean,
  command: Schema.Json,
) {
  const [head] = yield* database.admin.unsafe<{ readonly revision: number }>(
    'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
    scopeOf(company),
  );
  // A created product gets the same id in every company, so the rows compare one to one.
  const correlationId = Predicate.isTagged(command, 'CreateProduct')
    ? NEW_PRODUCT_ID
    : yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
  const write = runCommand(database.runtimeDb, { ...company, correlationId }, command, head?.revision ?? 0);
  if (!bypassed) {
    return yield* write;
  }
  return yield* Effect.acquireUseRelease(
    triggerSwitch(database.admin, 'DISABLE'),
    () => write,
    () => Effect.orDie(triggerSwitch(database.admin, 'ENABLE')),
  );
});

/** What the triggers could change: classifications, holds and every stored price, by product and order. */
const storedOf = (admin: AdminClient, company: Company) =>
  Effect.all({
    heads: admin.unsafe(
      `select tax_rates -> 'source' as source, tax_rates -> 'heldProductRates' as held
         from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2`,
      scopeOf(company),
    ),
    orders: admin.unsafe(
      `select client_request_id as request, total_minor::text as total, document -> 'lines' as lines
         from demo_merchandise.orders where tenant_id = $1 and legal_entity_id = $2 order by number`,
      scopeOf(company),
    ),
    products: admin.unsafe(
      `select id, tax_classification_code as classification, current_price_minor::text as net,
              gross_price_minor::text as gross, document -> 'vatRate' as rate,
              document -> 'taxClassificationCode' as "documentClassification"
         from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2 order by id`,
      scopeOf(company),
    ),
    tiers: admin.unsafe(
      `select product_id, variant_position, position, price_minor::text as price,
              price_excluding_vat_minor::text as net
         from demo_merchandise.price_tiers where tenant_id = $1 and legal_entity_id = $2 order by 1, 2, 3`,
      scopeOf(company),
    ),
    variants: admin.unsafe(
      `select product_id, position, variant_id, price_minor::text as net, gross_price_minor::text as gross
         from demo_merchandise.product_variants where tenant_id = $1 and legal_entity_id = $2 order by 1, 2`,
      scopeOf(company),
    ),
  });

const heldOf = (admin: AdminClient, company: Company) =>
  admin
    .unsafe<{ readonly held: unknown }>(
      `select tax_rates -> 'heldProductRates' as held from demo_merchandise.catalog_heads
        where tenant_id = $1 and legal_entity_id = $2`,
      scopeOf(company),
    )
    .pipe(Effect.map(([row]) => row?.held));

/** The company's rows exactly as the old release wrote them (the transition fixture), plus an imported price. */
const insertOldReleaseRows = Effect.fn('TriggersNoOp.insertOldReleaseRows')(function* insertOldReleaseRows(
  admin: AdminClient,
  company: Company,
) {
  for (const table of TABLES) {
    yield* admin.unsafe(
      `insert into demo_merchandise.${table}
         select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
      [
        JSON.stringify(
          (fixture.rows[table] ?? []).map((row) => ({
            ...row,
            legal_entity_id: company.legalEntityId ?? '',
            tenant_id: company.tenantId,
          })),
        ),
      ],
    );
  }
  // An imported reduced price whose stored gross is a haléř below its 12 % recomputation (gross-entered), as the old
  // release stores such a product: 25 803 net, 28 898 gross, vatRate 12.
  yield* admin.unsafe(
    `insert into demo_merchandise.products
       select (jsonb_populate_record(p, jsonb_build_object(
         'id', 'p-imported', 'sku', 'KAVA-IMP', 'sku_key', 'kava-imp', 'slug', 'kava-dovozova',
         'ordinal', p.ordinal + 1000, 'current_price_minor', 25803, 'gross_price_minor', 28898,
         'document', p.document || jsonb_build_object('id', 'p-imported', 'sku', 'KAVA-IMP',
           'slug', 'kava-dovozova', 'currentPriceMinor', 25803, 'vatRate', 12)))).*
         from demo_merchandise.products p
        where p.tenant_id = $1 and p.legal_entity_id = $2 and p.id = 'p-reduced'`,
    scopeOf(company),
  );
});

/** The migrations before the expand step, in a scoped folder of their own. */
const migrationsBeforeExpand = Effect.gen(function* beforeExpand() {
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
  return before;
});

it.layer(nativeServices, { excludeTestServices: true })('the window triggers and this release', (suite) => {
  suite.effect(
    'every write of this release passes the window triggers unchanged, on migrated and on Tax-priced rates',
    () =>
      Effect.gen(function* triggersAreNoOps() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const adminDb = yield* makeTestDatabaseFromClient(admin, merchandiseRelations);
        yield* migrate(adminDb, migrationOptions(yield* migrationsBeforeExpand));
        // Four companies (each its own Tenant and person), all of the stage shape the old release wrote.
        const companyContext = makeNativeReadTestContext({
          accessDecision: makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } }).bound,
          connections: {
            admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
            runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
          },
          contextPermissions: [],
          moduleId: 'demo.merchandise',
          ownerFixtureRetention: 'retain-complete-context',
        }).pipe(
          Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration),
          Effect.map(({ principal }) => principal),
        );
        const [migrated, migratedBypassed, taxed, taxedBypassed] = yield* Effect.all(
          [companyContext, companyContext, companyContext, companyContext],
          { concurrency: 1 },
        );
        for (const company of [migrated, migratedBypassed, taxed, taxedBypassed]) {
          yield* insertOldReleaseRows(admin, company);
        }
        yield* migrate(adminDb, migrationOptions(migrations));
        const pricedByTax = Schema.encodeSync(CompanyTaxRatesSchema)({
          book: TEST_TAX_BOOK,
          source: 'TAX',
          syncedAt: yield* DateTime.now,
        });
        for (const company of [taxed, taxedBypassed]) {
          yield* admin.unsafe(
            'update demo_merchandise.catalog_heads set tax_rates = $3::jsonb where tenant_id = $1 and legal_entity_id = $2',
            [...scopeOf(company), JSON.stringify(pricedByTax)],
          );
        }
        const database = {
          admin,
          runtimeDb: yield* makeTestDatabaseFromClient(
            yield* makeTestPgClient(isolated.connections.runtime.connectionString, { maxConnections: 1 }),
            merchandiseRelations,
          ),
        };
        // Order ids are minted per company: the order commands name each company's own.
        const orderIds = new Map<Company, string>();
        const heldAtStart = yield* heldOf(admin, migrated);
        expect(heldAtStart).toEqual({ 'book-it': 10 });
        for (const [inForce, bypassed, regime] of [
          [migrated, migratedBypassed, 'migrated'],
          [taxed, taxedBypassed, 'Tax-priced'],
        ] as const) {
          for (const step of writes(() => '').keys()) {
            for (const [company, isBypassed] of [
              [inForce, false],
              [bypassed, true],
            ] as const) {
              const command = writes(() => orderIds.get(company) ?? '')[step]?.() ?? null;
              const result = yield* apply(database, company, isBypassed, command);
              const placed = Predicate.hasProperty(result, 'storefrontOrder') ? result.storefrontOrder : undefined;
              if (Predicate.hasProperty(placed, 'orderId')) {
                orderIds.set(company, String(placed.orderId));
              }
            }
            const label = `${regime} write ${String(step + 1)}`;
            expect([label, yield* storedOf(admin, inForce)]).toEqual([label, yield* storedOf(admin, bypassed)]);
            // No write of this release moves a hold.
            const held = yield* heldOf(admin, inForce);
            expect([label, regime === 'migrated' ? held : heldAtStart]).toEqual([label, heldAtStart]);
          }
        }
      }),
    240_000,
  );
});
