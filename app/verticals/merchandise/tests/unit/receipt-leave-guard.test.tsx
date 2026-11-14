// @rstest-environment happy-dom
// Příjem zboží stays a stock-movement command with its own button, but closing it with typed input asks the shared
// leave question (Zůstat / Zahodit změny, Uložit offered but disabled), never an older dialog of its own. Its own
// button stays disabled until a product and a valid quantity are filled in.
import { saveLabelsFor } from '@app/admin-ui';
import { Effect, Option, Predicate, Schema } from 'effect';
import { constVoid } from 'effect/Function';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import type { ProductRecord } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { ProductRecordState } from '../../src/routes/[lang]/provoz/produkty/product-reads.ts';
import { executeRecordStockMovement } from '../../src/api/record-stock-movement-action-client.ts';
import { createRoot } from 'react-dom/client';
import { ReceiptDialog } from '../../src/routes/[lang]/provoz/produkty/product-forms.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

interface PickedReceiptProduct {
  current: ProductRecord | null;
}
const { picked, reads } = rstest.hoisted(() => {
  const pickedProduct: PickedReceiptProduct = { current: null };
  const pendingReads: ((record: ProductRecordState) => void)[] = [];
  return { picked: pickedProduct, reads: pendingReads };
});
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-search.tsx', () => ({
  ProductSearchCombobox: (props: { readonly onSelect: (product: ProductRecord | null) => void }) =>
    createElement('button', { onClick: () => props.onSelect(picked.current), type: 'button' }, 'pick product'),
}));
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-reads.ts', () => ({
  loadProductRecord: (_productId: string, answer: (record: ProductRecordState) => void) => {
    reads.push(answer);
  },
  SEARCH_DEBOUNCE: '0 millis',
  searchCategoryTrails: () => Effect.succeed({ matches: [], total: 0 }),
}));
rstest.mock('@app/admin-ui/select-template', () => ({
  SelectTemplate: (props: { readonly onValueChange: (details: { value: string[] }) => void }) =>
    createElement(
      'button',
      { onClick: () => props.onValueChange({ value: ['receipt-v1'] }), type: 'button' },
      'pick variant',
    ),
}));
rstest.mock('../../src/api/record-stock-movement-action-client.ts');
rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
}));

const labels = saveLabelsFor('cs');
const copy = {
  cancel: 'merchandise.pages.products.common.cancel',
  oldKeep: 'merchandise.pages.products.detail.discardKeep',
  retry: 'merchandise.pages.products.common.retry',
  submit: 'merchandise.pages.products.receipt.submit',
  typed: 'typed-note',
} as const;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const unmounts: (() => void)[] = [];
const openChanges: boolean[] = [];

const mount = Effect.promise(async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ReceiptDialog
        onCommitted={constVoid}
        onOpenChange={(open) => {
          openChanges.push(open);
        }}
        onReload={constVoid}
        open
        revision={4}
      />,
    );
    await settle();
  });
  unmounts.push(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
  });
});

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === label);
const button = (label: string): HTMLButtonElement => Option.getOrThrow(Option.fromNullishOr(buttons(label)[0]));
const typeNote = (value: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(Option.fromNullOr(document.querySelector<HTMLInputElement>('#receipt-note')));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
    }),
  );
const click = (element: HTMLElement) =>
  Effect.promise(() =>
    act(async () => {
      element.click();
      await settle();
    }),
  );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  openChanges.length = 0;
  reads.length = 0;
  picked.current = null;
  rstest.mocked(executeRecordStockMovement).mockClear();
  rstest.mocked(executeRecordStockMovement).mockReturnValue(Effect.succeed({ entityIds: [], revision: 5 }));
});

afterEach(() => {
  for (const unmount of unmounts) {
    unmount();
  }
  unmounts.length = 0;
  rstest.unstubAllGlobals();
});

it.effect('closing with typed input asks the shared leave question; Zůstat keeps it, Zahodit změny closes', () =>
  Effect.gen(function* leave() {
    yield* mount;
    yield* typeNote(copy.typed);
    yield* click(button(copy.cancel));
    expect(buttons(copy.oldKeep)).toHaveLength(0);
    expect(buttons(labels.stay)).toHaveLength(1);
    expect(buttons(labels.discard)).toHaveLength(1);
    // The question never sends the receipt: only the command's own button does.
    expect(button(labels.save).disabled).toBe(true);
    expect(openChanges).toEqual([]);

    yield* click(button(labels.stay));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(document.querySelector<HTMLInputElement>('#receipt-note')?.value).toBe(copy.typed);

    yield* click(button(copy.cancel));
    yield* click(button(labels.discard));
    expect(openChanges).toEqual([false]);
  }),
);

it.effect('an untouched receipt closes at once', () =>
  Effect.gen(function* untouched() {
    yield* mount;
    yield* click(button(copy.cancel));
    expect(buttons(labels.stay)).toHaveLength(0);
    expect(openChanges).toEqual([false]);
  }),
);

