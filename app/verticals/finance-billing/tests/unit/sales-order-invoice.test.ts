import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option } from 'effect';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const empty: FinanceState = { financialPlanEntries: [], invoices: [] };
let counter = 0;
const run = (state: FinanceState, command: FinanceCommand) => {
  counter += 1;
  return transitionFinance(
    state,
    command,
    scope,
    { invoice: () => Effect.void },
    {
      attemptId: `sales-order-invoice-${counter}`,
      now: DateTime.makeUnsafe('2026-11-16T09:00:00Z'),
      resourceId: `a0000000-0000-4000-8000-00000000010${counter}`,
    },
  );
};
const salesOrderDraft = {
  _tag: 'CreateInvoiceDraft',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'a0000000-0000-4000-8000-000000000012',
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  currency: 'CZK',
  direction: 'OUTGOING',
  dueDate: '2026-11-30',
  issueDate: '2026-11-16',
  lines: [{ description: 'Servis', quantity: 1, unitPriceMinor: 10_000, vatRate: 21 }],
  sourceOrder: { id: 'sales-order-1', number: 'PRO-2026-0001' },
  totalMinor: 1,
} satisfies FinanceCommand;

describe('the issued invoice of a sales order', () => {
  it.effect('asking again for the same order returns the invoice it already has and drafts no other', () =>
    Effect.gen(function* sameOrderSameInvoice() {
      const first = yield* run(empty, salesOrderDraft);
      expect(first.invoice?.sourceOrder).toEqual(salesOrderDraft.sourceOrder);
      // A retry after a lost answer or a failed link, from another tab or device, with other dates.
      const again = yield* run(first.state, { ...salesOrderDraft, dueDate: '2026-12-15', issueDate: '2026-11-20' });
      expect(again.changed).toBe(false);
      expect(again.invoice).toEqual(first.invoice);
      expect(again.state.invoices).toHaveLength(1);
    }),
  );

  it.effect('another order, a voided invoice or a received invoice of the same id do not count', () =>
    Effect.gen(function* otherInvoicesDoNotCount() {
      const first = yield* run(empty, salesOrderDraft);
      const other = yield* run(first.state, {
        ...salesOrderDraft,
        sourceOrder: { id: 'sales-order-2', number: 'PRO-2026-0002' },
      });
      expect(other.changed).toBe(true);
      expect(other.state.invoices).toHaveLength(2);
      const firstRef = Option.getOrThrow(Option.fromUndefinedOr(first.invoice?.ref));
      const voided = yield* run(first.state, { _tag: 'VoidInvoice', invoiceRef: firstRef });
      const reissued = yield* run(voided.state, salesOrderDraft);
      expect(reissued.changed).toBe(true);
      expect(reissued.invoice?.ref.resourceId).not.toBe(firstRef.resourceId);
      const received = yield* run(empty, {
        _tag: 'RecordIncomingInvoice',
        documentNumber: 'DOD-1',
        dueDate: '2026-11-30',
        issueDate: '2026-11-16',
        lines: [{ description: 'Materiál', quantity: 1, unitPriceMinor: 5000, vatRate: 21 }],
        sourceOrder: salesOrderDraft.sourceOrder,
        supplierName: 'Dodavatel s.r.o.',
        totalMinor: 1,
      });
      const issued = yield* run(received.state, salesOrderDraft);
      expect(issued.changed).toBe(true);
      expect(issued.invoice?.direction).toBe('OUTGOING');
    }),
  );
});
