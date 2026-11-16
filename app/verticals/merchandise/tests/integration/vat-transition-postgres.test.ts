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
import { Clock, DateTime, Duration, Effect, FileSystem, Layer, Option, Predicate, Redacted, Ref, Schema } from 'effect';
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
import {
  CompanyTaxRatesSchema,
  TAX_RATE_FRESHNESS,
  TaxRateSource,
  TaxRatesFailure,
} from '../../src/services/tax-rates.ts';
import type { TaxRateBook } from '../../src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import {
  INFORMATIONAL_GROSS,
  JACKET_GROSS,
  VAT_TRANSITION_VIEWS,
  expectJacketAtVariantPrice,
  withBookItAt,
} from '../support/vat-transition-fixture.ts';

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

const FixtureOrderSchema = Schema.Struct({
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
});
const FixtureSchema = Schema.Struct({
  after: Schema.Record(Schema.String, Schema.Json),
  before: Schema.Record(Schema.String, Schema.Json),
  jacketOrder: FixtureOrderSchema,
  order: FixtureOrderSchema,
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
const views = VAT_TRANSITION_VIEWS;
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);

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

/** An order's lines as compared: what was sold, at what unit price and rate. */
const linesOf = (document: typeof FixtureOrderSchema.Type.document) =>
  document.lines.map(({ quantity, sku, unitPriceMinor, vatRate }) => ({ quantity, sku, unitPriceMinor, vatRate }));

/** One staff command (a price change) based on `expectedRevision`, through Merchandise's own preparation and write. */
const changePrice = Effect.fn('VatTransition.changePrice')(function* changePrice(
  input: {
    readonly db: RuntimeDb;
    readonly principal: Effect.Success<ReturnType<typeof makeNativeReadTestContext>>['principal'];
    readonly source: TaxSource;
  },
  expectedRevision: number,
) {
  const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
    command: { _tag: 'ChangePrice', id: 'p1', priceMinor: 1100 },
    expectedRevision,
  });
  const scope = { ...input.principal, correlationId: 'vat-transition-change-price' };
  const tax = yield* prepareCommandTax(payload.command, scope).pipe(Effect.provideService(TaxRateSource, input.source));
  return yield* input.db.transaction((tx) =>
    installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
      Effect.flatMap((scoped) =>
        persistenceService(scoped, { prepared: { actionInvocationId: scope.correlationId, payload, tax }, scope }),
      ),
      Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
    ),
  );
});

