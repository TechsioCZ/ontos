/*
 * The imported-payment-records migration on PostgreSQL, run on a private temporary copy of the Finance state table
 * inside one transaction (the shared database is never migrated). Its rows follow what Finance holds: a sales ledger
 * seeded with paid and partially paid invoices and no payment records, a ledger whose payments a user recorded (one of
 * them only in part) with an advance taken into account, a company with no ledger content, and a row with every odd
 * stored value the migration might meet. The only change allowed is appending one IMPORT payment record for the part of
 * an invoice's paid amount no record explains; everything stored stays as it is. Its functions and trigger are created
 * in the session's own schema, so nothing outlives the test. The release still serving rewrites a whole ledger without
 * the `source` it does not know, or from a ledger it read before the backfill: the trigger keeps the IMPORT records.
 */
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Effect, FileSystem, Path, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

const MIGRATION = 'drizzle/20261116003317_imported-payment-records/migration.sql';
const PROBE_TABLE = 'pg_temp.finance_states_payment_probe';

interface Ledger {
  readonly after: string;
  readonly before: string;
  readonly name: string;
  /** What the release still serving writes over the migrated ledger, and what the row holds after that write. */
  readonly staleWrite?: { readonly kept: string; readonly written: string };
}

const salesInvoices = `[
  {"ref":{"resourceId":"inv-paid"},"businessState":"CONFIRMED","paidMinor":242000,"totalMinor":242000,
   "updatedAt":"2026-09-22T12:00:00.000Z"},
  {"ref":{"resourceId":"inv-half"},"businessState":"CONFIRMED","paidMinor":60500,"totalMinor":121001,
   "updatedAt":"2026-10-13T12:00:00.000Z"},
  {"ref":{"resourceId":"inv-unpaid"},"businessState":"CONFIRMED","paidMinor":0,"totalMinor":50000,
   "updatedAt":"2026-10-01T12:00:00.000Z"},
  {"ref":{"resourceId":"inv-draft"},"businessState":"DRAFT","paidMinor":0,"totalMinor":10000,
   "updatedAt":"2026-10-02T12:00:00.000Z"}]`;
const salesImports = `[
  {"amountMinor":242000,"id":"inv-paid:import","invoiceResourceId":"inv-paid","paidOn":"2026-09-22",
   "recordedAt":"2026-09-22T12:00:00.000Z","source":"IMPORT"},
  {"amountMinor":60500,"id":"inv-half:import","invoiceResourceId":"inv-half","paidOn":"2026-10-13",
   "recordedAt":"2026-10-13T12:00:00.000Z","source":"IMPORT"}]`;
const editedSalesInvoices = salesInvoices.replace('"2026-09-22T12:00:00.000Z"', '"2026-11-16T09:00:00.000Z"');

