// The deploy of VAT classifications on a live storefront, end to end on PostgreSQL. The fixture was written by the code
// before classifications (stage-shaped: 21/12/10 %, stored gross not net × rate, tiers, variants, a EUR market): its raw
// rows, the storefront `records` responses before and after one storefront order, and that order.
//
// 1. The migration runs on those rows with Tax not installed. Storefront reads answer byte for byte what they answered
//    before, without asking Tax, and the same storefront order is placed with the same lines and totals.
// 2. Tax gets installed and seeded; staff reads sync the company by themselves (the first one starts the refresh in
//    the background, the next one materialises it). Storefront reads still answer the same bytes, except that BOOK-IT
//    (stored at 10 %, now reduced) shows 12 %; no price changes.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { DateTime, Effect, FileSystem, Layer, Predicate, Redacted, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { MerchandiseCommandPayloadSchema, StorefrontOrderResultSchema } from '../../shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';
import { TaxRuleRevisionIdSchema } from '../../shared/domain/merchandise-model.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { merchandiseRelations } from '../../src/database/schema.ts';
import { persistenceService, prepareCommandTax } from '../../src/services/persistence.service.ts';
import { CompanyTaxRatesSchema, TaxRateSource, TaxRatesFailure } from '../../src/services/tax-rates.ts';
import type { TaxRateBook } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';

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

const FixtureSchema = Schema.Struct({
  after: Schema.Record(Schema.String, Schema.Json),
  before: Schema.Record(Schema.String, Schema.Json),
  order: Schema.Struct({
    command: Schema.Json,
    document: Schema.Struct({
      lines: Schema.Array(
        Schema.Struct({
          quantity: Schema.Number,
          sku: Schema.String,
          unitPriceMinor: Schema.Number,
          vatRate: Schema.Number,
        }),
      ),
      shipping: Schema.Json,
      totalMinor: Schema.Number,
      totalVatMinor: Schema.Number,
    }),
    storefrontOrder: Schema.Json,
  }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
});
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))(
  readFileSync(new URL('../fixtures/vat-transition-pre-migration.json', import.meta.url), 'utf-8'),
);
/** Insert order: no foreign keys, but heads first, as the store writes them. */
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
const MARKET_ID = '5f2d6c1e-7a3b-4c8d-9e0f-1a2b3c4d5e6f';
const views = {
  cards: { view: { storefront: true, storefrontCatalog: { fields: 'card' } } },
  cart: {
    view: { storefront: true, storefrontCatalog: { fields: 'full', productIds: ['book-it', 'p-reduced', 'p2'] } },
  },
  category: { view: { storefront: true, storefrontCatalog: { categorySlug: 'metricke', fields: 'card' } } },
  detailBookIt: { view: { storefront: true, storefrontCatalog: { fields: 'full', slug: 'book-it' } } },
  detailOddVariant: { view: { storefront: true, storefrontCatalog: { fields: 'full', slug: 'odd-variant' } } },
  detailReduced: { view: { storefront: true, storefrontCatalog: { fields: 'full', slug: 'kava-zrnkova' } } },
  featured: { view: { storefront: true, storefrontCatalog: { featured: true, fields: 'card' } } },
  legacyList: { view: { limit: 250, storefront: true, summary: true } },
  marketCards: { view: { storefront: true, storefrontCatalog: { fields: 'card', marketId: MARKET_ID } } },
  marketDetail: {
    view: { storefront: true, storefrontCatalog: { fields: 'full', marketId: MARKET_ID, slug: 'book-it' } },
  },
  priceAscending: { view: { storefront: true, storefrontCatalog: { fields: 'card', sort: 'price-asc' } } },
  priceBounds: { view: { storefront: true, storefrontCatalog: { fields: 'card', maxMinor: 60_000, minMinor: 100 } } },
  search: { view: { storefront: true, storefrontCatalog: { fields: 'card', q: 'sroub' } } },
} satisfies Readonly<Record<string, RecordsRequestEncoded>>;

/** Tax's Czech baseline for the company: a payer from 1 January 2024 (Prague), standard 21 %, reduced 12 %. */
const PRAGUE_2024 = DateTime.makeUnsafe('2023-12-31T23:00:00.000Z');
const BASELINE: TaxRateBook = {
  fingerprint: 'tax:baseline-2024',
  periods: [
    {
      code: 'cz.vat.standard',
      effectiveFrom: PRAGUE_2024,
      ratePercent: '21',
      taxRuleRevisionId: TaxRuleRevisionIdSchema.make('rule-revision-standard-21'),
    },
    {
      code: 'cz.vat.reduced',
      effectiveFrom: PRAGUE_2024,
      ratePercent: '12',
      taxRuleRevisionId: TaxRuleRevisionIdSchema.make('rule-revision-reduced-12'),
    },
  ],
  regime: 'VAT_PAYER',
};
const refused = () => Effect.fail(new TaxRatesFailure({ kind: 'REFUSED' }));

