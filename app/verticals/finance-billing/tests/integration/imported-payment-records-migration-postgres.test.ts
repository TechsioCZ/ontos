/*
 * The imported-payment-records migration on PostgreSQL, run on a private temporary copy of the Finance state table
 * inside one transaction (the shared database is never migrated). The ledgers (`imported-payment-records-fixtures.ts`)
 * are stored JSON, written to the table as they are: complete Finance ledgers, and for the refusals stored values Finance
 * never writes but reads. Every ledger the migration leaves is decoded by `FinanceStateSchema`. The two stage ledgers are
 * modelled as they are: a sales ledger of 30 invoices with no payment list whose 24 paid balances become records, and a
 * ledger of 14 invoices whose 9 payment records already explain every paid amount, which stays byte for byte as it is,
 * revision included. What the migration writes is exactly what `withImportedPaymentRecords` writes for the same ledger.
 * Timestamps Finance reads (date only, no offset, an offset across midnight, a finer fraction) are dated as Finance
 * dates them; a timestamp it cannot convert, an invoice reference Finance would read back trimmed (a tab, padding),
 * a taken record id and a ledger past 5,000 records refuse the whole
 * migration, naming the company, before anything is written. A second run changes nothing.
 */
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Cause, Effect, Exit, FileSystem, Option, Path, Predicate, Redacted, Schema } from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import { withImportedPaymentRecords } from '../../shared/domain/finance-planning.ts';
import {
  MIGRATION,
  PROBE_TABLE,
  acceptedLedgers,
  limitLedger,
  oddStampLedger,
  oddStamps,
  probeStatements,
  recordedLedger,
  refusals,
  salesImportDays,
  salesLedger,
} from './imported-payment-records-fixtures.ts';
import type { StoredLedger } from './imported-payment-records-fixtures.ts';

const StoredRowsSchema = Schema.Array(
  Schema.Struct({ name: Schema.String, revision: Schema.Number, text: Schema.String }),
);

/** The driver's message and the PostgreSQL error it wraps, which carries the RAISE text. */
const messageOf = (error: SqlError): string => {
  const { cause } = error.reason;
  return [
    error.message,
    error.reason.message,
    Predicate.hasProperty(cause, 'message') && Predicate.isString(cause.message) ? cause.message : '',
  ].join('\n');
};

/** The probe holding `ledgers`, the migration run `runs` times (each in its own savepoint), and what is stored then. */
const migrateProbe = Effect.fn('ImportedPaymentRecordsMigration.probe')(function* migrateProbe(
  probe: readonly string[],
  ledgers: readonly StoredLedger[],
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
      const before = yield* admin.unsafe(`select name, revision, state::text as text from ${PROBE_TABLE}`);
      const failures: string[] = [];
      for (let run = 0; run < runs; run += 1) {
        yield* admin.unsafe('savepoint migration_run');
        // One statement per query, as the migrator sends them.
        const outcome = yield* Effect.exit(
          Effect.forEach(probe, (statement) => admin.unsafe(statement), { discard: true }),
        );
        if (Exit.isFailure(outcome)) {
          const error = Cause.findErrorOption(outcome.cause);
          failures.push(Option.isSome(error) ? messageOf(error.value) : Cause.pretty(outcome.cause));
          yield* admin.unsafe('rollback to savepoint migration_run');
        } else {
          yield* admin.unsafe('release savepoint migration_run');
        }
      }
      const after = yield* admin.unsafe(`select name, revision, state::text as text from ${PROBE_TABLE}`);
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
  const { problems, statements } = probeStatements(migration);
  expect(problems).toEqual([]);
  return statements;
});

const byName = (rows: typeof StoredRowsSchema.Type) => new Map(rows.map((row) => [row.name, row]));
const decodeLedger = Schema.decodeUnknownEffect(FinanceStateSchema);
/** A stored row, read back as its JSON text. */
const decodeRow = Schema.decodeUnknownEffect(Schema.fromJsonString(FinanceStateSchema));
const encodeLedger = Schema.encodeEffect(FinanceStateSchema);

it.layer(NodeServices.layer, { excludeTestServices: true })('Imported payment records migration', (suite) => {
  suite.effect(
    'records the unexplained paid part of every invoice as the app does, changes nothing else, and runs once',
    () =>
      Effect.scoped(
        Effect.gen(function* importedPaymentRecordsMigration() {
          const probe = yield* loadProbe();
          const ledgers = acceptedLedgers();
          const [sales, recorded, odd, limit] = [salesLedger(), recordedLedger(), oddStampLedger(), limitLedger()];
          const { after, before, failures } = yield* migrateProbe(probe, ledgers, 2);
          expect(failures).toEqual([]);
          const stored = byName(after);
          const original = byName(before);
          // Every ledger stays readable, and a changed one holds exactly what the app's own rule writes for it.
          for (const entry of ledgers) {
            const decoded = yield* decodeRow(stored.get(entry.name)?.text);
            const expected = yield* withImportedPaymentRecords(yield* decodeLedger(entry.state));
            expect([entry.name, yield* encodeLedger(decoded)]).toEqual([entry.name, yield* encodeLedger(expected)]);
          }
          // A: the list is created with its 24 records, and the revision goes up once over two runs.
          const salesAfter = yield* decodeRow(stored.get(sales.name)?.text);
          expect(sales.state.manualPayments).toBeUndefined();
          expect(salesAfter.manualPayments?.map((entry) => [entry.id, entry.paidOn, entry.source])).toEqual(
            salesImportDays().map((day, index) => [
              `sales-${String(index + 1).padStart(2, '0')}:import`,
              day,
              'IMPORT',
            ]),
          );
          expect(salesAfter.manualPayments?.at(0)?.paidOn).toBe('2025-12-06');
          expect(salesAfter.manualPayments?.at(-1)?.paidOn).toBe('2026-10-13');
          expect(stored.get(sales.name)?.revision).toBe(6);
          // B: byte for byte as stored, revision unchanged.
          expect(stored.get(recorded.name)?.text).toBe(original.get(recorded.name)?.text);
          expect(stored.get(recorded.name)?.revision).toBe(75);
          // Odd timestamps are dated on the UTC day Finance reads them as.
          const oddAfter = yield* decodeRow(stored.get(odd.name)?.text);
          expect(oddAfter.manualPayments?.map((entry) => [entry.invoiceResourceId, entry.paidOn])).toEqual(
            oddStamps.map(([id, , day]) => [id, day]),
          );
          expect(stored.get(odd.name)?.revision).toBe(4);
          // Exactly 5,000 records is still a readable ledger.
          const limitAfter = yield* decodeRow(stored.get(limit.name)?.text);
          expect(limitAfter.manualPayments?.length).toBe(5000);
          expect(stored.get(limit.name)?.revision).toBe(10);
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
            const refused = refusal.build();
            const { after, before, failures } = yield* migrateProbe(probe, [salesLedger(), refused], 1);
            expect(failures).toHaveLength(1);
            expect(failures[0]).toContain(
              `Finance ledger of tenant ${refused.tenantId} company ${refused.legalEntityId}`,
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