const ledgers: readonly Ledger[] = [
  {
    after: `{"financialPlanEntries":[],"invoices":${salesInvoices},"manualPayments":${salesImports}}`,
    before: `{"financialPlanEntries":[],"invoices":${salesInvoices}}`,
    name: 'sales ledger seeded with paid balances and no payment records',
    // The old release edits the paid invoice from the ledger it read before the backfill: no records at all.
    staleWrite: {
      kept: `{"financialPlanEntries":[],"invoices":${editedSalesInvoices},"manualPayments":${salesImports}}`,
      written: `{"financialPlanEntries":[],"invoices":${editedSalesInvoices}}`,
    },
  },
  {
    after: `{"financialPlanEntries":[],"invoices":[
      {"ref":{"resourceId":"adv"},"businessState":"CONFIRMED","paidMinor":30000,"updatedAt":"2026-08-01T10:00:00.000Z"},
      {"ref":{"resourceId":"fin"},"businessState":"CONFIRMED","paidMinor":80000,"updatedAt":"2026-09-20T21:30:00+00:00",
       "priorSettlement":{"confirmedAt":"2026-09-01T10:00:00.000Z","entries":[{"amountMinor":30000,"invoiceResourceId":"adv","number":"ZF-1"}]}},
      {"ref":{"resourceId":"part"},"businessState":"CONFIRMED","paidMinor":60000,"updatedAt":"2026-09-30T22:30:00-02:00"},
      {"ref":{"resourceId":"full"},"businessState":"CONFIRMED","paidMinor":100000,"updatedAt":"2026-09-30T10:00:00.000Z"}],
      "manualPayments":[
        {"amountMinor":30000,"id":"u-adv","invoiceResourceId":"adv","paidOn":"2026-08-01","recordedAt":"2026-08-01T10:00:00.000Z"},
        {"amountMinor":20000,"id":"u-part","invoiceResourceId":"part","paidOn":"2026-09-05","recordedAt":"2026-09-05T10:00:00.000Z",
         "actorLabel":"Účetní"},
        {"amountMinor":100000,"id":"u-full","invoiceResourceId":"full","paidOn":"2026-09-06","recordedAt":"2026-09-06T10:00:00.000Z"},
        {"amountMinor":50000,"id":"fin:import","invoiceResourceId":"fin","paidOn":"2026-09-20",
         "recordedAt":"2026-09-20T21:30:00+00:00","source":"IMPORT"},
        {"amountMinor":40000,"id":"part:import","invoiceResourceId":"part","paidOn":"2026-10-01",
         "recordedAt":"2026-09-30T22:30:00-02:00","source":"IMPORT"}]}`,
    before: `{"financialPlanEntries":[],"invoices":[
      {"ref":{"resourceId":"adv"},"businessState":"CONFIRMED","paidMinor":30000,"updatedAt":"2026-08-01T10:00:00.000Z"},
      {"ref":{"resourceId":"fin"},"businessState":"CONFIRMED","paidMinor":80000,"updatedAt":"2026-09-20T21:30:00+00:00",
       "priorSettlement":{"confirmedAt":"2026-09-01T10:00:00.000Z","entries":[{"amountMinor":30000,"invoiceResourceId":"adv","number":"ZF-1"}]}},
      {"ref":{"resourceId":"part"},"businessState":"CONFIRMED","paidMinor":60000,"updatedAt":"2026-09-30T22:30:00-02:00"},
      {"ref":{"resourceId":"full"},"businessState":"CONFIRMED","paidMinor":100000,"updatedAt":"2026-09-30T10:00:00.000Z"}],
      "manualPayments":[
        {"amountMinor":30000,"id":"u-adv","invoiceResourceId":"adv","paidOn":"2026-08-01","recordedAt":"2026-08-01T10:00:00.000Z"},
        {"amountMinor":20000,"id":"u-part","invoiceResourceId":"part","paidOn":"2026-09-05","recordedAt":"2026-09-05T10:00:00.000Z",
         "actorLabel":"Účetní"},
        {"amountMinor":100000,"id":"u-full","invoiceResourceId":"full","paidOn":"2026-09-06","recordedAt":"2026-09-06T10:00:00.000Z"}]}`,
    name: 'ledger with user payments, one recorded only in part, and an advance taken into account',
  },
  {
    after: '{"financialPlanEntries":[],"invoices":[]}',
    before: '{"financialPlanEntries":[],"invoices":[]}',
    name: 'company with no ledger content',
  },
  {
    after: `{"financialPlanEntries":[],"invoices":[
      {"ref":{"resourceId":"odd-1"},"businessState":"CONFIRMED","paidMinor":"100","updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-2"},"businessState":"CONFIRMED","paidMinor":100.5,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-3"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"včera"},
      {"ref":{"resourceId":"odd-4"},"businessState":"CONFIRMED","paidMinor":100},
      {"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-5"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z",
       "priorSettlement":{"entries":"none"}},
      {"ref":{"resourceId":"odd-6"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z",
       "priorSettlement":{"entries":[{"amountMinor":"40"}]}},
      {"ref":{"resourceId":"odd-7"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"over"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"void"},"businessState":"VOIDED","paidMinor":100,"updatedAt":"2026-09-02T10:00:00.000Z",
       "priorSettlement":{"entries":[{"amountMinor":100}]}},
      "not an invoice"],
      "manualPayments":[{"amountMinor":"x","invoiceResourceId":"odd-7"},{"amountMinor":300,"invoiceResourceId":"over"},
        "not a payment"]}`,
    before: `{"financialPlanEntries":[],"invoices":[
      {"ref":{"resourceId":"odd-1"},"businessState":"CONFIRMED","paidMinor":"100","updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-2"},"businessState":"CONFIRMED","paidMinor":100.5,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-3"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"včera"},
      {"ref":{"resourceId":"odd-4"},"businessState":"CONFIRMED","paidMinor":100},
      {"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"odd-5"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z",
       "priorSettlement":{"entries":"none"}},
      {"ref":{"resourceId":"odd-6"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z",
       "priorSettlement":{"entries":[{"amountMinor":"40"}]}},
      {"ref":{"resourceId":"odd-7"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"over"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"},
      {"ref":{"resourceId":"void"},"businessState":"VOIDED","paidMinor":100,"updatedAt":"2026-09-02T10:00:00.000Z",
       "priorSettlement":{"entries":[{"amountMinor":100}]}},
      "not an invoice"],
      "manualPayments":[{"amountMinor":"x","invoiceResourceId":"odd-7"},{"amountMinor":300,"invoiceResourceId":"over"},
        "not a payment"]}`,
    name: 'unknown ledger with every odd stored value',
  },
  {
    after: `{"financialPlanEntries":[],"manualPayments":null,"invoices":[
      {"ref":{"resourceId":"x"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"}]}`,
    before: `{"financialPlanEntries":[],"manualPayments":null,"invoices":[
      {"ref":{"resourceId":"x"},"businessState":"CONFIRMED","paidMinor":100,"updatedAt":"2026-09-01T10:00:00.000Z"}]}`,
    name: 'ledger whose payment list is not a list',
  },
  {
    after: '{"financialPlanEntries":[],"invoices":"legacy"}',
    before: '{"financialPlanEntries":[],"invoices":"legacy"}',
    name: 'ledger whose invoices are not a list',
  },
];

