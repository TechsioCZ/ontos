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
import { Config, Crypto, Effect, Layer, Predicate, Redacted, Schema, Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { ApplyCommandPayloadSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import {
  CommandReferenceValidators,
  prepareApplyCommandServices,
} from '../../verticals/finance-billing/src/actions/apply-command.action.ts';
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

it.live('the old release keeps reading and writing whole while the new release migrated its database', () =>
  Effect.gen(function* oldReleaseWindow() {
    const report = yield* windowReport;
    if (report._tag === 'None') {
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
    ) {
      const actionInvocationId = yield* uuid;
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

    // What the old release wrote, with the money it computed, for the new release to check.
    writeFileSync(
      report.value,
      JSON.stringify({
        companyId,
        financeRevision,
        heldProductId: heldId,
        invoiceLines,
        orderId,
        products: [
          { gross: grossUnitPriceMinor(2000, 21), id: standardId, net: 2000, vatRate: 21 },
          { gross: grossUnitPriceMinor(30_000, 10), id: heldId, net: 30_000, vatRate: 10 },
          { gross: grossUnitPriceMinor(70, 21), id: 'p2', net: 70, vatRate: 21 },
          { id: 'p3', vatRate: 12 },
        ],
        tenantId,
      }),
    );
    return yield* Effect.void;
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, financeBoundary))),
);
