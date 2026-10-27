import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit, Schema } from 'effect';
import { FinanceCommandSchema } from '../../shared/actions/apply-command.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';

const state: FinanceState = {
  financialPlanEntries: [],
  invoices: [],
};
const scope = {
  legalEntityId: 'a0000000-0000-4000-8000-000000000002',
  tenantId: 'a0000000-0000-4000-8000-000000000001',
};
const run = (current: FinanceState, command: typeof FinanceCommandSchema.Encoded) =>
  Schema.decodeEffect(FinanceCommandSchema)(command).pipe(
    Effect.flatMap((decoded) =>
      transitionFinance(
        current,
        decoded,
        scope,
        { invoice: () => Effect.void },
        {
          attemptId: 'purchase-invoice',
          now: DateTime.makeUnsafe('2026-10-20T10:00:00Z'),
          resourceId: 'a0000000-0000-4000-8000-000000000003',
        },
      ),
    ),
  );
const command = {
  _tag: 'RecordIncomingInvoice' as const,
  documentNumber: 'NÁVRH-OBJ-2026-0006',
  dueDate: '2026-11-03',
  issueDate: '2026-10-20',
  lines: [{ description: 'Filtrační vložka', quantity: 2, unitPriceMinor: 109_900, vatRate: 21 as const }],
  sourceOrder: { id: 'order-6', number: 'OBJ-2026-0006' },
  supplierName: 'Filtrace Plus s.r.o.',
  totalMinor: 1,
};

describe('S06-03 incoming invoice from purchase order', () => {
  it.effect('copies supplier, order reference and line prices as a DRAFT; computes totals from lines', () =>
    Effect.gen(function* purchaseDraft() {
      const result = yield* run(state, command);
      expect(result.invoice?.businessState).toBe('DRAFT');
      expect(result.invoice?.counterpartyName).toBe(command.supplierName);
      expect(result.invoice?.sourceOrder).toEqual(command.sourceOrder);
      expect(result.invoice?.lines).toEqual(command.lines);
      expect(result.invoice?.lines).not.toBe(command.lines);
      expect(result.invoice?.lines?.[0]).not.toBe(command.lines[0]);
      expect(result.invoice?.subtotalMinor).toBe(219_800);
      expect(result.invoice?.totalMinor).toBe(265_958);
      expect(result.invoice?.paymentState).toBe('UNPAID');
    }),
  );
  it.effect('prevents duplicate drafts for the same order even with a changed invoice number', () =>
    Effect.gen(function* duplicatePurchase() {
      const first = yield* run(state, command);
      const duplicate = yield* Effect.exit(run(first.state, { ...command, documentNumber: 'Jiný návrh' }));
      expect(Exit.isFailure(duplicate)).toBe(true);
      expect(first.state.invoices.length).toBe(1);
    }),
  );
  it.effect('requires copied lines when an order is supplied', () =>
    Effect.gen(function* requiredPurchaseLines() {
      const { lines: _lines, ...withoutLines } = command;
      expect(Exit.isFailure(yield* Effect.exit(run(state, withoutLines)))).toBe(true);
    }),
  );
  it.effect('keeps legacy manually recorded incoming invoices confirmed', () =>
    Effect.gen(function* manualPurchase() {
      const { lines: _lines, sourceOrder: _order, ...manual } = command;
      const result = yield* run(state, { ...manual, totalMinor: 10_000 });
      expect(result.invoice?.businessState).toBe('CONFIRMED');
      expect(result.invoice?.totalMinor).toBe(10_000);
      expect(result.invoice?.sourceOrder).toBeUndefined();
    }),
  );
});
