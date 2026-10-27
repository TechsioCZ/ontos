/// <reference lib="es2023" />
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Config,
  ConfigProvider,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Option,
  References,
  Schema,
  Tracer,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { Command, Flag } from 'effect/cli';
import { FinanceStateSchema, InvoiceLinesSchema } from '../shared/apis/records.ts';
import type { FinanceState } from '../shared/apis/records.ts';
import { computeInvoiceTotals, INVOICE_NUMBER_PREFIX } from '../shared/domain/invoice-totals.ts';
import { derivePaymentState } from '../src/services/persistence.service.ts';
import { financeStates, financeRelations } from '../src/database/schema.ts';
import { demoId, demoLegalEntityId, demoTenantId } from '../../../scripts/demo/fixture-ids.mts';
import { invoices as plannedInvoices, productByKey, snapshotPriceMinor } from '../../../scripts/demo/sales-plan.mts';
import type { PlannedInvoice } from '../../../scripts/demo/sales-plan.mts';
import { salesDemoCustomerCounterpartyId, salesDemoCustomers } from '../../party-registry/scripts/demo-customers.mts';

const FixtureSchema = Schema.Struct({
  legalEntityId: Schema.Literal('71000000-0000-4000-8000-000000000020'),
  state: FinanceStateSchema,
  tenantId: Schema.Literal('70000000-0000-4000-8000-000000000020'),
});
class ResetInputError extends Schema.TaggedError<ResetInputError>()('ResetInputError', { reason: Schema.String }) {}
const AdminDatabaseLive = Layer.effect(
  PgClient.PgClient,
  Effect.gen(function* adminClient() {
    const connection = yield* Config.schema(
      Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
      'DATABASE_ADMIN_URL',
    );
    return yield* PgClient.makeClient({ url: connection });
  }),
).pipe(Layer.provide(Reactivity.layer));

const writeState = Effect.fn('Finance.writeDemoState')(function* writeDemoState(input: typeof FixtureSchema.Type) {
  const state = yield* Schema.encodeEffect(FinanceStateSchema)(input.state);
  const db = yield* makeWithDefaults({ relations: financeRelations });
  const now = yield* DateTime.now;
  yield* db
    .insert(financeStates)
    .values({
      legalEntityId: input.legalEntityId,
      revision: 0,
      state,
      tenantId: input.tenantId,
      updatedAt: DateTime.toDateUtc(now),
    })
    .onConflictDoUpdate({
      set: { revision: 0, state, updatedAt: DateTime.toDateUtc(now) },
      target: [financeStates.tenantId, financeStates.legalEntityId],
    });
  yield* Console.log('Siampark finance demo state reset to revision 0');
});

const reset = Effect.fn('Finance.resetDemo')(function* resetDemo(fixturePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const input = yield* fs
    .readFileString(fixturePath)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FixtureSchema))));
  const refs = [
    ...input.state.invoices.flatMap((record) => [
      record.ref,
      record.counterpartyRef,
      record.propertyRef,
      record.unitRef,
      record.contractRef,
      record.occupancyRef,
      record.taskRef,
    ]),
    ...input.state.financialPlanEntries.flatMap((record) => [record.ref, record.propertyRef]),
  ];
  if (refs.some((ref) => ref !== undefined && ref.tenantId !== input.tenantId)) {
    return yield* new ResetInputError({ reason: 'Every fixture reference must match the fixed demo tenant' });
  }
  if (
    input.state.invoices.some(
      (invoice) =>
        invoice.paidMinor > invoice.totalMinor ||
        invoice.paymentState !== derivePaymentState(invoice.paidMinor, invoice.totalMinor) ||
        invoice.dueDate < invoice.issueDate ||
        (invoice.direction === 'INCOMING' &&
          invoice.businessState === 'CONFIRMED' &&
          invoice.propertyRef === undefined) ||
        (invoice.accountingSyncState === 'SYNCED' && invoice.externalAccountingReference === undefined),
    )
  ) {
    return yield* new ResetInputError({
      reason: 'Invoice payment, accounting, dates or supplier anchors are inconsistent',
    });
  }
  const invoiceIds = new Set(input.state.invoices.map((invoice) => invoice.ref.resourceId));
  if (
    invoiceIds.size !== input.state.invoices.length ||
    input.state.financialPlanEntries.some((entry) => entry.periodEndExclusive <= entry.periodStart)
  ) {
    return yield* new ResetInputError({
      reason: 'Fixture identities, observation references or plan periods are inconsistent',
    });
  }
  return yield* Layer.build(Layer.effectDiscard(writeState(input)).pipe(Layer.provide(AdminDatabaseLive))).pipe(
    Effect.scoped,
  );
});
// --- Sales demo (`--sales-demo`, called by app/scripts/demo/reset-demo.mts) -----------------------------------
// Deterministic: the same 30 invoices from the shared sales plan on every run, so a re-run replaces the row at revision 0.
// "Today" is the demo calendar date the work-tasks seed also anchors on; issue dates count back from it.
const salesDemoAnchorDay = DateTime.makeUnsafe('2026-10-13T12:00:00.000Z');
const salesDemoModuleId = 'finance.billing';
const salesDemoInvoiceResourceType = 'finance.billing.invoice';
const salesDemoPaymentTermDays = 14;
// Observations for paid amounts are dated a week after issue, capped at the anchor so nothing lands in the future.
const salesDemoPaymentDelayDays = 7;

