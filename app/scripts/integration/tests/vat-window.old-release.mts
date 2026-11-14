// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * The release before VAT classifications, still serving while the new release's migrations have already run (the
 * minutes between migration and publication on stage). This file is written against that release's code: the deploy
 * rehearsal (`vat-deploy-rehearsal.sh`) copies it into a checkout of the trunk the deploy replaces and runs it there,
 * against a private clone the new migrations were applied to. It is not part of this branch's own test projects.
 *
 * The old release must keep working: storefront reads answer byte for byte what they answered before the migration
 * (the recorded transition fixture), the same storefront order is placed with the same lines and totals, and staff
 * product and order writes and Finance invoices, price-list items and recurring invoices all succeed. What it wrote is
 * reported for the new release to check (`vat-window-new-release.test.mts`).
 *
 * Then the new release does not publish (the rollback case): the old release keeps serving on the migrated schema for
 * thirty days of ordinary work, its clock a day further each day. Each day it creates a product at 21, 12 or 10 %,
 * receives stock, changes a price, moves a product's rate both ways now and then, takes and confirms an order, and
 * issues and confirms an invoice with 21/12/10/0 % lines; every tenth day it generates a recurring invoice. Everything
 * it wrote is reported too; the new release then takes over and checks every row.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  ActiveApplicationCompositionService,
  ReadRuntime,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
} from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Clock, Config, Crypto, Effect, Layer, Option, Predicate, Redacted, Schema, Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { ApplyCommandPayloadSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import {
  CommandReferenceValidators,
  prepareApplyCommandServices,
} from '../../verticals/finance-billing/src/actions/apply-command.action.ts';
import { computeInvoiceTotals } from '../../verticals/finance-billing/shared/domain/invoice-totals.ts';
import { financeStates } from '../../verticals/finance-billing/src/database/schema.ts';
import { MerchandiseCommandPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import type { RecordsRequestEncoded } from '../../verticals/merchandise/shared/apis/records.ts';
import { grossUnitPriceMinor } from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import { recordsRead } from '../../verticals/merchandise/src/api/records.read.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { persistenceService } from '../../verticals/merchandise/src/services/persistence.service.ts';
import { merchandiseRegistration } from '../../verticals/merchandise/vertical.registration.ts';

const FixtureSchema = Schema.Struct({
  after: Schema.Record(Schema.String, Schema.Json),
  before: Schema.Record(Schema.String, Schema.Json),
  jacketOrder: Schema.Struct({ command: Schema.Json, storefrontOrder: Schema.Json }),
  order: Schema.Struct({ command: Schema.Json, storefrontOrder: Schema.Json }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
});
const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
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
const STOREFRONT = { storefront: true } as const;
/** The storefront views the transition fixture recorded, exactly as the deploy rehearsal reads them. */
const views = {
  cards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card' } } },
  cart: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', productIds: ['book-it', 'p-reduced', 'p2'] } } },
  category: { view: { ...STOREFRONT, storefrontCatalog: { categorySlug: 'metricke', fields: 'card' } } },
  detailBookIt: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'book-it' } } },
  detailInformational: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'tricko-barvy' } } },
  detailJacket: {
    view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'panska-bunda-spyder-vyper-jacket-cerna' } },
  },
  detailOddVariant: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'odd-variant' } } },
  detailReduced: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', slug: 'kava-zrnkova' } } },
  featured: { view: { ...STOREFRONT, storefrontCatalog: { featured: true, fields: 'card' } } },
  legacyList: { view: { ...STOREFRONT, limit: 250, summary: true } },
  marketCards: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', marketId: MARKET_ID } } },
  marketDetail: {
    view: { ...STOREFRONT, storefrontCatalog: { fields: 'full', marketId: MARKET_ID, slug: 'book-it' } },
  },
  priceAscending: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', sort: 'price-asc' } } },
  priceBounds: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', maxMinor: 60_000, minMinor: 100 } } },
  search: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'sroub' } } },
  searchJacket: { view: { ...STOREFRONT, storefrontCatalog: { fields: 'card', q: 'spyder' } } },
} satisfies Readonly<Record<string, RecordsRequestEncoded>>;

