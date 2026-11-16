/*
 * The imported-payment-records migration on PostgreSQL, run on a private temporary copy of the Finance state table
 * inside one transaction (the shared database is never migrated). Every ledger is a complete Finance ledger encoded
 * by `FinanceStateSchema`, and every ledger the migration leaves is decoded by it again. The two stage ledgers are
 * modelled as they are: a sales ledger of 30 invoices with no payment list whose 24 paid balances become records, and a
 * ledger of 14 invoices whose 9 payment records already explain every paid amount, which stays byte for byte as it is,
 * revision included. What the migration writes is exactly what `withImportedPaymentRecords` writes for the same ledger.
 * Timestamps Finance reads (date only, no offset, an offset across midnight, a finer fraction) are dated as Finance
 * dates them; a timestamp it cannot convert, a taken record id and a ledger past 5,000 records refuse the whole
 * migration, naming the company, before anything is written. A second run changes nothing.
 */
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Cause, DateTime, Effect, Exit, FileSystem, Path, Predicate, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { FinanceInvoiceResourceIdSchema, FinanceStateSchema } from '../../shared/apis/records.ts';
import type { FinanceState, Invoice, ManualPayment } from '../../shared/apis/records.ts';
import { withImportedPaymentRecords } from '../../shared/domain/finance-planning.ts';

const MIGRATION = 'drizzle/20261116003317_imported-payment-records/migration.sql';
const PROBE_TABLE = 'pg_temp.finance_states_payment_probe';

type EncodedState = typeof FinanceStateSchema.Encoded;
interface Ledger {
  readonly legalEntityId: string;
  readonly name: string;
  readonly revision: number;
  readonly state: EncodedState;
  readonly tenantId: string;
}