/** Day `offsetDays` from the anchor (negative = past), at noon UTC so every formatter yields the same calendar date. */
const salesDemoDay = (offsetDays: number) => DateTime.add(salesDemoAnchorDay, { days: offsetDays });

/** IČO of the customer behind a plan key `cNN`, from the party-registry demo customer list. */
const salesDemoCustomerIco = (customerKey: string) => salesDemoCustomers[Number(customerKey.slice(1)) - 1]?.ico;

const salesDemoPaidMinor = (payment: PlannedInvoice['payment'], totalMinor: number): number => {
  if (payment === 'PAID') {
    return totalMinor;
  }
  return payment === 'PARTIALLY_PAID' ? Math.floor(totalMinor / 2) : 0;
};

const salesDemoInvoice = Effect.fn('ResetDemo.salesDemoInvoice')(function* salesDemoInvoice(
  planned: PlannedInvoice,
  documentNumber: string,
) {
  const ico = salesDemoCustomerIco(planned.customerKey);
  if (ico === undefined) {
    return yield* new ResetInputError({ reason: `Unknown demo customer ${planned.customerKey}` });
  }
  // Snapshot lines: price and VAT are frozen at the invoice's issue date and never re-read from the catalog.
  const lines = yield* Schema.decodeEffect(InvoiceLinesSchema)(
    yield* Effect.all(
      planned.lines.map((line) =>
        Effect.gen(function* plannedLine() {
          const product = yield* productByKey(line.productKey);
          return {
            description: product.name,
            productId: demoId('product', line.productKey),
            quantity: line.quantity,
            unitPriceMinor: snapshotPriceMinor(product, planned.issueDaysAgo),
            vatRate: product.vatRate,
          };
        }),
      ),
    ),
  );
  const totals = computeInvoiceTotals(lines);
  if (totals === undefined) {
    return yield* new ResetInputError({ reason: `Invoice ${planned.key} totals leave the bounded money range` });
  }
  const paidMinor = salesDemoPaidMinor(planned.payment, totals.totalMinor);
  if (derivePaymentState(paidMinor, totals.totalMinor) !== planned.payment) {
    return yield* new ResetInputError({ reason: `Invoice ${planned.key} payment does not match its paid amount` });
  }
  const issueDay = salesDemoDay(-planned.issueDaysAgo);
  // Only WON-linked invoices carry the opportunity; standalone invoices omit the key entirely.
  const opportunityFields =
    planned.opportunityKey === null ? undefined : { opportunityId: demoId('opportunity', planned.opportunityKey) };
  const paidAt = salesDemoDay(Math.min(-planned.issueDaysAgo + salesDemoPaymentDelayDays, 0));
  const resourceId = demoId('invoice', planned.key);
  const ref = {
    moduleId: salesDemoModuleId,
    resourceId,
    resourceType: salesDemoInvoiceResourceType,
    tenantId: demoTenantId,
  };
  const invoice = {
    accountingCorrelation: `demo-accounting:${resourceId}`,
    accountingSyncState: 'NOT_SYNCED',
    businessState: planned.state,
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: salesDemoCustomerCounterpartyId(ico),
      resourceType: 'party.registry.counterparty',
      tenantId: demoTenantId,
    },
    createdAt: DateTime.formatIso(issueDay),
    currency: 'CZK',
    direction: 'OUTGOING',
    documentNumber,
    dueDate: DateTime.formatIsoDateUtc(salesDemoDay(-planned.issueDaysAgo + salesDemoPaymentTermDays)),
    issueDate: DateTime.formatIsoDateUtc(issueDay),
    lines,
    number: documentNumber,
    ...opportunityFields,
    paidMinor,
    partyId: demoId('customer', planned.customerKey),
    paymentState: planned.payment,
    ref,
    subtotalMinor: totals.subtotalMinor,
    totalMinor: totals.totalMinor,
    updatedAt: DateTime.formatIso(paidMinor > 0 ? paidAt : issueDay),
    vatMinor: totals.vatMinor,
    vatRecap: totals.vatRecap,
  };
  return { invoice };
});

