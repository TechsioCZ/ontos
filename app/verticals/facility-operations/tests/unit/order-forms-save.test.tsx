// @rstest-environment happy-dom
// The forms on a purchase or sales order (receipt, invoice link, incoming invoice draft, new sales quote, delivery,
// close with remainder, sales invoice) send on the shared Uložit only, once, with the same payload as before.
import { Effect, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { PurchaseOrderSchema, SalesOrderSchema, SupplierSchema } from '../../shared/domain/purchasing.ts';
import { salesRemainder } from '../../shared/commands/sales.ts';
import { InvoiceDraftForm } from '../../src/routes/[lang]/provoz/nakupy/invoice-draft-form.tsx';
import { InvoiceForm, ReceiveForm } from '../../src/routes/[lang]/provoz/nakupy/orders-tab.tsx';
import {
  SalesCloseForm,
  SalesDeliverForm,
  SalesInvoiceForm,
} from '../../src/routes/[lang]/provoz/nakupy/sales-order-forms.tsx';
import { click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, pick, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';

const financeCommands: unknown[] = [];
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({ create: constVoid }),
}));
rstest.mock('@app/finance-billing/clients/apply-command', () => ({
  executeApplyCommand: (payload: { readonly command: unknown }) =>
    Effect.sync(() => {
      financeCommands.push(payload.command);
    }),
}));
rstest.mock('../../src/ui/finance-reads.ts', () => ({
  readFinance: () => Effect.succeed({ canWrite: true, revision: 7 }),
}));

const copy = {
  cancel: 'facility-operations.common.cancel',
  close: 'facility-operations.purchasing.sales.actions.close',
};
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const supplier = Schema.decodeUnknownSync(SupplierSchema)({ ...audit, id: 'supplier-1', name: 'Filtry s.r.o.' });
const order = Schema.decodeUnknownSync(PurchaseOrderSchema)({
  ...audit,
  currency: 'CZK',
  deliveries: [],
  history: [],
  id: 'order-1',
  invoices: [],
  lines: [{ description: 'Filtr G4', id: 'line-1', quantity: 10, receivedQuantity: 0, unitPriceMinor: 12_000 }],
  number: 'OBJ-2026-004',
  status: 'ordered',
  supplierId: supplier.id,
  warehouseId: 'warehouse-1',
});
const salesOrder = Schema.decodeUnknownSync(SalesOrderSchema)({
  ...audit,
  currency: 'CZK',
  customer: { counterpartyId: 'customer-1', name: 'Kavárna Dolce', tenantId },
  deliveries: [],
  history: [],
  id: 'sales-order-1',
  invoices: [],
  lines: [
    { deliveredQuantity: 0, description: 'Servis', id: 'line-1', quantity: 2, unitPriceMinor: 150_000, vatRate: 21 },
  ],
  number: 'PRO-2026-002',
  status: 'partially_delivered',
});
const lookupState = { items: [] };

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
  financeCommands.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('purchase order forms', () => {
  it.live('a receipt opens with the remaining quantities and records them once', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(ReceiveForm, {
          onDone: page('done'),
          order,
          run: runner.run,
          state: {
            ...lookupState,
            movements: [],
            orders: [order],
            plannedIssues: [],
            quotes: [],
            suppliers: [supplier],
            warehouses: [],
          },
        }),
      );
      yield* typeInto('#receive-note', 'DL-55');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'PurchaseOrderReceive',
          deliveryNote: 'DL-55',
          lines: [{ lineId: 'line-1', quantity: 10 }],
          orderId: order.id,
        }),
      ]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('an invoice is linked once with the typed number; leaving with it asks', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(InvoiceForm, { onDone: page('done'), order, run: runner.run }));
      yield* typeInto('#invoice-number', 'FV-2026-118');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([{ _tag: 'PurchaseOrderLinkInvoice', number: 'FV-2026-118', orderId: order.id }]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('the incoming invoice draft is created once after the VAT rate is picked', () =>
    Effect.gen(function* scenario() {
      yield* mountPanel(
        createElement(InvoiceDraftForm, { onCancel: page('cancel'), onCreated: page('created'), order, supplier }),
      );
      expect(saveButton().disabled).toBe(true);
      yield* pick('invoice-vat-rate', '21');
      yield* click(labels.save);
      expect(financeCommands).toEqual([
        expect.objectContaining({ _tag: 'RecordIncomingInvoice', sourceOrder: { id: order.id, number: order.number } }),
      ]);
      expect(calls).toEqual(['created']);
    }),
  );
});

describe('sales order forms', () => {
  it.live('a delivery is recorded once with the typed quantity', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(SalesDeliverForm, {
          onDone: page('done'),
          order: salesOrder,
          remainder: salesRemainder(salesOrder),
          run: runner.run,
        }),
      );
      yield* typeInto('#sales-deliver-line-1', '1');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'SalesOrderDeliver',
          lines: [{ lineId: 'line-1', quantity: 1 }],
          orderId: salesOrder.id,
        }),
      ]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('closing with a remainder needs a reason, then closes once', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(SalesCloseForm, {
          closeLabel: copy.close,
          onDone: page('done'),
          order: salesOrder,
          run: runner.run,
        }),
      );
      expect(saveButton().disabled).toBe(true);
      yield* typeInto('#sales-close-reason', 'Zákazník zbytek nechce');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        {
          _tag: 'SalesOrderTransition',
          note: 'Zákazník zbytek nechce',
          orderId: salesOrder.id,
          to: 'completed',
        },
      ]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('the sales invoice opens with its dates and is created once on Uložit', () =>
    Effect.gen(function* scenario() {
      const issued: string[] = [];
      yield* mountPanel(
        createElement(SalesInvoiceForm, {
          issueInvoice: (invoiced) =>
            Effect.sync(() => {
              issued.push(invoiced.id);
              return { number: 'FV-1', ok: true };
            }),
          onDone: page('done'),
          order: salesOrder,
          totalLabel: copy.close,
        }),
      );
      yield* click(labels.save);
      expect(issued).toEqual([salesOrder.id]);
      expect(calls).toEqual(['done']);
    }),
  );
});
