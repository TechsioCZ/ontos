// @rstest-environment happy-dom
// The purchasing forms (order or quote, supplier, stock item, stock movement, order from a quote) send their command
// on the shared Uložit only: one click sends the same command as the old button, and leaving with typed input asks.
import { Effect, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { createElement } from 'react';
import { PurchasingStateSchema, emptyPurchasingState } from '../../shared/domain/purchasing.ts';
import type { PurchasingState } from '../../shared/domain/purchasing.ts';
import { MovementForm } from '../../src/routes/[lang]/provoz/nakupy/movement-form.tsx';
import {
  ItemCreatePanel,
  PurchaseDocumentPanel,
  SupplierPanel,
  draftLine,
} from '../../src/routes/[lang]/provoz/nakupy/order-forms.tsx';
import { QuoteToOrderForm } from '../../src/routes/[lang]/provoz/nakupy/other-tabs.tsx';
import { click, labels, mountPanel, typeInto, unmountPanels } from './draft-base-fixture.ts';
import { leaveQuestionOpen, recordingRunner, saveButton, saveSent } from './form-save-fixture.ts';

rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));
rstest.mock('../../src/ui/property-options.ts', () => ({
  usePropertyOptions: () => ({ status: 'loading' }),
}));
rstest.mock('../../src/ui/task-options.ts', () => ({
  useTaskOptions: () => ({ status: 'loading' }),
}));
rstest.mock('@techsio/ui-kit/molecules/toast', () => ({
  Toaster: () => null,
  toaster: { attrs: {} },
  useToast: () => ({ create: constVoid }),
}));

const copy = { cancel: 'facility-operations.common.cancel' };
const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const audit = {
  createdAt: '2026-10-20T08:00:00Z',
  createdBy: actor,
  updatedAt: '2026-10-20T08:00:00Z',
  updatedBy: actor,
};
const state: PurchasingState = Schema.decodeUnknownSync(PurchasingStateSchema)({
  ...emptyPurchasingState,
  items: [
    {
      ...audit,
      category: 'consumable',
      id: 'item-1',
      lastPriceMinor: 12_000,
      leadTimeDays: 7,
      maximum: 50,
      minimum: 10,
      name: 'Filtr G4',
      sku: 'FLT-G4',
      tracking: 'none',
      unit: 'ks',
      warehouseId: 'warehouse-1',
    },
  ],
  quotes: [
    {
      ...audit,
      currency: 'CZK',
      date: '2026-10-20',
      id: 'quote-1',
      lines: [{ description: 'Filtr G4', id: 'line-1', itemId: 'item-1', quantity: 20, unitPriceMinor: 12_000 }],
      number: 'NAB-17',
      status: 'received',
      supplierId: 'supplier-1',
    },
  ],
  suppliers: [{ ...audit, id: 'supplier-1', name: 'Filtry s.r.o.' }],
  warehouses: [{ ...audit, code: 'HS', id: 'warehouse-1', name: 'Hlavní sklad' }],
});
const [item] = state.items;
const [quote] = state.quotes;

const calls: string[] = [];
const page = (name: string) => () => {
  calls.push(name);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  calls.length = 0;
});

afterEach(() => {
  unmountPanels();
  rstest.unstubAllGlobals();
});

describe('purchase order, supplier and stock item', () => {
  it.live('an order handed over with its lines can be sent at once; Uložit creates it once', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(PurchaseDocumentPanel, {
          initialLines: item === undefined ? [] : [draftLine('suggested', item, 5)],
          initialSupplierId: 'supplier-1',
          kind: 'order',
          onClose: page('close'),
          onCreated: page('created'),
          run: runner.run,
          state,
        }),
      );
      expect(saveButton().disabled).toBe(false);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({
          _tag: 'PurchaseOrderCreate',
          lines: [expect.objectContaining({ itemId: 'item-1', quantity: 5 })],
          supplierId: 'supplier-1',
          warehouseId: 'warehouse-1',
        }),
      ]);
      expect(calls).toEqual(['created']);
    }),
  );

  it.live('a supplier is created once with the typed name; Zrušit with input asks', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner();
      yield* mountPanel(createElement(SupplierPanel, { onClose: page('close'), run: runner.run }));
      yield* typeInto('#supplier-name', 'Čistota a.s.');
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(true);
      yield* click(labels.stay);
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([{ _tag: 'PurchaseSupplierCreate', name: 'Čistota a.s.' }]);
      expect(calls).toEqual(['close']);
    }),
  );

  it.live('a stock item is created once; a refused save keeps the input', () =>
    Effect.gen(function* scenario() {
      const runner = recordingRunner(['unavailable']);
      yield* mountPanel(
        createElement(ItemCreatePanel, { onClose: page('close'), onCreated: page('created'), run: runner.run, state }),
      );
      yield* typeInto('#item-sku', 'FLT-G5');
      yield* typeInto('#item-name', 'Filtr G5');
      yield* typeInto('#item-minimum', '5');
      yield* typeInto('#item-maximum', '20');
      yield* saveSent(runner, 1);
      expect(calls).toEqual([]);
      expect(document.querySelector<HTMLInputElement>('#item-name')?.value).toBe('Filtr G5');
      yield* saveSent(runner, 2);
      expect(runner.sent[1]).toEqual(runner.sent[0]);
      expect(runner.sent[0]).toMatchObject({ _tag: 'StockItemCreate', maximum: 20, minimum: 5, sku: 'FLT-G5' });
      expect(calls).toEqual(['created']);
    }),
  );
});

describe('stock movement and order from a quote', () => {
  it.live('a receipt is recorded once with the typed quantity and reason', () =>
    Effect.gen(function* scenario() {
      if (item === undefined) {
        return;
      }
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(MovementForm, { item, kind: 'receipt', onDone: page('done'), run: runner.run, state }),
      );
      yield* typeInto('#movement-quantity', '12');
      yield* typeInto('#movement-reason', 'Dodávka');
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        expect.objectContaining({ _tag: 'StockReceipt', itemId: item.id, quantity: 12, reason: 'Dodávka' }),
      ]);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('an untouched movement closes without asking', () =>
    Effect.gen(function* scenario() {
      if (item === undefined) {
        return;
      }
      yield* mountPanel(
        createElement(MovementForm, { item, kind: 'issue', onDone: page('done'), run: recordingRunner().run, state }),
      );
      yield* click(copy.cancel);
      expect(leaveQuestionOpen()).toBe(false);
      expect(calls).toEqual(['done']);
    }),
  );

  it.live('a quote becomes an order on Uložit, with the warehouse it opened with', () =>
    Effect.gen(function* scenario() {
      if (quote === undefined) {
        return;
      }
      const runner = recordingRunner();
      yield* mountPanel(
        createElement(QuoteToOrderForm, {
          onOpenOrder: page('order'),
          quote,
          run: runner.run,
          setError: constVoid,
          state,
        }),
      );
      yield* saveSent(runner, 1);
      expect(runner.sent).toEqual([
        { _tag: 'PurchaseOrderCreateFromQuote', quoteId: quote.id, warehouseId: 'warehouse-1' },
      ]);
      expect(calls).toEqual(['order']);
    }),
  );
});
