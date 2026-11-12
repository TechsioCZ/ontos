// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * After the old release kept serving on the migrated database (`tests/vat-window.old-release.mts`, run by the
 * deploy rehearsal in a trunk checkout), the new release reads every row the old one wrote through its own store:
 * - each product decodes with its classification (column and document agree) and its net and gross exactly as the
 *   old release computed them; one created at 10 % is held at 10 %, so it keeps selling at that rate;
 * - the edited order decodes with every line classified as the migration classifies stored lines, its amounts as
 *   the old release stored them;
 * - the ledger the old release rewrote four times decodes with every 21 % and 12 % entry classified and every amount
 *   as stored;
 * - after the old release kept serving for thirty simulated days (the new release never published, then took over),
 *   every product, order and invoice it wrote meanwhile is just as complete: classified, held exactly where it sells
 *   at 10 %, every amount as it computed it.
 * It runs only inside the rehearsal (`ONTOS_VAT_WINDOW_REPORT` names the old release's report).
 */
import { readFileSync } from 'node:fs';

import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { Config, DateTime, Effect, Option, Schema } from 'effect';
import type { PgClient } from '@effect/sql-pg';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { FinanceStateSchema } from '../../verticals/finance-billing/shared/apis/records.ts';
import type { FinanceState } from '../../verticals/finance-billing/shared/apis/records.ts';
import { InvoiceRefSchema } from '../../verticals/finance-billing/shared/resources/invoice.ts';
import { decodeFinanceState } from '../../verticals/finance-billing/src/services/finance-state-repository.ts';
import {
  OrderIdSchema,
  OrderSchema,
  ProductIdSchema,
  grossUnitPriceMinor,
} from '../../verticals/merchandise/shared/domain/merchandise-model.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import { withStorefrontVat } from '../../verticals/merchandise/src/services/merchandise-queries.ts';
import {
  loadHead,
  loadProducts,
  storeMissingGrossPrices,
} from '../../verticals/merchandise/src/services/merchandise-store.ts';
import type { MerchandiseDb } from '../../verticals/merchandise/src/services/merchandise-store.ts';
import { stockLevelsOf, toProductRecord } from '../../verticals/merchandise/src/services/stock-levels.ts';
import { heldRatesOf, sellableRatesOf } from '../../verticals/merchandise/src/services/tax-rates.ts';

const STANDARD = 'cz.vat.standard';
const REDUCED = 'cz.vat.reduced';

const InvoiceIdSchema = InvoiceRefSchema.fields.resourceId;
const TotalsSchema = Schema.Struct({
  subtotalMinor: Schema.Number,
  totalMinor: Schema.Number,
  vatMinor: Schema.Number,
  vatRecap: Schema.Array(Schema.Struct({ baseMinor: Schema.Number, rate: Schema.Number, vatMinor: Schema.Number })),
});
const WrittenProductSchema = Schema.Struct({
  gross: Schema.optionalKey(Schema.Number),
  id: ProductIdSchema,
  net: Schema.optionalKey(Schema.Number),
  vatRate: Schema.Number,
});
const ReportSchema = Schema.Struct({
  companyId: LegalEntityIdSchema,
  financeRevision: Schema.Number,
  heldProductId: ProductIdSchema,
  invoiceLines: Schema.Array(
    Schema.Struct({
      description: Schema.String,
      quantity: Schema.Number,
      unitPriceMinor: Schema.Number,
      vatRate: Schema.Number,
    }),
  ),
  issued: Schema.Struct({ id: InvoiceIdSchema, totals: TotalsSchema }),
  /** What the old release wrote while it kept serving for `days` simulated days. */
  longRun: Schema.Struct({
    days: Schema.Number,
    invoices: Schema.Array(Schema.Struct({ id: InvoiceIdSchema, totals: TotalsSchema })),
    orders: Schema.Array(OrderIdSchema),
    products: Schema.Array(WrittenProductSchema),
    recurringPeriods: Schema.Array(Schema.String),
  }),
  orderId: OrderIdSchema,
  products: Schema.Array(WrittenProductSchema),
  tenantId: TenantIdSchema,
  windowInvoiceIds: Schema.Array(InvoiceIdSchema),
});
type Report = typeof ReportSchema.Type;
const RowSchema = Schema.Struct({ revision: Schema.Number, state: Schema.toEncoded(FinanceStateSchema) });

/** The migration's mapping: products 21 -> standard, 12 and 10 -> reduced; order and Finance lines 21 and 12 only. */
const productClassification = (rate: number) => (rate === 21 ? STANDARD : REDUCED);
const lineClassification = (rate: number) => {
  if (rate === 21) {
    return STANDARD;
  }
  return rate === 12 ? REDUCED : undefined;
};
const classified = (entries: readonly { readonly vatClassification?: string; readonly vatRate: number }[]) =>
  entries.map((entry) => [entry.vatRate, entry.vatClassification]);

/** Products: the new release's own store decodes each one; column, document and money agree. */
const checkProducts = Effect.fn('VatWindow.products')(function* checkProducts(
  report: Report,
  db: MerchandiseDb,
  adminPg: PgClient.PgClient,
) {
  const store = { legalEntityId: report.companyId, tenantId: report.tenantId };
  const hydrated = yield* loadProducts(db, store);
  const products = hydrated.map(({ product }) => product);
  const columns = yield* adminPg.unsafe<{
    readonly classification: string;
    readonly gross: number | null;
    readonly id: string;
    readonly net: number;
  }>(
    `select id, tax_classification_code as classification, gross_price_minor::integer as gross,
            current_price_minor::integer as net
       from demo_merchandise.products where tenant_id = $1 and legal_entity_id = $2`,
    [report.tenantId, report.companyId],
  );
  const columnOf = new Map(columns.map((row) => [row.id, row]));
  for (const written of [...report.products, ...report.longRun.products]) {
    const product = products.find((entry) => entry.id === written.id);
    const column = columnOf.get(written.id);
    expect([product?.taxClassificationCode, column?.classification], written.id).toEqual([
      productClassification(written.vatRate),
      productClassification(written.vatRate),
    ]);
    if (written.net !== undefined) {
      expect([product?.currentPriceMinor, product?.grossPriceMinor, column?.net, column?.gross], written.id).toEqual([
        written.net,
        written.gross,
        written.net,
        written.gross,
      ]);
    }
  }
  // Every product of the company decodes and is classified: none is left for the contract step to refuse.
  expect(columns.every((row) => row.classification === STANDARD || row.classification === REDUCED)).toBe(true);
  expect(products.length).toBe(columns.length);

  // The 10 % product the old release created is held at 10 % with BOOK-IT: the storefront sells it unchanged. The old
  // release wrote it as the deploy's runtime role (`ontos_runtime`, no superuser, row-level security on), so the hold
  // trigger's update of the company's head ran on that role's own rights. Every role that may write a product
  // document on the deployed database (the table's owner and each role granted INSERT or UPDATE on it) may update the
  // heads too, so no writer's product write fails on the hold.
  const writers = yield* adminPg.unsafe<{
    readonly heads: boolean;
    readonly role: string;
    readonly superuser: boolean;
  }>(
    `select r.rolname as role, r.rolsuper as superuser,
            has_table_privilege(r.oid, 'demo_merchandise.catalog_heads', 'UPDATE') as heads
       from pg_roles r
      where pg_has_role(r.oid, (select relowner from pg_class where oid = 'demo_merchandise.products'::regclass), 'USAGE')
         or has_table_privilege(r.oid, 'demo_merchandise.products', 'INSERT')
         or has_table_privilege(r.oid, 'demo_merchandise.products', 'UPDATE')`,
  );
  expect(writers.filter((writer) => writer.role === 'ontos_runtime')).toEqual([
    { heads: true, role: 'ontos_runtime', superuser: false },
  ]);
  expect(writers.filter((writer) => !writer.heads)).toEqual([]);
  const head = yield* loadHead(db, store);
  const held = heldRatesOf(head?.taxRates);
  // Exactly the products selling at 10 %: BOOK-IT, the window's one, and every long-run product whose last rate is 10 %
  // (a product moved from 10 % to 21 % lost its hold, one moved the other way gained it).
  const heldLater = report.longRun.products.filter((product) => product.vatRate === 10);
  expect(heldLater.length).toBeGreaterThan(0);
  expect(held).toEqual({
    'book-it': 10,
    [report.heldProductId]: 10,
    ...Object.fromEntries(heldLater.map((product) => [product.id, 10])),
  });
  const rates = sellableRatesOf(head?.taxRates, yield* DateTime.now);
  const heldProduct = products.find((entry) => entry.id === report.heldProductId);
  if (heldProduct === undefined) {
    return yield* Effect.die('The held product is missing');
  }
  const stock =
    hydrated.find(({ product }) => product.id === heldProduct.id)?.stock ?? stockLevelsOf([], heldProduct.id);
  const record = withStorefrontVat(toProductRecord(heldProduct, stock, rates, held), rates, held);
  expect([record.vatRate, record.grossPriceMinor]).toEqual([10, 33_000]);

  // The first staff read or write backfills a price stored without any gross: the old era's variant without one gets
  // its gross at the rate its classification sells at (21 %); no stored gross moves, however unrelated to its net.
  const variantGrosses = adminPg.unsafe<{ readonly gross: number | null; readonly id: string; readonly net: number }>(
    `select variant_id as id, gross_price_minor::integer as gross, price_minor::integer as net
       from demo_merchandise.product_variants
      where tenant_id = $1 and legal_entity_id = $2 and variant_id is not null order by variant_id`,
    [report.tenantId, report.companyId],
  );
  const before = yield* variantGrosses;
  expect(before.filter((row) => row.gross === null).map((row) => row.id)).toEqual(['stage-no-gross-v']);
  yield* storeMissingGrossPrices(db, store, rates, held);
  const after = yield* variantGrosses;
  expect(after).toEqual(
    before.map((row) => (row.gross === null ? { ...row, gross: grossUnitPriceMinor(row.net, 21) } : row)),
  );
  return yield* Effect.void;
});

/** The order it placed, edited and confirmed: every line classified as the migration classifies stored lines. */
const checkOrder = Effect.fn('VatWindow.order')(function* checkOrder(report: Report, adminPg: PgClient.PgClient) {
  const [row] = yield* adminPg.unsafe<{ readonly document: unknown; readonly total: number }>(
    `select document, total_minor::integer as total from demo_merchandise.orders
      where tenant_id = $1 and legal_entity_id = $2 and id = $3`,
    [report.tenantId, report.companyId, report.orderId],
  );
  const order = Schema.decodeUnknownSync(OrderSchema)(row?.document);
  expect(order.status).toBe('CONFIRMED');
  expect(order.lines.map((line) => [line.productId, line.vatRate, line.taxClassificationCode])).toEqual([
    ['book-it', 10, undefined],
    ['p-reduced', 12, REDUCED],
    ['p2', 21, STANDARD],
  ]);
  expect(order.totalMinor).toBe(row?.total);

  // Every order it took and confirmed while it kept serving: each line classified as the migration classifies it.
  const longRun = yield* adminPg.unsafe<{ readonly document: unknown; readonly total: number }>(
    `select document, total_minor::integer as total from demo_merchandise.orders
      where tenant_id = $1 and legal_entity_id = $2 and id = any($3::text[]) order by created_at`,
    [report.tenantId, report.companyId, report.longRun.orders],
  );
  expect(longRun.length).toBe(report.longRun.days);
  for (const stored of longRun) {
    const decoded = Schema.decodeUnknownSync(OrderSchema)(stored.document);
    expect([decoded.status, decoded.totalMinor]).toEqual(['CONFIRMED', stored.total]);
    expect(decoded.lines.map((line) => line.taxClassificationCode)).toEqual(
      decoded.lines.map((line) => lineClassification(line.vatRate)),
    );
  }
});

/**
 * Thirty days later: every invoice issued meanwhile confirmed with its lines classified and its amounts as issued, and
 * every invoice of the ledger (recurring ones included) with each 21 % and 12 % line classified.
 */
const checkLongRunLedger = (
  report: Report,
  invoices: FinanceState['invoices'],
  expectedLines: readonly (readonly unknown[])[],
) => {
  const invoiceOf = (id: string) => invoices.find((invoice) => invoice.ref.resourceId === id);
  expect(invoices.length).toBe(
    report.windowInvoiceIds.length + report.longRun.invoices.length + report.longRun.recurringPeriods.length,
  );
  for (const issued of report.longRun.invoices) {
    const invoice = invoiceOf(issued.id);
    expect([invoice?.businessState, classified(invoice?.lines ?? [])]).toEqual(['CONFIRMED', expectedLines]);
    expect({
      subtotalMinor: invoice?.subtotalMinor,
      totalMinor: invoice?.totalMinor,
      vatMinor: invoice?.vatMinor,
      vatRecap: invoice?.vatRecap,
    }).toEqual(issued.totals);
  }
  for (const invoice of invoices) {
    for (const line of invoice.lines ?? []) {
      expect([line.vatRate, line.vatClassification]).toEqual([line.vatRate, lineClassification(line.vatRate)]);
    }
  }
};

/** The ledger it rewrote four times: every 21 % and 12 % entry classified, every amount as stored. */
const checkLedger = Effect.fn('VatWindow.ledger')(function* checkLedger(report: Report, adminPg: PgClient.PgClient) {
  const [row] = yield* adminPg.unsafe<{ readonly revision: number; readonly state: unknown }>(
    `select revision, state from finance_billing.finance_states where tenant_id = $1 and legal_entity_id = $2`,
    [report.tenantId, report.companyId],
  );
  const { revision, state } = yield* decodeFinanceState(Schema.decodeUnknownSync(RowSchema)(row));
  expect(revision).toBe(report.financeRevision);
  const expectedLines = report.invoiceLines.map((line) => [line.vatRate, lineClassification(line.vatRate)]);
  const invoiceOf = (id: string | undefined) => state.invoices.find((invoice) => invoice.ref.resourceId === id);
  const draft = invoiceOf(report.issued.id);
  const generated = invoiceOf(report.windowInvoiceIds.find((id) => id !== report.issued.id));
  expect(classified(draft?.lines ?? [])).toEqual(expectedLines);
  // Issued with 21 %, 12 %, 10 % and 0 % lines: its amounts and VAT recap stay exactly as the old release issued them,
  // and its 10 % line keeps that rate as a fact, with no classification that could later claim 12 %.
  expect(draft?.businessState).toBe('CONFIRMED');
  expect({
    subtotalMinor: draft?.subtotalMinor,
    totalMinor: draft?.totalMinor,
    vatMinor: draft?.vatMinor,
    vatRecap: draft?.vatRecap,
  }).toEqual(report.issued.totals);
  expect(draft?.lines?.map((line) => [line.quantity, line.unitPriceMinor])).toEqual(
    report.invoiceLines.map((line) => [line.quantity, line.unitPriceMinor]),
  );
  expect(classified(generated?.lines ?? [])).toEqual(expectedLines.slice(0, 2));
  expect(classified(state.recurringTemplates?.[0]?.lines ?? [])).toEqual(expectedLines.slice(0, 2));
  expect(classified(state.priceList ?? [])).toEqual([[21, STANDARD]]);
  checkLongRunLedger(report, state.invoices, expectedLines);
});

const windowReport = Config.option(Config.String('ONTOS_VAT_WINDOW_REPORT'));

it.live('the new release reads every row the old release wrote in the window, complete and at its stored money', () =>
  Effect.scoped(
    Effect.gen(function* newReleaseReadsWindow() {
      const reportPath = yield* windowReport;
      if (Option.isNone(reportPath)) {
        return yield* Effect.logWarning('Not run: the VAT deploy rehearsal sets ONTOS_VAT_WINDOW_REPORT');
      }
      const report = Schema.decodeUnknownSync(Schema.fromJsonString(ReportSchema))(
        readFileSync(reportPath.value, 'utf-8'),
      );
      const connections = yield* loadDatabaseConnectionPair();
      const adminPg = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 2 });
      const db = yield* makeTestDatabaseFromClient(adminPg, merchandiseRelations);
      yield* checkProducts(report, db, adminPg);
      yield* checkOrder(report, adminPg);
      return yield* checkLedger(report, adminPg);
    }),
  ),
);