/** A response with BOOK-IT at the rate Tax gives the reduced classification; every price stays as it was. */
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
const withBookItAt = (value: Schema.Json, vatRate: number): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map((item: Schema.Json) => withBookItAt(item, vatRate));
  }
  if (!Schema.is(JsonRecordSchema)(value)) {
    return value;
  }
  const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withBookItAt(item, vatRate)]));
  return mapped.id === 'book-it' && 'vatRate' in mapped ? { ...mapped, vatRate } : mapped;
};

const encodeResponse = Schema.encodeSync(RecordsResponseSchema);
/** The encoded response without the per-run identities (the actor and the catalog revision). */
const comparable = (response: typeof RecordsResponseSchema.Type) => {
  const { actorPrincipalRef: _actor, revision: _revision, ...rest } = encodeResponse(response);
  void _actor;
  void _revision;
  return rest;
};

type RuntimeDb = Effect.Success<ReturnType<typeof makeTestDatabaseFromClient<typeof merchandiseRelations>>>;
type TaxSource = Effect.Success<typeof TaxRateSource>;

/** The fixture's storefront order (a fresh client request id), placed through Merchandise's own preparation and write. */
const placeOrder = Effect.fn('VatTransition.placeOrder')(function* placeOrder(
  input: {
    readonly db: RuntimeDb;
    readonly principal: Effect.Success<ReturnType<typeof makeNativeReadTestContext>>['principal'];
    readonly source: TaxSource;
  },
  clientRequestId: string,
  expectedRevision: number,
) {
  const { command } = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.Record(Schema.String, Schema.Json) }))(
    fixture.order.command,
  );
  const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
    command: { ...command, clientRequestId },
    expectedRevision,
  });
  const scope = { ...input.principal, correlationId: `vat-transition-${clientRequestId}` };
  const tax = yield* prepareCommandTax(payload.command, scope).pipe(Effect.provideService(TaxRateSource, input.source));
  const result = yield* input.db.transaction((tx) =>
    installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        persistenceService(scoped, { prepared: { actionInvocationId: scope.correlationId, payload, tax }, scope }),
      ),
      Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
    ),
  );
  const order = Predicate.hasProperty(result, 'storefrontOrder') ? result.storefrontOrder : undefined;
  return Schema.encodeSync(Schema.UndefinedOr(StorefrontOrderResultSchema))(
    Schema.decodeUnknownSync(Schema.UndefinedOr(StorefrontOrderResultSchema))(order),
  );
});