const ComparisonSchema = Schema.Array(
  Schema.Struct({
    kept_wanted: Schema.Boolean,
    name: Schema.String,
    revision: Schema.Number,
    stripped_restored: Schema.Boolean,
    unchanged_by_new_write: Schema.Boolean,
    wanted: Schema.Boolean,
  }),
);

const migrateProbe = Effect.fn('ImportedPaymentRecordsMigration.probe')(function* migrateProbe(probe: string) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) }).pipe(
    Effect.provideService(Reactivity.Reactivity, yield* Reactivity.make),
  );
  return yield* admin.withTransaction(
    Effect.gen(function* inTransaction() {
      // A session-private table of the same shape, dropped with the transaction.
      yield* admin.unsafe(
        `create temp table finance_states_payment_probe (tenant_id uuid, legal_entity_id uuid, name text,
           revision integer, state jsonb not null, wanted jsonb not null, written jsonb, kept jsonb) on commit drop`,
      );
      for (const ledger of ledgers) {
        yield* admin.unsafe(
          `insert into ${PROBE_TABLE} (tenant_id, legal_entity_id, name, revision, state, wanted, written, kept)
           values (gen_random_uuid(), gen_random_uuid(), $1, 7, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb)`,
          [
            ledger.name,
            ledger.before,
            ledger.after,
            ledger.staleWrite?.written ?? null,
            ledger.staleWrite?.kept ?? null,
          ],
        );
      }
      // One statement per query, as the migrator sends them.
      for (const statement of probe.split('--> statement-breakpoint')) {
        yield* admin.unsafe(statement);
      }
      yield* admin.unsafe(
        `create temp table finance_states_payment_once on commit drop as select name, state from ${PROBE_TABLE}`,
      );
      // The new release writes each ledger as it reads it: the trigger changes nothing.
      yield* admin.unsafe(`update ${PROBE_TABLE} set state = state`);
      yield* admin.unsafe(
        `create temp table finance_states_payment_rewritten on commit drop as select name, state from ${PROBE_TABLE}`,
      );
      // The old release rewrites each ledger without the `source` it does not know: the trigger restores it.
      yield* admin.unsafe(
        `update ${PROBE_TABLE}
            set state = state || jsonb_build_object('manualPayments', (
                  select jsonb_agg(case when jsonb_typeof(payment) = 'object' then payment - 'source' else payment end
                                   order by position)
                    from jsonb_array_elements(state -> 'manualPayments') with ordinality as entries(payment, position)))
          where jsonb_typeof(state -> 'manualPayments') = 'array'`,
      );
      yield* admin.unsafe(
        `create temp table finance_states_payment_stripped on commit drop as select name, state from ${PROBE_TABLE}`,
      );
      // The old release writes from a ledger it read before the backfill: the trigger keeps the IMPORT records.
      yield* admin.unsafe(`update ${PROBE_TABLE} set state = written where written is not null`);
      return yield* admin.unsafe(
        `select probe.name, probe.revision, once.state = probe.wanted as wanted,
                rewritten.state = once.state as unchanged_by_new_write,
                stripped.state = once.state as stripped_restored,
                coalesce(probe.state = probe.kept, probe.state = once.state) as kept_wanted
           from ${PROBE_TABLE} as probe
           join pg_temp.finance_states_payment_once as once using (name)
           join pg_temp.finance_states_payment_rewritten as rewritten using (name)
           join pg_temp.finance_states_payment_stripped as stripped using (name)
          order by probe.name`,
      );
    }),
  );
});

it.layer(NodeServices.layer, { excludeTestServices: true })('Imported payment records migration', (suite) => {
  suite.effect(
    'records the unexplained paid part of every invoice once, dated as stored, and changes nothing else',
    () =>
      Effect.scoped(
        Effect.gen(function* importedPaymentRecordsMigration() {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const migration = yield* fs.readFileString(path.join(import.meta.dirname, '..', '..', MIGRATION));
          expect(migration).toContain('"finance_billing"."finance_states"');
          // Every function it creates runs with a fixed search path.
          const created = migration.split('CREATE FUNCTION').slice(1);
          expect(created.length).toBe(6);
          expect(created.filter((body) => !body.includes('SET search_path = pg_catalog, pg_temp'))).toEqual([]);
          // The table becomes the probe; the functions and the trigger live in this session's own schema.
          const probe = migration
            .replaceAll('"finance_billing"."finance_states"', PROBE_TABLE)
            .replaceAll('"finance_billing".', 'pg_temp.');
          expect(probe).not.toContain('finance_billing');
          const rows = yield* Schema.decodeUnknownEffect(ComparisonSchema)(yield* migrateProbe(probe));
          expect(rows.map((row) => row.name).toSorted()).toEqual(ledgers.map((ledger) => ledger.name).toSorted());
          for (const row of rows) {
            expect([row.name, row.wanted, row.unchanged_by_new_write, row.stripped_restored, row.kept_wanted]).toEqual([
              row.name,
              true,
              true,
              true,
              true,
            ]);
            // The Finance revision the next command names is untouched.
            expect(row.revision).toBe(7);
          }
        }),
      ),
    60_000,
  );
});