/** A fixture's storefront order (a fresh client request id), placed through Merchandise's own preparation and write. */
const placeOrder = Effect.fn('VatTransition.placeOrder')(function* placeOrder(
  input: {
    readonly db: RuntimeDb;
    readonly principal: Effect.Success<ReturnType<typeof makeNativeReadTestContext>>['principal'];
    readonly source: TaxSource;
  },
  entry: typeof FixtureOrderSchema.Type,
  clientRequestId: string,
  expectedRevision: number,
) {
  const { command } = Schema.decodeUnknownSync(Schema.Struct({ command: Schema.Record(Schema.String, Schema.Json) }))(
    entry.command,
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
  return order === undefined
    ? undefined
    : Schema.encodeSync(StorefrontOrderResultSchema)(Schema.decodeUnknownSync(StorefrontOrderResultSchema)(order));
});

/** How far {@link laterClock} runs ahead of the real clock. */
const clockShift = Ref.makeUnsafe(Duration.zero);
/**
 * The real clock moved forward by {@link clockShift}: Tax installed for the tenant is noticed only after Merchandise
 * waited out its refusal (a full freshness window), so the second phase runs that much later.
 */
const laterClock = (real: Clock.Clock): Clock.Clock => {
  const millis = () =>
    DateTime.toEpochMillis(
      DateTime.addDuration(DateTime.makeUnsafe(real.currentTimeMillisUnsafe()), Ref.getUnsafe(clockShift)),
    );
  return {
    currentTimeMillis: Effect.sync(millis),
    currentTimeMillisUnsafe: millis,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
    monotonicTimeNanos: real.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    sleep: (duration) => real.sleep(duration),
  };
};

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
          if (name >= TAX_CLASSIFICATION || !(yield* fs.exists(`${migrations}/${name}/migration.sql`))) {
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
        const migrated = yield* storefront;
        expect(migrated).toEqual(fixture.before);
        expectJacketAtVariantPrice(migrated);
        expect(yield* Ref.get(taxCalls)).toBe(0);

        // The same storefront order, placed by Merchandise's persistence in a runtime-role transaction.
        const runtimeDb = yield* makeTestDatabaseFromClient(
          yield* makeTestPgClient(isolated.connections.runtime.connectionString, { maxConnections: 1 }),
          merchandiseRelations,
        );
        const orders = { db: runtimeDb, principal: native.principal, source };
        const revisionNow = admin
          .unsafe<{ readonly revision: number }>(
            'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
            [company.tenantId, company.legalEntityId],
          )
          .pipe(Effect.map(([head]) => head?.revision ?? 0));
        // The same order as before the migration; only its id (and, when placed again, its number) differs.
        const placeSameOrder = Effect.fn('VatTransition.placeSameOrder')(function* placeSameOrder(
          entry: typeof FixtureOrderSchema.Type,
          clientRequestId: string,
        ) {
          const placed = yield* placeOrder(orders, entry, clientRequestId, yield* revisionNow);
          const orderBefore = Schema.decodeUnknownSync(JsonRecordSchema)(entry.storefrontOrder);
          expect(placed).toEqual({ ...orderBefore, orderId: placed?.orderId, orderNumber: placed?.orderNumber });
          const [stored] = yield* admin.unsafe<{ readonly document: typeof entry.document }>(
            `select document from demo_merchandise.orders where tenant_id = $1 and legal_entity_id = $2
                and client_request_id = $3`,
            [company.tenantId, company.legalEntityId, clientRequestId],
          );
          expect(stored?.document.totalMinor).toBe(entry.document.totalMinor);
          expect(stored?.document.totalVatMinor).toBe(entry.document.totalVatMinor);
          expect(stored?.document.shipping).toEqual(entry.document.shipping);
          expect(stored === undefined ? [] : linesOf(stored.document)).toEqual(linesOf(entry.document));
          return placed;
        });
        const placed = yield* placeSameOrder(fixture.order, 'vat-transition-order-1');
        expect(placed?.orderNumber).toEqual(
          Schema.decodeUnknownSync(JsonRecordSchema)(fixture.order.storefrontOrder).orderNumber,
        );
        // A jacket variant sells at 10 623,80 as before; the product with informational variants at its own price.
        const jacket = yield* placeSameOrder(fixture.jacketOrder, 'vat-transition-order-jacket');
        expect(jacket?.lines.map((line) => line.unitPriceMinor)).toEqual([JACKET_GROSS, INFORMATIONAL_GROSS]);
        // The storefront after the orders: exactly what the code before classifications showed after them.
        const after = yield* storefront;
        expect(after).toEqual(fixture.after);
        expectJacketAtVariantPrice(after);

        // 2. Tax is installed and seeded, and the wait after its refusal has passed; one staff read syncs the company
        //    with no person involved: with no fresh answer it asks Tax (a few seconds at most) and stores the answer in
        //    the same read. No second read and no other caller of Tax in between (stage did exactly this).
        yield* Ref.set(taxSource, () => Effect.succeed(BASELINE));
        yield* Ref.set(clockShift, Duration.sum(TAX_RATE_FRESHNESS, Duration.seconds(1)));
        const staffView = { view: { limit: 0, ordersLimit: 0, summary: true } };
        const staff = yield* read(staffView);
        expect(Option.isSome(staff.taxRatesConfirmedAt ?? Option.none())).toBe(true);
        expect(staff.sellerVatRegime).toEqual(Option.some('VAT_PAYER'));
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
        const priced = yield* storefront;
        expect(priced).toEqual(withBookItAt(fixture.after, 12));
        expect(yield* Ref.get(taxCalls)).toBe(callsBeforeStorefront);
        // Once Tax prices the company the jacket still sells at its variants' 10 623,80.
        expectJacketAtVariantPrice(priced);
        const again = yield* placeSameOrder(fixture.jacketOrder, 'vat-transition-order-jacket-priced');
        expect(again?.lines.map((line) => line.unitPriceMinor)).toEqual([JACKET_GROSS, INFORMATIONAL_GROSS]);

        // 3. A person's save racing a sync: the page was read at `beforeSync`, then a staff read stored Tax's changed
        //    answer (one revision up, stamped as a sync). The save is not refused for that sync alone.
        const beforeSync = yield* revisionNow;
        yield* Ref.set(taxSource, () => Effect.succeed({ ...BASELINE, fingerprint: 'tax:baseline-2024-again' }));
        yield* Ref.set(clockShift, Duration.sum(Duration.times(TAX_RATE_FRESHNESS, 2), Duration.seconds(2)));
        yield* read(staffView);
        expect(yield* revisionNow).toBe(beforeSync + 1);
        expect((yield* changePrice(orders, beforeSync)).revision).toBe(beforeSync + 2);
        // A save based on a revision older than the sync's predecessor is still a real conflict.
        expect(yield* changePrice(orders, beforeSync).pipe(Effect.flip)).toMatchObject({
          code: 'merchandise_revision_conflict',
        });
      }).pipe(Effect.provideServiceEffect(Clock.Clock, Clock.Clock.pipe(Effect.map((real) => laterClock(real))))),
    240_000,
  );
});
