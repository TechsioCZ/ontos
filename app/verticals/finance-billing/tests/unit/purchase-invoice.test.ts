import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';

const state: FinanceState = {
  invoices: [],

  financialPlanEntries: [],
};
const scope = {
  tenantId: 'a0000000-0000-4000-8000-000000000001',
  legalEntityId: 'a0000000-0000-4000-8000-000000000002',
};
const run = (current: FinanceState, command: FinanceCommand) =>
  transitionFinance(
    current,
    command,
    scope,
    { invoice: () => Effect.void },
    {
      now: DateTime.makeUnsafe('2026-10-20T10:00:00Z'),
      attemptId: 'purchase-invoice',
      resourceId: 'a0000000-0000-4000-8000-000000000003',
    },
  );
const command = {
  _tag: 'RecordIncomingInvoice' as const,
  supplierName: 'Filtrace Plus s.r.o.',
  documentNumber: 'NÁVRH-OBJ-2026-0006',
  issueDate: '2026-10-20',
  dueDate: '2026-11-03',
  sourceOrder: { id: 'order-6', number: 'OBJ-2026-0006' },
  lines: [{ description: 'Filtrační vložka', quantity: 2, unitPriceMinor: 109900, vatRate: 21 as const }],
  totalMinor: 1,
};

describe('S06-03 incoming invoice from purchase order', () => {
  it.effect('copies supplier, order reference and line prices as a DRAFT; computes totals from lines', () =>
    Effect.gen(function* () {
      const result = yield* run(state, command);
      expect(result.invoice?.businessState).toBe('DRAFT');
      expect(result.invoice?.counterpartyName).toBe(command.supplierName);
      expect(result.invoice?.sourceOrder).toEqual(command.sourceOrder);
      expect(result.invoice?.lines).toEqual(command.lines);
      expect(result.invoice?.lines).not.toBe(command.lines);
      expect(result.invoice?.lines?.[0]).not.toBe(command.lines[0]);
      expect(result.invoice?.subtotalMinor).toBe(219800);
      expect(result.invoice?.totalMinor).toBe(265958);
      expect(result.invoice?.paymentState).toBe('UNPAID');
    }),
  );
  it.effect('prevents duplicate drafts for the same order even with a changed invoice number', () =>
    Effect.gen(function* () {
      const first = yield* run(state, command);
      const duplicate = yield* Effect.exit(run(first.state, { ...command, documentNumber: 'Jiný návrh' }));
      expect(Exit.isFailure(duplicate)).toBe(true);
      expect(first.state.invoices.length).toBe(1);
    }),
  );
  it.effect('requires copied lines when an order is supplied', () =>
    Effect.gen(function* () {
      const { lines: _lines, ...withoutLines } = command;
      expect(Exit.isFailure(yield* Effect.exit(run(state, withoutLines)))).toBe(true);
    }),
  );
  it.effect('keeps legacy manually recorded incoming invoices confirmed', () =>
    Effect.gen(function* () {
      const { lines: _lines, sourceOrder: _order, ...manual } = command;
      const result = yield* run(state, { ...manual, totalMinor: 10000 });
      expect(result.invoice?.businessState).toBe('CONFIRMED');
      expect(result.invoice?.totalMinor).toBe(10000);
      expect(result.invoice?.sourceOrder).toBeUndefined();
    }),
  );
});