const encodeResponse = Schema.encodeSync(RecordsResponseSchema);
/** The encoded response without the per-run identities (the actor and the catalog revision). */
const comparable = (response: typeof RecordsResponseSchema.Type) => {
  const { actorPrincipalRef: _actor, revision: _revision, ...rest } = encodeResponse(response);
  void _actor;
  void _revision;
  return rest;
};

const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const unused = () => Effect.die('Unexpected production reference transport');
const financeBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ReadRuntime, { runRead: unused }),
);

const windowReport = Config.option(Config.String('ONTOS_VAT_WINDOW_REPORT'));

/** How long the old release keeps serving when the new one never publishes. */
const LONG_RUN_DAYS = 30;
const DAY_MILLIS = 86_400_000;
/** The real clock moved forward by `offsetMillis`; sleeps stay real. */
const shiftedClock = (real: Clock.Clock, offsetMillis: number): Clock.Clock => {
  const millis = () => real.currentTimeMillisUnsafe() + offsetMillis;
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
const calendarDateOf = (millis: number) => new Date(millis).toISOString().slice(0, 10);

it.live('the old release keeps reading and writing whole while the new release migrated its database', () =>
  Effect.gen(function* oldReleaseWindow() {
    const report = yield* windowReport;
    if (Option.isNone(report)) {
      return yield* Effect.logWarning('Not run: the VAT deploy rehearsal sets ONTOS_VAT_WINDOW_REPORT');
    }
    const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))(
      readFileSync(yield* Config.String('ONTOS_VAT_WINDOW_FIXTURE'), 'utf-8'),
    );
    const connections = yield* loadDatabaseConnectionPair();
    const adminPg = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 2 });
    const runtimeDb = yield* makeTestDatabaseFromClient(
      yield* makeTestPgClient(connections.runtime.connectionString, { maxConnections: 1 }),
      merchandiseRelations,
    );
    const allowAll = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
    const native = yield* makeNativeReadTestContext({
      accessDecision: allowAll.bound,
      connections: {
        admin: { connectionString: Redacted.make(connections.admin.connectionString) },
        runtime: { connectionString: Redacted.make(connections.runtime.connectionString) },
      },
      contextPermissions: [],
      moduleId: 'demo.merchandise',
      ownerFixtureRetention: 'retain-complete-context',
    }).pipe(
      Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration),
      // The rehearsal drops its clone with every row this context wrote.
      Scope.provide(yield* Scope.make()),
    );
    const { legalEntityId, tenantId } = native.principal;
    const companyId = legalEntityId ?? '';

    // The company's catalog as the old release stored it before the deploy, then as the migration left it: the rows
    // pass the migration's own triggers, and the company's rates come from the migration's own function.
    for (const table of TABLES) {
      yield* adminPg.unsafe(
        `insert into demo_merchandise.${table} select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
        [
          JSON.stringify(
            (fixture.rows[table] ?? []).map((row) => ({ ...row, legal_entity_id: companyId, tenant_id: tenantId })),
          ),
        ],
      );
    }
    yield* adminPg.unsafe(
      'update demo_merchandise.catalog_heads set tax_rates = demo_merchandise.migration_tax_rates(tenant_id, legal_entity_id) where tenant_id = $1 and legal_entity_id = $2',
      [tenantId, companyId],
    );
    yield* adminPg.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) select $1, key, 'active' from unnest(array['demo.merchandise', 'finance.billing']) as key on conflict do nothing",
      [tenantId],
    );

    const read = (input: RecordsRequestEncoded) =>
      native.runtime
        .runRead({
          input,
          principal: native.principal,
          registration: recordsRead,
          transport: { correlationId: 'vat-window' },
        })
        .pipe(Effect.provide(native.layer), Effect.provideService(AccessDecisionGate, allowAll.accessDecision));
    const storefront = Effect.forEach(
      Object.entries(views),
      ([name, view]) => read(view).pipe(Effect.map((response) => [name, comparable(response)] as const)),
      { concurrency: 1 },
    ).pipe(Effect.map(Object.fromEntries));
    const revisionNow = adminPg
      .unsafe<{ readonly revision: number }>(
        'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
        [tenantId, companyId],
      )
      .pipe(Effect.map(([head]) => head?.revision ?? 0));
    /** One staff or storefront command through the old release's owner write path; `id` names what it creates. */
    const apply = Effect.fn('VatWindow.apply')(function* apply(command: Schema.Json, id?: string) {
      const correlationId = id ?? (yield* uuid);
      const scope: OperationalScope = { ...native.principal, correlationId };
      const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
        command,
        expectedRevision: yield* revisionNow,
      });
      return yield* runtimeDb.transaction((tx) =>
        installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) =>
            persistenceService(scoped, { prepared: { actionInvocationId: correlationId, payload }, scope }),
          ),
          Effect.flatMap((services) => services.apply(payload.command, payload.expectedRevision, correlationId)),
        ),
      );
    });

    // Storefront reads: the same bytes the old release answered before the migration, and the same order.
    expect(yield* storefront).toEqual(fixture.before);
    const { command } = Schema.decodeUnknownSync(Schema.Struct({ command: JsonRecordSchema }))(fixture.order.command);
    const placed = yield* apply({ ...command, clientRequestId: 'vat-window-order-1' });
    const order = Predicate.hasProperty(placed, 'storefrontOrder') ? placed.storefrontOrder : undefined;
    const orderBefore = Schema.decodeUnknownSync(JsonRecordSchema)(fixture.order.storefrontOrder);
    const orderId = Predicate.hasProperty(order, 'orderId') ? String(order.orderId) : '';
    expect(Schema.decodeUnknownSync(JsonRecordSchema)(JSON.parse(JSON.stringify(order)))).toEqual({
      ...orderBefore,
      orderId,
    });
    // A jacket variant (N1's 38SA073510-BLK) at 10 623,80 and the product with informational variants, as before.
    const jacket = Schema.decodeUnknownSync(Schema.Struct({ command: JsonRecordSchema }))(fixture.jacketOrder.command);
    const jacketPlaced = yield* apply(jacket.command);
    const jacketOrder = Predicate.hasProperty(jacketPlaced, 'storefrontOrder')
      ? jacketPlaced.storefrontOrder
      : undefined;
    const jacketBefore = Schema.decodeUnknownSync(JsonRecordSchema)(fixture.jacketOrder.storefrontOrder);
    expect(Schema.decodeUnknownSync(JsonRecordSchema)(JSON.parse(JSON.stringify(jacketOrder)))).toEqual({
      ...jacketBefore,
      orderId: Predicate.hasProperty(jacketOrder, 'orderId') ? String(jacketOrder.orderId) : '',
    });
    expect(yield* storefront).toEqual(fixture.after);

    // Staff writes: two new products (21 % and 10 %), a price change, a rate change, an order edit and a status change.
    const standardId = yield* uuid;
    const heldId = yield* uuid;
    const createProduct = (id: string, name: string, priceMinor: number, vatRate: number) =>
      apply(
        {
          _tag: 'CreateProduct',
          active: true,
          category: 'Šrouby',
          lowStockThreshold: 0,
          name,
          priceMinor,
          sku: `OLD-WINDOW-${vatRate}`,
          unit: 'ks',
          vatRate,
        },
        id,
      );
    yield* createProduct(standardId, 'Okno ve starém vydání', 2000, 21);
    yield* createProduct(heldId, 'Kniha ve starém vydání', 30_000, 10);
    yield* apply({ _tag: 'ChangePrice', id: 'p2', priceMinor: 70 });
    yield* apply({ _tag: 'UpdateProduct', id: 'p3', patch: { vatRate: 12 } });
    yield* apply({
      _tag: 'EditOrder',
      id: orderId,
      lines: [
        { productId: 'book-it', quantity: 2 },
        { productId: 'p-reduced', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      reason: 'Přidán řádek ve starém vydání',
    });
    yield* apply({ _tag: 'ChangeOrderStatus', id: orderId, status: 'CONFIRMED' });

    // A product whose variant has no gross price, as two of stage's 45,501 variants: stored before the deploy in the old
    // shape (copied from p1, its variant's gross dropped from column and document), through the migration's triggers.
    yield* adminPg.unsafe(
      `insert into demo_merchandise.products
         select (jsonb_populate_record(null::demo_merchandise.products, to_jsonb(p) || jsonb_build_object(
           'id', 'stage-no-gross', 'sku', 'STAGE-NG', 'sku_key', 'stage-ng', 'slug', 'stage-no-gross',
           'document', p.document || '{"sku":"STAGE-NG","slug":"stage-no-gross"}'::jsonb))).*
           from demo_merchandise.products p where p.tenant_id = $1 and p.legal_entity_id = $2 and p.id = 'p1'`,
      [tenantId, companyId],
    );
    yield* adminPg.unsafe(
      `insert into demo_merchandise.product_variants
         select (jsonb_populate_record(null::demo_merchandise.product_variants, to_jsonb(v) || jsonb_build_object(
           'product_id', 'stage-no-gross', 'variant_id', 'stage-no-gross-v', 'gross_price_minor', null,
           'document', (v.document - 'grossPriceMinor') || '{"id":"stage-no-gross-v","sku":"STAGE-NG-V"}'::jsonb))).*
           from demo_merchandise.product_variants v
          where v.tenant_id = $1 and v.legal_entity_id = $2 and v.product_id = 'p1' and v.variant_id is not null
          limit 1`,
      [tenantId, companyId],
    );

    // The old release reads back what it wrote, in its own shape.
    const staff = yield* read({ view: { limit: 250, ordersLimit: 50, summary: true } });
    const productsById = new Map(staff.products.map((product) => [String(product.id), product]));
    expect(productsById.get(standardId)?.vatRate).toBe(21);
    expect(productsById.get(heldId)?.vatRate).toBe(10);
    expect(productsById.get('p3')?.vatRate).toBe(12);
    expect(productsById.get('p2')?.currentPriceMinor).toBe(70);
    const edited = staff.orders.find((entry) => String(entry.id) === orderId);
    expect(edited?.status).toBe('CONFIRMED');
    expect(edited?.lines.map((line) => [String(line.productId), line.quantity, line.vatRate])).toEqual([
      ['book-it', 2, 10],
      ['p-reduced', 1, 12],
      ['p2', 2, 21],
    ]);

    // Finance: a ledger the old release creates and then rewrites three times (a price-list item, a recurring
    // template, the invoice generated from it), each save writing the whole ledger without any classification.
    const reactivity = yield* Reactivity.make;
    const financeClient = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const financeDb = yield* makeWithDefaults({ relations: defineRelations({ financeStates }) }).pipe(
      Effect.provideService(PgClient.PgClient, financeClient),
    );
    const financeScope: OperationalScope = { ...native.principal, correlationId: 'vat-window-finance' };
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: yield* uuid,
      resourceType: 'party.registry.counterparty',
      tenantId,
    };
    const financeApply = Effect.fn('VatWindow.finance')(function* financeApply(
      financeCommand: Schema.Json,
      expectedRevision: number,
      id?: string,
    ) {
      const actionInvocationId = id ?? (yield* uuid);
      const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
        command: financeCommand,
        expectedRevision,
      });
      const context: ActionServicePreparationContext = {
        actionInvocationId,
        compositionRevision: 'vat-window-composition',
        scope: financeScope,
        transaction: (readSnapshot) =>
          financeDb
            .transaction((tx) =>
              installOperationalScope(tx, financeScope, defineDatabaseIdentityEnrollment([])).pipe(
                Effect.flatMap(readSnapshot),
              ),
            )
            .pipe(Effect.orDie),
      };
      const factory = yield* prepareApplyCommandServices(payload, context).pipe(
        Effect.provideService(CommandReferenceValidators, { invoice: () => Effect.void }),
      );
      return yield* financeDb.transaction((tx) =>
        installOperationalScope(tx, financeScope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) => factory(scoped, financeScope, context.compositionRevision)),
          Effect.flatMap((services) => services.save(services.prepared.transition.state, expectedRevision)),
        ),
      );
    });
    const invoiceLines = [
      { description: 'Nájemné', quantity: 1, unitPriceMinor: 100_000, vatRate: 21 },
      { description: 'Káva', quantity: 2, unitPriceMinor: 25_000, vatRate: 12 },
      { description: 'Kniha', quantity: 1, unitPriceMinor: 30_000, vatRate: 10 },
      { description: 'Osvobozeno', quantity: 1, unitPriceMinor: 5000, vatRate: 0 },
    ];
    // An invoice issued with 21 % and 10 % lines, as stage's two ledgers hold them (21 % ×42 and 10 % ×3 in one).
    let financeRevision = yield* financeApply(
      {
        _tag: 'CreateInvoiceDraft',
        counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: 'FV-OLD-WINDOW-1',
        dueDate: '2026-12-31',
        issueDate: '2026-11-12',
        lines: invoiceLines,
      },
      0,
    );
    const [created] = yield* adminPg.unsafe<{ readonly id: string }>(
      `select state #>> '{invoices,0,ref,resourceId}' as id from finance_billing.finance_states
        where tenant_id = $1 and legal_entity_id = $2`,
      [tenantId, companyId],
    );
    const issuedId = created?.id ?? '';
    const issuedRef = {
      moduleId: 'finance.billing',
      resourceId: issuedId,
      resourceType: 'finance.billing.invoice',
      tenantId,
    };
    financeRevision = yield* financeApply(
      { _tag: 'MarkInvoicesPrepared', actorLabel: 'Staré vydání', invoiceRefs: [issuedRef] },
      financeRevision,
    );
    financeRevision = yield* financeApply(
      {
        _tag: 'ConfirmInvoice',
        actorLabel: 'Staré vydání',
        invoiceRef: issuedRef,
      },
      financeRevision,
    );
    financeRevision = yield* financeApply(
      {
        _tag: 'UpsertPriceListItem',
        active: true,
        actorLabel: 'Staré vydání',
        name: 'Nájem',
        unitPriceMinor: 100_000,
        vatRate: 21,
      },
      financeRevision,
    );
    financeRevision = yield* financeApply(
      {
        _tag: 'CreateRecurringTemplate',
        counterpartyRef,
        dueDays: 14,
        issueDay: 1,
        lines: invoiceLines.slice(0, 2),
        name: 'Nájem ve starém vydání',
      },
      financeRevision,
    );
    const [ledger] = yield* adminPg.unsafe<{ readonly templateId: string }>(
      `select state #>> '{recurringTemplates,0,id}' as "templateId" from finance_billing.finance_states
        where tenant_id = $1 and legal_entity_id = $2`,
      [tenantId, companyId],
    );
    financeRevision = yield* financeApply(
      {
        _tag: 'GenerateRecurringInvoice',
        confirmDuplicate: false,
        period: '2026-12',
        templateId: ledger?.templateId ?? '',
      },
      financeRevision,
    );

    const [windowLedger] = yield* adminPg.unsafe<{ readonly ids: readonly string[] }>(
      `select coalesce(jsonb_agg(invoice #>> '{ref,resourceId}'), '[]'::jsonb) as ids
         from finance_billing.finance_states, jsonb_array_elements(state -> 'invoices') as invoice
        where tenant_id = $1 and legal_entity_id = $2`,
      [tenantId, companyId],
    );
    const windowInvoiceIds = windowLedger?.ids ?? [];

    // The new release never publishes: thirty days of the old release on the migrated schema.
    const real = yield* Clock.Clock;
    const startMillis = real.currentTimeMillisUnsafe();
    const finalRates = new Map<string, number>();
    const priced = new Map<string, { readonly gross: number; readonly net: number }>();
    const longRunOrders: string[] = [];
    const longRunInvoices: { readonly id: string; readonly totals: ReturnType<typeof computeInvoiceTotals> }[] = [];
    const recurringPeriods: string[] = [];
    const invoiceIdOf = (documentNumber: string) =>
      adminPg
        .unsafe<{ readonly id: string }>(
          `select invoice #>> '{ref,resourceId}' as id
             from finance_billing.finance_states, jsonb_array_elements(state -> 'invoices') as invoice
            where tenant_id = $1 and legal_entity_id = $2 and invoice ->> 'documentNumber' = $3`,
          [tenantId, companyId, documentNumber],
        )
        .pipe(Effect.map(([row]) => row?.id ?? ''));
    const oneDay = Effect.fn('VatWindow.longRunDay')(function* oneDay(day: number) {
      const rate = [21, 12, 10][day % 3] ?? 21;
      const id = yield* uuid;
      yield* apply(
        {
          _tag: 'CreateProduct',
          active: true,
          category: 'Šrouby',
          lowStockThreshold: 0,
          name: `Den ${String(day + 1)} ve starém vydání`,
          priceMinor: 1000 + day,
          sku: `OLD-DAY-${String(day + 1)}`,
          unit: 'ks',
          vatRate: rate,
        },
        id,
      );
      finalRates.set(id, rate);
      yield* apply({ _tag: 'RecordStockMovement', delta: 10, productId: id, reason: 'RECEIPT' });
      yield* apply({ _tag: 'ChangePrice', id, priceMinor: 1100 + day });
      priced.set(id, { gross: grossUnitPriceMinor(1100 + day, rate), net: 1100 + day });
      // Now and then a rate moves both ways: a 10 % product to 21 % (its hold ends), a 21 % product to 10 % (held).
      const moving = [...finalRates].find(([, held]) => held === (day % 2 === 0 ? 10 : 21));
      if (day % 4 === 3 && moving !== undefined) {
        const [movingId, from] = moving;
        const to = from === 10 ? 21 : 10;
        yield* apply({ _tag: 'UpdateProduct', id: movingId, patch: { vatRate: to } });
        finalRates.set(movingId, to);
        priced.delete(movingId);
      }
      const orderId = `long-run-order-${String(day + 1)}`;
      yield* apply({ _tag: 'CreateOrder', id: orderId, lines: [{ productId: id, quantity: 2 }], partyId: 'long-run' });
      yield* apply({ _tag: 'ChangeOrderStatus', id: orderId, status: 'CONFIRMED' });
      longRunOrders.push(orderId);
      const documentNumber = `FV-OLD-DAY-${String(day + 1)}`;
      financeRevision = yield* financeApply(
        {
          _tag: 'CreateInvoiceDraft',
          counterpartyRef,
          currency: 'CZK',
          direction: 'OUTGOING',
          documentNumber,
          dueDate: calendarDateOf(startMillis + (day + 14) * DAY_MILLIS),
          issueDate: calendarDateOf(startMillis + day * DAY_MILLIS),
          lines: invoiceLines,
        },
        financeRevision,
      );
      const invoiceRef = { ...issuedRef, resourceId: yield* invoiceIdOf(documentNumber) };
      financeRevision = yield* financeApply(
        { _tag: 'MarkInvoicesPrepared', actorLabel: 'Staré vydání', invoiceRefs: [invoiceRef] },
        financeRevision,
      );
      financeRevision = yield* financeApply(
        { _tag: 'ConfirmInvoice', actorLabel: 'Staré vydání', invoiceRef },
        financeRevision,
      );
      longRunInvoices.push({ id: invoiceRef.resourceId, totals: computeInvoiceTotals(invoiceLines) });
      if (day % 10 === 9) {
        // The window generated December 2026; each tenth day the next month after it.
        const period = `2027-${String((day + 1) / 10).padStart(2, '0')}`;
        financeRevision = yield* financeApply(
          { _tag: 'GenerateRecurringInvoice', confirmDuplicate: false, period, templateId: ledger?.templateId ?? '' },
          financeRevision,
        );
        recurringPeriods.push(period);
      }
    });
    yield* Effect.forEach(
      Array.from({ length: LONG_RUN_DAYS }, (_, day) => day),
      (day) => oneDay(day).pipe(Effect.provideService(Clock.Clock, shiftedClock(real, (day + 1) * DAY_MILLIS))),
      { concurrency: 1, discard: true },
    );

    // What the old release wrote, with the money it computed, for the new release to check.
    writeFileSync(
      report.value,
      JSON.stringify({
        companyId,
        financeRevision,
        heldProductId: heldId,
        invoiceLines,
        issued: { id: issuedId, totals: computeInvoiceTotals(invoiceLines) },
        longRun: {
          days: LONG_RUN_DAYS,
          invoices: longRunInvoices,
          orders: longRunOrders,
          products: [...finalRates].map(([id, vatRate]) => ({ id, vatRate, ...priced.get(id) })),
          recurringPeriods,
        },
        orderId,
        products: [
          { gross: grossUnitPriceMinor(2000, 21), id: standardId, net: 2000, vatRate: 21 },
          { gross: grossUnitPriceMinor(30_000, 10), id: heldId, net: 30_000, vatRate: 10 },
          { gross: grossUnitPriceMinor(70, 21), id: 'p2', net: 70, vatRate: 21 },
          { id: 'p3', vatRate: 12 },
        ],
        tenantId,
        windowInvoiceIds,
      }),
    );
    return yield* Effect.void;
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, financeBoundary))),
);
