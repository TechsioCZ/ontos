/*
 * The ledgers of the imported-payment-records migration test, checked without a database: each stored ledger is one
 * Finance decodes, and what the migration must leave (the app's own rule applied to it) is a ledger Finance decodes
 * too, with the shapes the stage preflight found. The refused ledgers are ones the seed helper refuses as well, except
 * the invalid calendar date, which only PostgreSQL cannot read.
 */
import { describe, expect, it } from 'effect-rstest';
import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import { FinanceStateSchema } from '../../shared/apis/records.ts';
import { withImportedPaymentRecords } from '../../shared/domain/finance-planning.ts';
import {
  acceptedLedgers,
  limitLedger,
  oddStampLedger,
  MIGRATION,
  oddStamps,
  probeStatements,
  recordedLedger,
  refusals,
  salesImportDays,
  salesLedger,
} from '../integration/imported-payment-records-fixtures.ts';

const decode = Schema.decodeUnknownEffect(FinanceStateSchema);
const encode = Schema.encodeEffect(FinanceStateSchema);

describe('imported payment records migration fixtures', () => {
  it.effect('every accepted ledger and what the migration must make of it decode as Finance ledgers', () =>
    Effect.gen(function* acceptedFixtures() {
      for (const ledger of acceptedLedgers()) {
        const expected = yield* withImportedPaymentRecords(yield* decode(ledger.state));
        // Encoded and decoded again, as the migrated row is read back.
        const roundTrip = yield* decode(yield* encode(expected));
        expect([ledger.name, roundTrip.manualPayments?.length ?? 0]).toEqual([
          ledger.name,
          expected.manualPayments?.length ?? 0,
        ]);
      }
    }),
  );

  it.effect('the stage shapes: 24 imports into a ledger without a list, a fully explained ledger untouched', () =>
    Effect.gen(function* stageLedgers() {
      const sales = salesLedger();
      expect([sales.state.invoices.length, sales.revision, 'manualPayments' in sales.state]).toEqual([30, 5, false]);
      expect(sales.state.invoices.every((invoice) => invoice.updatedAt.endsWith('Z'))).toBe(true);
      const salesAfter = yield* withImportedPaymentRecords(yield* decode(sales.state));
      expect(salesAfter.manualPayments?.map((payment) => payment.paidOn)).toEqual(salesImportDays());
      expect([salesImportDays()[0], salesImportDays()[23]]).toEqual(['2025-12-06', '2026-10-13']);
      const recorded = recordedLedger();
      expect([recorded.state.invoices.length, recorded.state.manualPayments?.length, recorded.revision]).toEqual([
        14, 9, 75,
      ]);
      const decodedRecorded = yield* decode(recorded.state);
      expect(yield* withImportedPaymentRecords(decodedRecorded)).toBe(decodedRecorded);
      const odd = yield* withImportedPaymentRecords(yield* decode(oddStampLedger().state));
      expect(odd.manualPayments?.map((payment) => [payment.invoiceResourceId, payment.paidOn])).toEqual(
        oddStamps.map(([id, , day]) => [id, day]),
      );
      const limit = yield* withImportedPaymentRecords(yield* decode(limitLedger().state));
      expect(limit.manualPayments?.length).toBe(5000);
    }),
  );

  it.effect('every refused ledger is one Finance reads, and the seed helper refuses the same ones', () =>
    Effect.gen(function* refusedFixtures() {
      for (const refusal of refusals) {
        const ledger = refusal.build();
        const decoded = yield* decode(ledger.state);
        const refusedByHelper = Result.isFailure(yield* Effect.result(withImportedPaymentRecords(decoded)));
        expect([refusal.name, refusedByHelper]).toEqual([refusal.name, ledger.name !== 'invalid calendar date']);
      }
    }),
  );
});

it.layer(NodeServices.layer)('imported payment records migration text', (suite) => {
  suite.effect('passes the probe checks and splits into the statements the migrator sends', () =>
    Effect.gen(function* migrationText() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migration = yield* fs.readFileString(path.join(import.meta.dirname, '..', '..', MIGRATION));
      const { problems, statements } = probeStatements(migration);
      expect(problems).toEqual([]);
      // Each statement is one piece of SQL beside its comments; none is empty.
      const bodies = statements.map((statement) =>
        statement
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      );
      expect(bodies.filter((body) => body === '')).toEqual([]);
      expect(bodies.map((body) => body.split(/\s+/u).slice(0, 2).join(' '))).toEqual([
        'SET LOCAL',
        'LOCK TABLE',
        'SET LOCAL',
        'CREATE TEMP',
        'DO $$',
        'UPDATE pg_temp.finance_states_payment_probe',
        'DROP TABLE',
        'SET LOCAL',
        'SET LOCAL',
      ]);
    }),
  );
});