it.effect('the receipt button stays disabled until a product is picked', () =>
  Effect.gen(function* disabledSubmit() {
    yield* mount;
    expect(button(copy.submit).disabled).toBe(true);
    yield* typeNote(copy.typed);
    expect(button(copy.submit).disabled).toBe(true);
  }),
);

const receiptProduct = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Stock',
  createdAt: '2026-11-14T10:00:00Z',
  currentPriceMinor: 1000,
  id: 'receipt-product',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Receipt product',
  priceHistory: [],
  sku: 'RECEIPT',
  stockOnHand: 0,
  stockValueMinor: 0,
  taxClassificationCode: 'cz.vat.standard',
  unit: 'm',
  updatedAt: '2026-11-14T10:00:00Z',
  variantRecords: [
    {
      active: true,
      attributes: '',
      availability: 'OUT_OF_STOCK',
      id: 'receipt-v1',
      name: 'Small',
      priceHistory: [],
      priceMinor: 1000,
      sku: 'RECEIPT-SMALL',
      stockOnHand: 0,
    },
  ],
});

it.effect('waits for the full product and an explicit variant, then submits that identity and fractional amount', () =>
  Effect.gen(function* receiptVariantIdentity() {
    picked.current = receiptProduct;
    yield* mount;
    yield* click(button('pick product'));
    expect(button(copy.submit).disabled).toBe(true);
    yield* Effect.promise(() =>
      act(async () => {
        reads[0]?.({ product: receiptProduct, status: 'ready' });
        await settle();
      }),
    );
    expect(button(copy.submit).disabled).toBe(true);
    yield* click(button('pick variant'));
    yield* Effect.promise(() =>
      act(async () => {
        const input = Option.getOrThrow(
          Option.fromNullOr(document.querySelector<HTMLInputElement>('#receipt-quantity')),
        );
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '0,125');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
      }),
    );
    expect(button(copy.submit).disabled).toBe(false);
    yield* click(button(copy.submit));
    const sent = rstest.mocked(executeRecordStockMovement).mock.calls[0]?.[0].command;
    expect(Predicate.isTagged(sent, 'RecordStockMovement')).toBe(true);
    expect(sent).toMatchObject({
      delta: 0.125,
      productId: receiptProduct.id,
      reason: 'RECEIPT',
      variantId: 'receipt-v1',
    });
  }),
);

it.effect('does not permit a receipt when the selected product record cannot be loaded', () =>
  Effect.gen(function* receiptReadFailure() {
    picked.current = receiptProduct;
    yield* mount;
    yield* click(button('pick product'));
    yield* Effect.promise(() =>
      act(async () => {
        reads[0]?.({ status: 'error' });
        await settle();
      }),
    );
    expect(button(copy.submit).disabled).toBe(true);
    expect(rstest.mocked(executeRecordStockMovement).mock.calls).toHaveLength(0);
    // The retry reads the same product again; its record then lets the receipt choose a variant.
    yield* click(button(copy.retry));
    expect(reads).toHaveLength(2);
    yield* Effect.promise(() =>
      act(async () => {
        reads[1]?.({ product: receiptProduct, status: 'ready' });
        await settle();
      }),
    );
    expect(buttons(copy.retry)).toHaveLength(0);
    expect(buttons('pick variant')).toHaveLength(1);
  }),
);

it.effect('ignores a stale product response and permits a variant-free receipt only after its own read', () =>
  Effect.gen(function* staleReceiptSelection() {
    picked.current = receiptProduct;
    yield* mount;
    yield* click(button('pick product'));
    const plain = Schema.decodeSync(ProductRecordSchema)({
      ...Schema.encodeSync(ProductRecordSchema)(receiptProduct),
      id: 'plain-receipt-product',
      variantRecords: [],
    });
    picked.current = plain;
    yield* click(button('pick product'));
    yield* Effect.promise(() =>
      act(async () => {
        reads[0]?.({ product: receiptProduct, status: 'ready' });
        await settle();
      }),
    );
    expect(button(copy.submit).disabled).toBe(true);
    yield* Effect.promise(() =>
      act(async () => {
        reads[1]?.({ product: plain, status: 'ready' });
        await settle();
      }),
    );
    expect(button(copy.submit).disabled).toBe(false);
    expect(buttons('pick variant')).toHaveLength(0);
    yield* click(button(copy.submit));
    const sent = rstest.mocked(executeRecordStockMovement).mock.calls[0]?.[0].command;
    expect(Predicate.isTagged(sent, 'RecordStockMovement')).toBe(true);
    expect(sent).toMatchObject({ delta: 1, productId: plain.id, reason: 'RECEIPT' });
    expect(sent).not.toHaveProperty('variantId');
    return yield* Effect.void;
  }),
);
