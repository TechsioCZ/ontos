// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Rollback, first half: this release writes on the migrated database in its own shape, as it would before a rollback
 * to the release before classifications. It creates, edits and reprices products (one held at 10 %), changes a
 * variant's price, places a storefront order and edits it as staff, and writes a Finance ledger whose invoice,
 * recurring template and price-list lines name their classification, a Tax rule revision and a VAT treatment. What it
 * wrote, with every amount, goes to the report the old release then reads and rewrites in a checkout of the trunk the
 * deploy replaces (`tests/vat-reverse.old-release.mts`). It runs only inside the rehearsal (`ONTOS_VAT_REVERSE_REPORT`).
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
import { GatewayPrincipalVerifierConfiguration } from '../../packages/gateway-principal-verifier/src/server.ts';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { defineRelations } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Config, Crypto, DateTime, Effect, Layer, Option, Predicate, Redacted, Ref, Schema, Scope } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { ApplyCommandPayloadSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import { computeInvoiceTotals } from '../../verticals/finance-billing/shared/domain/invoice-totals.ts';
import { prepareApplyCommandServices } from '../../verticals/finance-billing/src/actions/apply-command.action.ts';
import { financeStates } from '../../verticals/finance-billing/src/database/schema.ts';
import { FinanceTaxRates } from '../../verticals/finance-billing/src/integrations/tax-rates.ts';
import { FinanceReferenceValidators } from '../../verticals/finance-billing/src/services/reference-validation.ts';
import { MerchandiseCommandPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import {
  TaxRuleRevisionIdSchema,
  grossUnitPriceMinor,
} from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import { recordsRead } from '../../verticals/merchandise/src/api/records.read.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { TaxRateSource } from '../../verticals/merchandise/src/services/tax-rates.ts';
import type { FetchedTaxRates, TaxRateBook } from '../../verticals/merchandise/src/services/tax-rates.ts';
import { persistenceService } from '../../verticals/merchandise/src/services/persistence.service.ts';
import type { PreparedTax } from '../../verticals/merchandise/src/services/persistence.service.ts';
import { merchandiseRegistration } from '../../verticals/merchandise/vertical.registration.ts';

const FixtureSchema = Schema.Struct({
  order: Schema.Struct({ command: Schema.Struct({ command: Schema.Record(Schema.String, Schema.Json) }) }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
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
const unused = () => Effect.die('Unexpected production reference transport');
const financeBoundary = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ReadRuntime, { runRead: unused }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  // Lines carry their VAT as this release priced it: Finance is not asked to price them again here.
  Layer.succeed(FinanceTaxRates, { choices: () => unused(), choicesFor: () => unused() }),
);
const reverseReport = Config.option(Config.String('ONTOS_VAT_REVERSE_REPORT'));
type FinanceCommandEncoded = (typeof ApplyCommandPayloadSchema.Encoded)['command'];
/** Tax not asked: the migrated rates serve, as right after the deploy. */
const NOT_ASKED: PreparedTax = { fetched: Option.getOrUndefined(Option.none<FetchedTaxRates>()), refused: false };
/** Tax's Czech baseline for the company: a payer from 1 January 2024 (Prague), standard 21 %, reduced 12 %. */
const PRAGUE_2024 = DateTime.makeUnsafe('2023-12-31T23:00:00.000Z');
const STANDARD = 'cz.vat.standard';
const REDUCED = 'cz.vat.reduced';
const BASELINE: TaxRateBook = {
  fingerprint: 'tax:baseline-2024',
  periods: [
    {
      code: STANDARD,
      effectiveFrom: PRAGUE_2024,
      ratePercent: '21',
      taxRuleRevisionId: TaxRuleRevisionIdSchema.make('rule-revision-standard-21'),
    },
    {
      code: REDUCED,
      effectiveFrom: PRAGUE_2024,
      ratePercent: '12',
      taxRuleRevisionId: TaxRuleRevisionIdSchema.make('rule-revision-reduced-12'),
    },
  ],
  regime: 'VAT_PAYER',
};
const JACKET_ID = 'spyder-jacket';
const JacketVariantSchema = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);
/** The prices a storefront detail shows for each product: its own, then each sellable variant's. */
const StorefrontPricesSchema = Schema.Struct({
  products: Schema.Array(
    Schema.Struct({
      grossPriceMinor: Schema.OptionFromOptionalNullOr(Schema.Number),
      id: Schema.String,
      variantRecords: Schema.optionalKey(
        Schema.Array(Schema.Struct({ grossPriceMinor: Schema.OptionFromOptionalNullOr(Schema.Number) })),
      ),
    }),
  ),
});
const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

it.live('this release writes products, orders and invoices in its own shape for the rollback rehearsal', () =>
  Effect.gen(function* newReleaseWrites() {
    const report = yield* reverseReport;
    if (Option.isNone(report)) {
      return yield* Effect.logWarning('Not run: the VAT deploy rehearsal sets ONTOS_VAT_REVERSE_REPORT');
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
    const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
    const native = yield* makeNativeReadTestContext({
      accessDecision: gate.bound,
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
    // The company's catalog as the deploy migrated it (the transition fixture's rows, through the migration's triggers).
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
    // A second product the old release stored at 10 % (held like BOOK-IT), for a person to reclassify to standard.
    yield* adminPg.unsafe(
      `insert into demo_merchandise.products
         select (jsonb_populate_record(p, jsonb_build_object(
           'id', 'held-2', 'sku', 'HELD-2', 'sku_key', 'held-2', 'slug', 'held-2', 'ordinal', p.ordinal + 1000,
           'document', (p.document - 'taxClassificationCode')
             || jsonb_build_object('id', 'held-2', 'sku', 'HELD-2', 'slug', 'held-2', 'vatRate', 10)))).*
           from demo_merchandise.products p
          where p.tenant_id = $1 and p.legal_entity_id = $2 and p.id = 'book-it'`,
      [tenantId, companyId],
    );
    yield* adminPg.unsafe(
      'update demo_merchandise.catalog_heads set tax_rates = demo_merchandise.migration_tax_rates(tenant_id, legal_entity_id) where tenant_id = $1 and legal_entity_id = $2',
      [tenantId, companyId],
    );
    yield* adminPg.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) select $1, key, 'active' from unnest(array['demo.merchandise', 'finance.billing', 'commerce.tax']) as key on conflict do nothing",
      [tenantId],
    );
    const revisionNow = adminPg
      .unsafe<{ readonly revision: number }>(
        'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
        [tenantId, companyId],
      )
      .pipe(Effect.map(([head]) => head?.revision ?? 0));
    /** Tax's answer the writes get: none at first (the migrated rates serve), later Tax's baseline. */
    const taxAnswer = yield* Ref.make(NOT_ASKED);
    /** One command through this release's owner write path. */
    const apply = Effect.fn('VatReverse.apply')(function* apply(command: Schema.Json, id?: string) {
      const correlationId = id ?? (yield* uuid);
      const scope: OperationalScope = { ...native.principal, correlationId };
      const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
        command,
        expectedRevision: yield* revisionNow,
      });
      const tax = yield* Ref.get(taxAnswer);
      return yield* runtimeDb.transaction((tx) =>
        installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) =>
            persistenceService(scoped, {
              prepared: { actionInvocationId: correlationId, payload, tax },
              scope,
            }),
          ),
          Effect.flatMap((services) => services.apply(payload.command, payload.expectedRevision, correlationId)),
        ),
      );
    });

    // A storefront order, then the staff edit of it.
    const placed = yield* apply({ ...fixture.order.command.command, clientRequestId: 'vat-reverse-order' });
    const storefrontOrder = Predicate.hasProperty(placed, 'storefrontOrder') ? placed.storefrontOrder : undefined;
    const orderId = Predicate.hasProperty(storefrontOrder, 'orderId') ? String(storefrontOrder.orderId) : '';
    yield* apply({
      _tag: 'EditOrder',
      id: orderId,
      lines: [
        { productId: 'book-it', quantity: 2 },
        { productId: 'p-reduced', quantity: 1 },
        { productId: 'p2', quantity: 2 },
      ],
      reason: 'Upraveno v novém vydání',
    });
    // Products: one created at the reduced classification, an edit, a price change, BOOK-IT (held) repriced, and a
    // variant's own price.
    const createdId = yield* uuid;
    yield* apply(
      {
        _tag: 'CreateProduct',
        active: true,
        category: 'Šrouby',
        lowStockThreshold: 0,
        name: 'Nový výrobek',
        priceMinor: 4000,
        sku: 'NEW-RELEASE-1',
        taxClassificationCode: REDUCED,
        unit: 'ks',
      },
      createdId,
    );
    yield* apply({ _tag: 'UpdateProduct', id: 'p3', patch: { name: 'Přejmenováno v novém vydání' } });
    yield* apply({ _tag: 'ChangePrice', id: 'p2', priceMinor: 75 });
    yield* apply({ _tag: 'ChangePrice', id: 'book-it', priceMinor: 50_000 });
    const [variant] = yield* adminPg.unsafe<{ readonly id: string; readonly productId: string }>(
      `select variant_id as id, product_id as "productId" from demo_merchandise.product_variants
        where tenant_id = $1 and legal_entity_id = $2 and variant_id is not null order by product_id, position limit 1`,
      [tenantId, companyId],
    );
    yield* apply({
      _tag: 'ChangePrice',
      id: variant?.productId ?? '',
      priceMinor: 12_345,
      variantId: variant?.id ?? '',
    });
    // While the company is still on the migrated rates a person reclassifies: the held HELD-2 to standard (its hold goes
    // with it), and the standard p2 to reduced.
    yield* apply({ _tag: 'UpdateProduct', id: 'held-2', patch: { taxClassificationCode: 'cz.vat.standard' } });
    yield* apply({ _tag: 'UpdateProduct', id: 'p2', patch: { taxClassificationCode: 'cz.vat.reduced' } });
    const [holds] = yield* adminPg.unsafe<{ readonly held: unknown }>(
      `select tax_rates -> 'heldProductRates' as held from demo_merchandise.catalog_heads
        where tenant_id = $1 and legal_entity_id = $2`,
      [tenantId, companyId],
    );
    expect(holds?.held).toEqual({ 'book-it': 10 });
    // BOOK-IT gains two variants while it is still held at 10 %.
    yield* apply({
      _tag: 'UpdateProduct',
      id: 'book-it',
      patch: {
        variants: [
          { attributes: 'Licence: roční', id: 'yearly', name: 'Roční', priceMinor: 30_000, sku: 'BOOK-IT-Y' },
          { attributes: 'Licence: měsíční', id: 'monthly', name: 'Měsíční', priceMinor: 40_000, sku: 'BOOK-IT-M' },
        ],
      },
    });

    // Tax prices the company (its baseline: standard 21 %, reduced 12 %), and the writes after it: a rename of BOOK-IT
    // (its stored prices stay at 10 %), a price change at 12 %, a variant priced at 12 % beside one stored at 10 % (the
    // variants now disagree), and an edit of the jacket's variants (N1's 38SA073510-BLK, mistyped product net).
    yield* Ref.set(taxAnswer, { fetched: { book: BASELINE, fetchedAt: yield* DateTime.now }, refused: false });
    yield* apply({ _tag: 'UpdateProduct', id: 'book-it', patch: { name: 'BOOK-IT po ocenění daní' } });
    yield* apply({ _tag: 'ChangePrice', id: 'p-reduced', priceMinor: 30_000 });
    yield* apply({ _tag: 'ChangePrice', id: 'book-it', priceMinor: 41_000, variantId: 'monthly' });
    const jacketVariants = yield* adminPg.unsafe<{ readonly document: Schema.Json }>(
      `select document from demo_merchandise.product_variants
        where tenant_id = $1 and legal_entity_id = $2 and product_id = $3 order by position`,
      [tenantId, companyId, JACKET_ID],
    );
    yield* apply({
      _tag: 'UpdateProduct',
      id: JACKET_ID,
      patch: {
        variants: jacketVariants.map(({ document }) => {
          const written = Schema.decodeUnknownSync(JacketVariantSchema)(document);
          return { ...written, name: `${written.name} (upraveno)` };
        }),
      },
    });
    const [head] = yield* adminPg.unsafe<{ readonly source: string }>(
      `select tax_rates ->> 'source' as source from demo_merchandise.catalog_heads
        where tenant_id = $1 and legal_entity_id = $2`,
      [tenantId, companyId],
    );
    expect(head?.source).toBe('TAX');

    // What the storefront sells each product and variant at now; the old release must sell at exactly these after the
    // rollback, except BOOK-IT's variant priced at 12 %, which it sells at 10 % (lower, never higher).
    const productIds = yield* adminPg.unsafe<{ readonly id: string }>(
      'select id from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2 order by id',
      [tenantId, companyId],
    );
    // One storefront detail per product: a full page holds at most two products.
    const detail = (id: string) =>
      native.runtime
        .runRead({
          input: { view: { storefront: true, storefrontCatalog: { fields: 'full', productIds: [id] } } },
          principal: native.principal,
          registration: recordsRead,
          transport: { correlationId: 'vat-reverse-storefront' },
        })
        .pipe(
          Effect.provide(native.layer),
          Effect.provideService(AccessDecisionGate, gate.accessDecision),
          Effect.provideService(TaxRateSource, { read: () => Effect.succeed(BASELINE) }),
          Effect.map((response) => Schema.decodeUnknownSync(StorefrontPricesSchema)(response).products),
        );
    const shown = yield* Effect.forEach(productIds, ({ id }) => detail(id), { concurrency: 1 });
    const selling = Object.fromEntries(
      shown
        .flat()
        .map((product) => [
          product.id,
          [
            Option.getOrNull(product.grossPriceMinor),
            ...(product.variantRecords ?? []).map((entry) => Option.getOrNull(entry.grossPriceMinor)),
          ],
        ]),
    );
    expect(selling[JACKET_ID]).toEqual([1_062_380, 1_062_380, 1_062_380, 1_062_380, 1_062_380, 1_062_380]);
    expect(selling['book-it']).toEqual([33_000, 33_000, 45_920]);
    // HELD-2 reclassified to standard: its hold went with it, its stored price stays.
    expect(selling['held-2']).toEqual([53_900]);

    // Finance: a ledger in this release's shape.
    const reactivity = yield* Reactivity.make;
    const financeClient = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) }).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    const financeDb = yield* makeWithDefaults({ relations: defineRelations({ financeStates }) }).pipe(
      Effect.provideService(PgClient.PgClient, financeClient),
    );
    const financeScope: OperationalScope = { ...native.principal, correlationId: 'vat-reverse-finance' };
    const financeApply = Effect.fn('VatReverse.finance')(function* financeApply(
      financeCommand: FinanceCommandEncoded,
      expectedRevision: number,
    ) {
      const actionInvocationId = yield* uuid;
      const payload = yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
        command: financeCommand,
        expectedRevision,
      });
      const context: ActionServicePreparationContext = {
        actionInvocationId,
        compositionRevision: 'vat-reverse-composition',
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
      // The lines carry their VAT as this release priced it; references are not what this rehearsal checks.
      const factory = yield* prepareApplyCommandServices(payload, context).pipe(
        Effect.provideService(FinanceReferenceValidators, {
          forScope: () => Effect.succeed({ invoice: () => Effect.void }),
        }),
      );
      return yield* financeDb.transaction((tx) =>
        installOperationalScope(tx, financeScope, defineDatabaseIdentityEnrollment([])).pipe(
          Effect.flatMap((scoped) => factory(scoped, financeScope, context.compositionRevision)),
          Effect.flatMap((services) => services.save(services.prepared.transition.state, expectedRevision)),
        ),
      );
    });
    const revisionRef = (code: string) =>
      ({
        moduleId: 'commerce.tax',
        resourceId: `${code}-2024`,
        resourceType: 'commerce.tax.tax-rule-revision',
        tenantId,
      }) as const;
    const invoiceLines = [
      {
        description: 'Nájemné',
        quantity: 1,
        taxRuleRevisionRef: revisionRef('standard'),
        unitPriceMinor: 100_000,
        vatClassification: STANDARD,
        vatRate: 21,
      },
      {
        description: 'Káva',
        quantity: 2,
        taxRuleRevisionRef: revisionRef('reduced'),
        unitPriceMinor: 25_000,
        vatClassification: REDUCED,
        vatRate: 12,
      },
      { description: 'Osvobozeno', quantity: 1, unitPriceMinor: 5000, vatRate: 0, vatTreatment: 'EXEMPT' },
    ] as const;
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: yield* uuid,
      resourceType: 'party.registry.counterparty',
      tenantId,
    } as const;
    let financeRevision = yield* financeApply(
      {
        _tag: 'CreateInvoiceDraft',
        counterpartyRef,
        currency: 'CZK',
        direction: 'OUTGOING',
        documentNumber: 'FV-NEW-RELEASE-1',
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
        actorLabel: 'Nové vydání',
        name: 'Nájem',
        unitPriceMinor: 100_000,
        vatClassification: STANDARD,
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
        name: 'Nájem v novém vydání',
      },
      financeRevision,
    );

    // Everything it wrote, with the amounts as stored, for the old release to read and rewrite.
    const products = yield* adminPg.unsafe<{
      readonly gross: number | null;
      readonly id: string;
      readonly net: number;
      readonly rate: number;
    }>(
      `select id, current_price_minor::integer as net, gross_price_minor::integer as gross,
              (document ->> 'vatRate')::integer as rate
         from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2 order by id`,
      [tenantId, companyId],
    );
    expect(products.every((product) => [21, 12, 10].includes(product.rate))).toBe(true);
    expect(products.find((product) => product.id === 'book-it')?.rate).toBe(10);
    expect(products.find((product) => product.id === createdId)?.rate).toBe(12);
    // The rollback rates: the jacket's variants reproduce at 21 %; BOOK-IT's disagree, so the lower rate; 12 % for the
    // product repriced after Tax.
    expect(
      ['book-it', 'p-reduced', JACKET_ID].map((id) => products.find((product) => product.id === id)?.rate),
    ).toEqual([10, 12, 21]);
    const orders = yield* adminPg.unsafe<{ readonly id: string; readonly total: number }>(
      `select id, total_minor::integer as total from demo_merchandise.orders
        where tenant_id = $1 and legal_entity_id = $2 order by id`,
      [tenantId, companyId],
    );
    const tiered = new Set(
      (yield* adminPg.unsafe<{ readonly id: string }>(
        `select distinct product_id as id from demo_merchandise.price_tiers
          where tenant_id = $1 and legal_entity_id = $2 and variant_position = -1`,
        [tenantId, companyId],
      )).map(({ id }) => id),
    );
    writeFileSync(
      report.value,
      JSON.stringify({
        companyId,
        financeRevision,
        invoiceTotals: computeInvoiceTotals(invoiceLines),
        orderId,
        orders,
        principal: native.principal,
        products,
        selling,
        sellingLowerAfterRollback: ['book-it', 'p2'],
        // Exclusion 1 of the rollback rule, inherent to the old release: a standard product it can only price at net +
        // 21 %, whose stored gross is lower (HELD-2, reclassified from held 10 % to standard keeping its price).
        sellingHigherAfterRollback: products
          .filter(
            (product) =>
              product.rate === 21 &&
              selling[product.id]?.length === 1 &&
              !tiered.has(product.id) &&
              product.gross !== null &&
              product.gross < grossUnitPriceMinor(product.net, 21),
          )
          .map((product) => product.id),
        tenantId,
        variant,
      }),
    );
    return yield* Effect.void;
  }).pipe(Effect.provide(Layer.mergeAll(NodeCrypto.layer, financeBoundary))),
);
