import { describe, expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Schema } from 'effect';
import { FinanceConflict, FinanceRejected } from '../../shared/actions/apply-command.ts';
import { SOURCE_ORDER_INVOICE_OTHER_COUNTERPARTY } from '../../shared/apis/records.ts';
import type { FinanceCommand } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';

const tenantId = 'a0000000-0000-4000-8000-000000000001';
const scope = { legalEntityId: 'a0000000-0000-4000-8000-000000000002', tenantId };
const empty: FinanceState = { financialPlanEntries: [], invoices: [] };
let counter = 0;
const allowAll: FinanceValidators = { invoice: () => Effect.void };
const run = (state: FinanceState, command: FinanceCommand, validators = allowAll) => {
  counter += 1;
  return transitionFinance(state, command, scope, validators, {
    attemptId: `sales-order-invoice-${counter}`,
    now: DateTime.makeUnsafe('2026-11-16T09:00:00Z'),
    resourceId: `a0000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
  });
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

  it.effect('another billing part of the same order is another invoice: an advance never answers for the final', () =>
    Effect.gen(function* billingParts() {
      const advance = yield* run(empty, { ...salesOrderDraft, documentKind: 'ADVANCE' });
      const final = yield* run(advance.state, { ...salesOrderDraft, documentKind: 'FINAL' });
      expect(final.changed).toBe(true);
      expect(final.invoice?.documentKind).toBe('FINAL');
      expect(final.state.invoices).toHaveLength(2);
      // A plain invoice is its own part too, and asking again for the final returns the final.
      const plain = yield* run(final.state, salesOrderDraft);
      expect(plain.changed).toBe(true);
      const finalAgain = yield* run(plain.state, { ...salesOrderDraft, documentKind: 'FINAL' });
      expect(finalAgain.changed).toBe(false);
      expect(finalAgain.invoice?.ref).toEqual(final.invoice?.ref);
    }),
  );

  it.effect('the same part asked for another counterparty is refused with its own reason, never answered', () =>
    Effect.gen(function* otherCounterparty() {
      const first = yield* run(empty, salesOrderDraft);
      const refused = yield* Effect.flip(
        run(first.state, {
          ...salesOrderDraft,
          counterpartyRef: { ...salesOrderDraft.counterpartyRef, resourceId: 'a0000000-0000-4000-8000-000000000013' },
        }),
      );
      expect(Schema.is(FinanceConflict)(refused) && refused.reason).toBe(SOURCE_ORDER_INVOICE_OTHER_COUNTERPARTY);
    }),
  );

  it.effect('amounts and lines edited in Finance keep it the order invoice', () =>
    Effect.gen(function* editedInFinance() {
      const first = yield* run(empty, salesOrderDraft);
      const invoiceRef = Option.getOrThrow(Option.fromUndefinedOr(first.invoice?.ref));
      const { _tag: _create, sourceOrder: _order, ...draft } = salesOrderDraft;
      const edited = yield* run(first.state, {
        ...draft,
        _tag: 'UpdateInvoiceDraft',
        documentNumber: Option.getOrThrow(Option.fromUndefinedOr(first.invoice?.documentNumber)),
        invoiceRef,
        lines: [{ description: 'Servis a materiál', quantity: 3, unitPriceMinor: 10_000, vatRate: 21 }],
      });
      const again = yield* run(edited.state, salesOrderDraft);
      expect(again.changed).toBe(false);
      expect(again.invoice?.ref).toEqual(invoiceRef);
      expect(again.invoice?.totalMinor).toBe(edited.invoice?.totalMinor);
    }),
  );

  it.effect('returning the existing invoice still runs the checks of the caller and its references', () =>
    Effect.gen(function* reuseKeepsCallerChecks() {
      const first = yield* run(empty, salesOrderDraft);
      const checked: Invoice[] = [];
      const recording: FinanceValidators = {
        invoice: (invoice) =>
          Effect.sync(() => {
            checked.push(invoice);
          }),
      };
      yield* run(first.state, salesOrderDraft, recording);
      expect(checked.map((invoice) => invoice.counterpartyRef)).toEqual([salesOrderDraft.counterpartyRef]);
      // A reference the caller may not use is refused, not answered with the order's invoice.
      const refusing: FinanceValidators = {
        invoice: () =>
          Effect.fail(new FinanceRejected({ code: 'finance_rejected', reason: 'counterparty_ineligible' })),
      };
      expect(yield* Effect.flip(run(first.state, salesOrderDraft, refusing))).toMatchObject({
        reason: 'counterparty_ineligible',
      });
      // So is a reference of another tenant.
      const foreign = yield* Effect.flip(
        run(first.state, {
          ...salesOrderDraft,
          counterpartyRef: { ...salesOrderDraft.counterpartyRef, tenantId: 'a0000000-0000-4000-8000-000000000099' },
        }),
      );
      expect(foreign).toMatchObject({ reason: 'scope_mismatch' });
    }),
  );

  it.effect('a purchase order keeps its own rule: an issued sales invoice of the same id never blocks it', () =>
    Effect.gen(function* purchaseUnaffected() {
      const issued = yield* run(empty, salesOrderDraft);
      const received = yield* run(issued.state, {
        _tag: 'RecordIncomingInvoice',
        documentNumber: 'DOD-1',
        dueDate: '2026-11-30',
        issueDate: '2026-11-16',
        lines: [{ description: 'Materiál', quantity: 1, unitPriceMinor: 5000, vatRate: 21 }],
        sourceOrder: salesOrderDraft.sourceOrder,
        supplierName: 'Dodavatel s.r.o.',
        totalMinor: 1,
      });
      expect(received.changed).toBe(true);
      expect(received.state.invoices).toHaveLength(2);
    }),
  );
});
