// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * After the old release kept serving on the migrated database (`tests/vat-window.old-release.mts`, run by the
 * deploy rehearsal in a trunk checkout), the new release reads every row the old one wrote through its own store:
 * - each product decodes with its classification (column and document agree) and its net and gross exactly as the
 *   old release computed them; one created at 10 % is held at 10 %, so it keeps selling at that rate;
 * - the edited order decodes with every line classified as the migration classifies stored lines, its amounts as
 *   the old release stored them;
 * - the ledger the old release rewrote four times decodes with every 21 % and 12 % entry classified and every amount
 *   as stored.
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
  issued: Schema.Struct({
    id: Schema.String,
    totals: Schema.Struct({
      subtotalMinor: Schema.Number,
      totalMinor: Schema.Number,
      vatMinor: Schema.Number,
      vatRecap: Schema.Array(Schema.Struct({ baseMinor: Schema.Number, rate: Schema.Number, vatMinor: Schema.Number })),
    }),
  }),
  orderId: OrderIdSchema,
  products: Schema.Array(
    Schema.Struct({
      gross: Schema.optionalKey(Schema.Number),
      id: ProductIdSchema,
      net: Schema.optionalKey(Schema.Number),
      vatRate: Schema.Number,
    }),
  ),
  tenantId: TenantIdSchema,
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
  for (const written of report.products) {
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

  // The 10 % product the old release created is held at 10 % with BOOK-IT: the storefront sells it unchanged.
  const head = yield* loadHead(db, store);
  const held = heldRatesOf(head?.taxRates);
  expect(held).toEqual({ 'book-it': 10, [report.heldProductId]: 10 });
  const rates = sellableRatesOf(head?.taxRates, yield* DateTime.now);
  const heldProduct = products.find((entry) => entry.id === report.heldProductId);
  if (heldProduct === undefined) {
    return yield* Effect.die('The held product is missing');
  }
  const stock =
    hydrated.find(({ product }) => product.id === heldProduct.id)?.stock ?? stockLevelsOf([], heldProduct.id);
  const record = withStorefrontVat(toProductRecord(heldProduct, stock, rates), rates, held);
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
});

/** The ledger it rewrote four times: every 21 % and 12 % entry classified, every amount as stored. */
const checkLedger = Effect.fn('VatWindow.ledger')(function* checkLedger(report: Report, adminPg: PgClient.PgClient) {
  const [row] = yield* adminPg.unsafe<{ readonly revision: number; readonly state: unknown }>(
    `select revision, state from finance_billing.finance_states where tenant_id = $1 and legal_entity_id = $2`,
    [report.tenantId, report.companyId],
  );
  const { revision, state } = yield* decodeFinanceState(Schema.decodeUnknownSync(RowSchema)(row));
  expect(revision).toBe(report.financeRevision);
  const expectedLines = report.invoiceLines.map((line) => [line.vatRate, lineClassification(line.vatRate)]);
  const [draft, generated] = state.invoices;
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