const company = (index: number) => ({
  legalEntityId: `b0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  tenantId: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
});
const at = (instant: string) => DateTime.makeUnsafe(instant);
const invoice = (tenantId: string, id: string, overrides: Partial<Invoice> = {}): Invoice => ({
  accountingCorrelation: `acc-${id}`,
  accountingSyncState: 'NOT_SYNCED',
  businessState: 'CONFIRMED',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'c0000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  createdAt: at('2025-12-01T09:00:00.000Z'),
  currency: 'CZK',
  direction: 'OUTGOING',
  documentNumber: `FV-${id}`,
  dueDate: '2026-12-31',
  issueDate: '2025-12-01',
  paidMinor: 0,
  paymentState: 'UNPAID',
  ref: { moduleId: 'finance.billing', resourceId: id, resourceType: 'finance.billing.invoice', tenantId },
  totalMinor: 121_000,
  updatedAt: at('2025-12-01T09:00:00.000Z'),
  ...overrides,
});
const record = (invoiceId: string, id: string, amountMinor: number, paidOn: string): ManualPayment => ({
  amountMinor,
  id,
  invoiceResourceId: Schema.decodeSync(FinanceInvoiceResourceIdSchema)(invoiceId),
  paidOn,
  recordedAt: at(`${paidOn}T10:00:00.000Z`),
});
const encode = (state: FinanceState): EncodedState => Schema.encodeSync(FinanceStateSchema)(state);
const ledger = (index: number, name: string, revision: number, state: FinanceState): Ledger => ({
  ...company(index),
  name,
  revision,
  state: encode(state),
});
/** The ledger with one invoice's stored `updatedAt` replaced by a value Finance may hold. */
const withStamp = (entry: Ledger, invoiceId: string, updatedAt: string): Ledger => ({
  ...entry,
  state: {
    ...entry.state,
    invoices: entry.state.invoices.map((stored) =>
      stored.ref.resourceId === invoiceId ? { ...stored, updatedAt } : stored,
    ),
  },
});

// Stage ledger A: 30 invoices, 24 of them paid (18 in full, 6 in half) between 2025-12-06 and 2026-10-13, no list.
const importDays = Array.from({ length: 24 }, (_, index) =>
  DateTime.formatIsoDateUtc(DateTime.add(at('2025-12-06T12:00:00.000Z'), { days: Math.round((index * 311) / 23) })),
);
const salesTenant = company(1).tenantId;
const salesLedger = ledger(1, 'sales ledger with paid balances and no payment list', 5, {
  financialPlanEntries: [],
  invoices: Array.from({ length: 30 }, (_, index) => {
    const id = `sales-${String(index + 1).padStart(2, '0')}`;
    const day = importDays[index];
    if (day === undefined) {
      return invoice(salesTenant, id, { updatedAt: at('2026-10-13T12:00:00.000Z') });
    }
    const half = index % 4 === 3;
    return invoice(salesTenant, id, {
      paidMinor: half ? 60_500 : 121_000,
      paymentState: half ? 'PARTIALLY_PAID' : 'PAID',
      updatedAt: at(`${day}T12:00:00.000Z`),
    });
  }),
});
// Stage ledger B: 14 invoices, 9 paid, each paid amount explained by its own payment record.
const recordedTenant = company(2).tenantId;
const recordedLedger = ledger(2, 'ledger whose payment records explain every paid amount', 75, {
  financialPlanEntries: [],
  invoices: Array.from({ length: 14 }, (_, index) =>
    index < 9
      ? invoice(recordedTenant, `rec-${index + 1}`, { paidMinor: 121_000, paymentState: 'PAID' })
      : invoice(recordedTenant, `rec-${index + 1}`),
  ),
  manualPayments: Array.from({ length: 9 }, (_, index) =>
    record(`rec-${index + 1}`, `payment-${index + 1}`, 121_000, '2026-01-15'),
  ),
});
// Timestamps Finance reads besides a plain UTC instant.
const oddTenant = company(3).tenantId;
const oddStamps = [
  ['date-only', '2026-09-10', '2026-09-10'],
  ['no-offset', '2026-09-10T12:00:00', '2026-09-10'],
  ['offset-past-midnight', '2026-09-10T23:30:00-02:00', '2026-09-11'],
  ['finer-fraction', '2026-09-10T23:59:59.9999999Z', '2026-09-10'],
] as const;
const oddBase = ledger(3, 'ledger with timestamps Finance reads', 3, {
  financialPlanEntries: [],
  invoices: oddStamps.map(([id]) => invoice(oddTenant, id, { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' })),
});
const oddStampOf = new Map<string, string>(oddStamps.map(([id, stamp]) => [id, stamp]));
const oddLedger: Ledger = {
  ...oddBase,
  state: {
    ...oddBase.state,
    invoices: oddBase.state.invoices.map((stored) => ({
      ...stored,
      updatedAt: oddStampOf.get(stored.ref.resourceId) ?? stored.updatedAt,
    })),
  },
};
// 4,999 records and one import: exactly 5,000 records after the migration.
const limitTenant = company(4).tenantId;
const limitState = (extra: number): FinanceState => ({
  financialPlanEntries: [],
  invoices: [
    invoice(limitTenant, 'many', { paidMinor: 4999, paymentState: 'PARTIALLY_PAID' }),
    ...Array.from({ length: extra }, (_, index) =>
      invoice(limitTenant, `one-${index + 1}`, { paidMinor: 100, paymentState: 'PARTIALLY_PAID' }),
    ),
  ],
  manualPayments: Array.from({ length: 4999 }, (_, index) => record('many', `many-${index + 1}`, 1, '2026-02-01')),
});
const limitLedger = ledger(4, 'ledger reaching exactly 5000 payment records', 9, limitState(1));

const refusals: readonly { readonly ledger: Ledger; readonly name: string; readonly problem: string }[] = [
  {
    ledger: withStamp(
      ledger(5, 'invalid calendar date', 2, {
        financialPlanEntries: [],
        invoices: [invoice(company(5).tenantId, 'feb-30', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' })],
      }),
      'feb-30',
      '2026-02-30T12:00:00Z',
    ),
    name: 'a timestamp Finance reads but PostgreSQL cannot convert',
    problem: 'invoice feb-30 cannot become a payment record: its updatedAt cannot be read as an instant',
  },
  {
    ledger: ledger(6, 'taken record id', 2, {
      financialPlanEntries: [],
      invoices: [
        invoice(company(6).tenantId, 'paid', { paidMinor: 1000, paymentState: 'PARTIALLY_PAID' }),
        invoice(company(6).tenantId, 'other', { paidMinor: 500, paymentState: 'PARTIALLY_PAID' }),
      ],
      manualPayments: [record('other', 'paid:import', 500, '2026-03-01')],
    }),
    name: 'a record id that is already taken',
    problem: 'invoice paid cannot become a payment record: a payment record already has the id paid:import',
  },
  {
    ledger: ledger(7, 'one record past the limit', 9, limitState(2)),
    name: 'a ledger past 5000 payment records',
    problem: 'cannot become a payment record: the ledger would hold more than 5000 payment records',
  },
];

const StoredRowsSchema = Schema.Array(
  Schema.Struct({ name: Schema.String, revision: Schema.Number, state: Schema.Unknown, text: Schema.String }),
);

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  const inner = Predicate.hasProperty(error, 'cause') ? error.cause : undefined;
  // The PostgreSQL error the driver wraps carries the RAISE text as its message.
  return Predicate.hasProperty(inner, 'message') && Predicate.isString(inner.message) ? inner.message : String(error);
};

/** The probe holding `ledgers`, the migration run `runs` times (each in its own savepoint), and what is stored then. */
const migrateProbe = Effect.fn('ImportedPaymentRecordsMigration.probe')(function* migrateProbe(
  probe: readonly string[],
  ledgers: readonly Ledger[],
  runs: number,
) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
  );
  return yield* admin.withTransaction(
    Effect.gen(function* inTransaction() {
      yield* admin.unsafe(
        `create temp table finance_states_payment_probe (name text primary key, tenant_id uuid not null,
           legal_entity_id uuid not null, revision integer not null, state jsonb not null) on commit drop`,
      );
      for (const entry of ledgers) {
        yield* admin.unsafe(
          `insert into ${PROBE_TABLE} (name, tenant_id, legal_entity_id, revision, state) values ($1, $2, $3, $4, $5::jsonb)`,
          [
            entry.name,
            entry.tenantId,
            entry.legalEntityId,
            entry.revision,
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(entry.state),
          ],
        );
      }
      const before = yield* admin.unsafe(`select name, revision, state, state::text as text from ${PROBE_TABLE}`);
      const failures: string[] = [];
      for (let run = 0; run < runs; run += 1) {
        yield* admin.unsafe('savepoint migration_run');
        // One statement per query, as the migrator sends them.
        const outcome = yield* Effect.exit(
          Effect.forEach(probe, (statement) => admin.unsafe(statement), { discard: true }),
        );
        if (Exit.isFailure(outcome)) {
          failures.push(messageOf(outcome.cause));
          yield* admin.unsafe('rollback to savepoint migration_run');
        } else {
          yield* admin.unsafe('release savepoint migration_run');
        }
      }
      const after = yield* admin.unsafe(`select name, revision, state, state::text as text from ${PROBE_TABLE}`);
      return {
        after: yield* Schema.decodeUnknownEffect(StoredRowsSchema)(after),
        before: yield* Schema.decodeUnknownEffect(StoredRowsSchema)(before),
        failures,
      };
    }),
  );
});

const loadProbe = Effect.fn('ImportedPaymentRecordsMigration.load')(function* loadProbe() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const migration = yield* fs.readFileString(path.join(import.meta.dirname, '..', '..', MIGRATION));
  expect(migration).toContain('"finance_billing"."finance_states"');
  // No trigger and no function outlives the migration; every check runs before the only write.
  expect(migration).not.toMatch(/CREATE (?:FUNCTION|TRIGGER)/u);
  expect(migration.indexOf('RAISE EXCEPTION')).toBeLessThan(migration.indexOf('UPDATE "finance_billing"'));
  expect(migration.match(/UPDATE /gu)?.length).toBe(1);
  // The table becomes the probe.
  const probe = migration.replaceAll('"finance_billing"."finance_states"', PROBE_TABLE);
  expect(probe).not.toContain('finance_billing');
  return probe.split('--> statement-breakpoint');
});

const byName = (rows: typeof StoredRowsSchema.Type) => new Map(rows.map((row) => [row.name, row]));
const decodeLedger = Schema.decodeUnknownEffect(FinanceStateSchema);

it.layer(NodeServices.layer, { excludeTestServices: true })('Imported payment records migration', (suite) => {
  suite.effect(
    'records the unexplained paid part of every invoice as the app does, changes nothing else, and runs once',
    () =>
      Effect.scoped(
        Effect.gen(function* importedPaymentRecordsMigration() {
          const probe = yield* loadProbe();
          const ledgers = [salesLedger, recordedLedger, oddLedger, limitLedger];
          const { after, before, failures } = yield* migrateProbe(probe, ledgers, 2);
          expect(failures).toEqual([]);
          const stored = byName(after);
          const original = byName(before);
          // Every ledger stays readable, and a changed one holds exactly what the app's own rule writes.
          for (const entry of ledgers) {
            const row = stored.get(entry.name);
            const decoded = yield* decodeLedger(row?.state);
            const expected = yield* withImportedPaymentRecords(yield* decodeLedger(entry.state));
            expect([entry.name, decoded]).toEqual([entry.name, expected]);
          }
          // A: the list is created with its 24 records, and the revision goes up once over two runs.
          const sales = yield* decodeLedger(stored.get(salesLedger.name)?.state);
          expect(salesLedger.state.manualPayments).toBeUndefined();
          expect(sales.manualPayments?.map((entry) => [entry.id, entry.paidOn, entry.source])).toEqual(
            importDays.map((day, index) => [`sales-${String(index + 1).padStart(2, '0')}:import`, day, 'IMPORT']),
          );
          expect(sales.manualPayments?.at(0)?.paidOn).toBe('2025-12-06');
          expect(sales.manualPayments?.at(-1)?.paidOn).toBe('2026-10-13');
          expect(stored.get(salesLedger.name)?.revision).toBe(6);
          // B: byte for byte as stored, revision unchanged.
          expect(stored.get(recordedLedger.name)?.text).toBe(original.get(recordedLedger.name)?.text);
          expect(stored.get(recordedLedger.name)?.revision).toBe(75);
          // Odd timestamps are dated on the UTC day Finance reads them as.
          const odd = yield* decodeLedger(stored.get(oddLedger.name)?.state);
          expect(odd.manualPayments?.map((entry) => [entry.invoiceResourceId, entry.paidOn])).toEqual(
            oddStamps.map(([id, , day]) => [id, day]),
          );
          expect(stored.get(oddLedger.name)?.revision).toBe(4);
          // Exactly 5,000 records is still a readable ledger.
          const limit = yield* decodeLedger(stored.get(limitLedger.name)?.state);
          expect(limit.manualPayments?.length).toBe(5000);
          expect(stored.get(limitLedger.name)?.revision).toBe(10);
        }),
      ),
    120_000,
  );

  for (const refusal of refusals) {
    suite.effect(
      `refuses ${refusal.name}, naming the company, and writes no ledger`,
      () =>
        Effect.scoped(
          Effect.gen(function* refusedMigration() {
            const probe = yield* loadProbe();
            const { after, before, failures } = yield* migrateProbe(probe, [salesLedger, refusal.ledger], 1);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toContain(
              `Finance ledger of tenant ${refusal.ledger.tenantId} company ${refusal.ledger.legalEntityId}`,
            );
            expect(failures[0]).toContain(refusal.problem);
            // The ledger it could change is untouched as well.
            const stored = byName(after);
            for (const row of before) {
              expect([row.name, stored.get(row.name)?.revision, stored.get(row.name)?.text]).toEqual([
                row.name,
                row.revision,
                row.text,
              ]);
            }
          }),
        ),
      120_000,
    );
  }
});