const summarizeSalesDemo = (state: FinanceState) => {
  const confirmed = state.invoices.filter((invoice) => invoice.businessState === 'CONFIRMED');
  const countPayment = (paymentState: FinanceState['invoices'][number]['paymentState']) =>
    confirmed.filter((invoice) => invoice.paymentState === paymentState).length;
  const drafts = state.invoices.length - confirmed.length;
  const grossMinor = confirmed.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
  const netMinor = confirmed.reduce((sum, invoice) => sum + (invoice.subtotalMinor ?? 0), 0);
  return `${state.invoices.length} invoices (confirmed ${confirmed.length}: paid ${countPayment('PAID')}, partially paid ${countPayment('PARTIALLY_PAID')}, unpaid ${countPayment('UNPAID')}; draft ${drafts}); confirmed revenue ${grossMinor / 100} CZK gross, ${netMinor / 100} CZK net`;
};

const seedSalesDemo = Effect.fn('ResetDemo.seedSalesDemo')(function* seedSalesDemo(validateOnly: boolean) {
  // Oldest first, so FV-2026-0001 is the earliest issue date.
  const ordered = plannedInvoices.toSorted(
    (left, right) => right.issueDaysAgo - left.issueDaysAgo || left.key.localeCompare(right.key),
  );
  const built = yield* Effect.all(
    ordered.map((planned, index) =>
      salesDemoInvoice(planned, `${INVOICE_NUMBER_PREFIX}${String(index + 1).padStart(4, '0')}`),
    ),
  );
  const state = yield* Schema.decodeUnknownEffect(FinanceStateSchema)({
    financialPlanEntries: [],
    invoices: built.map((entry) => entry.invoice),
  });
  const summary = summarizeSalesDemo(state);
  if (validateOnly) {
    return yield* Console.log(`finance-billing sales-demo validated: ${summary}; no data changed.`);
  }
  yield* Layer.build(
    Layer.effectDiscard(writeState({ legalEntityId: demoLegalEntityId, state, tenantId: demoTenantId })).pipe(
      Layer.provide(AdminDatabaseLive),
    ),
  ).pipe(Effect.scoped);
  return yield* Console.log(`finance-billing sales-demo seeded: ${summary}`);
});

// `--sales-demo` seeds the invoices; `--validate-only` builds and checks them without writing.
// DATABASE_ADMIN_URL must be configured because the admin database layer is read when the database is opened.
const command = Command.make(
  'finance-billing-reset',
  {
    fixture: Flag.String('fixture').pipe(Flag.optional),
    salesDemo: Flag.Boolean('sales-demo').pipe(Flag.withDefault(false)),
    validateOnly: Flag.Boolean('validate-only').pipe(Flag.withDefault(false)),
  },
  ({ fixture, salesDemo, validateOnly }) =>
    Effect.gen(function* resetFromFlags() {
      if (salesDemo) {
        return yield* seedSalesDemo(validateOnly);
      }
      return yield* Option.match(fixture, {
        onNone: () => Effect.fail(new ResetInputError({ reason: '--fixture is required' })),
        onSome: reset,
      });
    }),
);
const main = Command.run(command, { version: '1.0.0' });
const resetProgram = Layer.effectDiscard(main).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
      Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
      Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      Layer.succeed(References.MinimumLogLevel, 'Info'),
    ),
  ),
);
NodeRuntime.runMain(Layer.build(resetProgram).pipe(Effect.scoped));