it.layer(nativeServices, { excludeTestServices: true })('VAT classification deploy on a live storefront', (suite) => {
  suite.effect(
    'storefront reads and orders stay exactly as before through the migration and the first sync with Tax',
    () =>
      Effect.gen(function* vatTransition() {
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          mode: 'empty',
          purpose: 'merchandise-tax-classification',
        });
        yield* isolated.migrateCoreSchema();
        const admin = yield* makeTestPgClient(isolated.connections.admin.connectionString, { maxConnections: 1 });
        const adminDb = yield* makeTestDatabaseFromClient(admin, merchandiseRelations);
        const fs = yield* FileSystem.FileSystem;
        const before = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-merchandise-vat-transition-' });
        for (const name of yield* fs.readDirectory(migrations)) {
          if (name === TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
            continue;
          }
          yield* fs.makeDirectory(`${before}/${name}`);
          yield* fs.copyFile(`${migrations}/${name}/migration.sql`, `${before}/${name}/migration.sql`);
          yield* fs.copyFile(`${migrations}/${name}/snapshot.json`, `${before}/${name}/snapshot.json`);
        }
        yield* migrate(adminDb, migrationOptions(before));

        const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
        const native = yield* makeNativeReadTestContext({
          accessDecision: gate.bound,
          connections: {
            admin: { connectionString: Redacted.make(isolated.connections.admin.connectionString) },
            runtime: { connectionString: Redacted.make(isolated.connections.runtime.connectionString) },
          },
          contextPermissions: [],
          moduleId: 'demo.merchandise',
          ownerFixtureRetention: 'retain-complete-context',
        }).pipe(Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration));
        const company = { legalEntityId: native.principal.legalEntityId ?? '', tenantId: native.principal.tenantId };
        // The company's rows exactly as the code before classifications stored them, moved to this company.
        yield* Effect.forEach(
          TABLES,
          (table) =>
            admin.unsafe(
              `insert into demo_merchandise.${table}
                 select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
              [
                JSON.stringify(
                  (fixture.rows[table] ?? []).map((row) => ({
                    ...row,
                    legal_entity_id: company.legalEntityId,
                    tenant_id: company.tenantId,
                  })),
                ),
              ],
            ),
          { concurrency: 1, discard: true },
        );
        yield* migrate(adminDb, migrationOptions(migrations));

        // Every call to Tax is counted; Tax is not installed for the tenant yet.
        const taxCalls = yield* Ref.make(0);
        const taxSource = yield* Ref.make<() => Effect.Effect<TaxRateBook, TaxRatesFailure>>(refused);
        const source = {
          read: () =>
            Ref.update(taxCalls, (calls) => calls + 1).pipe(
              Effect.andThen(Ref.get(taxSource)),
              Effect.flatMap((read) => read()),
            ),
        };
        const read = (input: RecordsRequestEncoded) =>
          native.runtime
            .runRead({
              input,
              principal: native.principal,
              registration: recordsRead,
              transport: { correlationId: 'vat-transition' },
            })
            .pipe(
              Effect.provide(native.layer),
              Effect.provideService(AccessDecisionGate, gate.accessDecision),
              Effect.provideService(TaxRateSource, source),
            );
        const storefront = Effect.forEach(
          Object.entries(views),
          ([name, view]) => read(view).pipe(Effect.map((response) => [name, comparable(response)] as const)),
          { concurrency: 1 },
        ).pipe(Effect.map(Object.fromEntries));

        // 1. Right after the migration, Tax not installed: the same bytes as before, and no call to Tax.
        expect(yield* storefront).toEqual(fixture.before);
        expect(yield* Ref.get(taxCalls)).toBe(0);

        // The same storefront order, placed by Merchandise's persistence in a runtime-role transaction.
        const runtimeDb = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(isolated.connections.runtime.connectionString, { maxConnections: 1 }),
          merchandiseRelations,
        );
        const [head] = yield* admin.unsafe<{ readonly revision: number }>(
          'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
          [company.tenantId, company.legalEntityId],
        );
        const orders = { db: runtimeDb, principal: native.principal, source };
        const placed = yield* placeOrder(orders, 'vat-transition-order-1', head?.revision ?? 0);
        // The same order as before the migration; only its id, derived from this run's invocation, differs.
        const orderBefore = Schema.decodeUnknownSync(JsonRecordSchema)(fixture.order.storefrontOrder);
        expect(placed).toEqual({ ...orderBefore, orderId: placed?.orderId });
        const [stored] = yield* admin.unsafe<{ readonly document: typeof fixture.order.document }>(
          `select document from demo_merchandise.orders where tenant_id = $1 and legal_entity_id = $2
              and client_request_id = 'vat-transition-order-1'`,
          [company.tenantId, company.legalEntityId],
        );
        expect(stored?.document.totalMinor).toBe(fixture.order.document.totalMinor);
        expect(stored?.document.totalVatMinor).toBe(fixture.order.document.totalVatMinor);
        expect(stored?.document.shipping).toEqual(fixture.order.document.shipping);
        expect(
          stored?.document.lines.map(({ quantity, sku, unitPriceMinor, vatRate }) => ({
            quantity,
            sku,
            unitPriceMinor,
            vatRate,
          })),
        ).toEqual(
          fixture.order.document.lines.map(({ quantity, sku, unitPriceMinor, vatRate }) => ({
            quantity,
            sku,
            unitPriceMinor,
            vatRate,
          })),
        );
        // The storefront after the order: exactly what the code before classifications showed after it.
        expect(yield* storefront).toEqual(fixture.after);

        // 2. Tax is installed and seeded; staff reads sync the company with no person involved. The first one answers
        //    from the materialised rates at once and starts the refresh; the next one materialises Tax's answer.
        yield* Ref.set(taxSource, () => Effect.succeed(BASELINE));
        const staffView = { view: { limit: 0, ordersLimit: 0, summary: true } };
        expect((yield* read(staffView)).taxRatesConfirmedAt).toBeNull();
        yield* Effect.sleep('100 millis');
        const staff = yield* read(staffView);
        expect(staff.taxRatesConfirmedAt).not.toBeNull();
        expect(staff.sellerVatRegime).toBe('VAT_PAYER');
        expect(staff.taxRates?.map((rate) => [rate.code, rate.ratePercent])).toEqual([
          ['cz.vat.standard', 21],
          ['cz.vat.reduced', 12],
        ]);
        const [synced] = yield* admin.unsafe<{ readonly taxRates: unknown }>(
          'select tax_rates as "taxRates" from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
          [company.tenantId, company.legalEntityId],
        );
        const state = Schema.decodeUnknownSync(CompanyTaxRatesSchema)(synced?.taxRates);
        expect([state.book.fingerprint, state.source, 'heldProductRates' in state]).toEqual([
          'tax:baseline-2024',
          'TAX',
          false,
        ]);
        const callsBeforeStorefront = yield* Ref.get(taxCalls);
        expect(yield* storefront).toEqual(withBookItAt(fixture.after, 12));
        expect(yield* Ref.get(taxCalls)).toBe(callsBeforeStorefront);
      }),
    240_000,
  );
});
