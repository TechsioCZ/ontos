// @rstest-environment happy-dom
// The order edit form as the user sees it: one Save button in the form's footer, the draft's status next to it, and
// a question before unsaved changes are left. Only the generated clients, the i18n runtime and the router blocker are
// replaced.
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { OrderEditForm } from '../../src/routes/[lang]/prodej/objednavky/order-edit-form.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

const opened = '2026-10-15T10:00:00.000Z';
const savedHere = '2026-10-15T10:06:00.000Z';

const orderOf = (fields: { readonly note?: string; readonly updatedAt: string }): Order =>
  Schema.decodeSync(OrderSchema)({
    contact: { email: 'ada@example.test', name: 'Ada Guest' },
    createdAt: opened,
    deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' },
    demo: true,
    id: 'order-1',
    lines: [
      { productId: 'product-1', productName: 'Cable', quantity: 2, sku: 'CABLE', unitPriceMinor: 100, vatRate: 21 },
    ],
    note: fields.note ?? '',
    number: 'ORD-1',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 200,
    totalVatMinor: 42,
    updatedAt: fields.updatedAt,
  });

const recordsWith = (order: Order, revision: number) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [Schema.encodeSync(OrderSchema)(order)],
    products: [],
    revision,
  });

const edits = () => rstest.mocked(executeManageCatalog).mock.calls.length;

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

interface View {
  readonly cancelled: string[];
  readonly saved: string[];
  readonly unmount: () => void;
}

const views: View[] = [];

const mount = async (): Promise<View> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const cancelled: string[] = [];
  const saved: string[] = [];
  await act(async () => {
    root.render(
      <OrderEditForm
        movesStock={false}
        onCancel={() => {
          cancelled.push('cancel');
        }}
        onSaved={(message) => {
          saved.push(message);
        }}
        order={orderOf({ updatedAt: opened })}
        products={[]}
        revision={7}
      />,
    );
    await settle();
  });
  let live = true;
  const view: View = {
    cancelled,
    saved,
    unmount: () => {
      if (live) {
        live = false;
        act(() => {
          root.unmount();
          container.remove();
        });
      }
    },
  };
  views.push(view);
  return view;
};

const buttons = (name: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === name);

const button = (name: string): HTMLButtonElement => {
  const [found] = buttons(name);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};

const noteField = (): HTMLTextAreaElement => {
  const label = [...document.querySelectorAll('label')].find(
    (entry) => entry.textContent?.trim() === 'merchandise.ui.orderNote',
  );
  return Option.getOrThrow(
    Option.fromNullOr(document.querySelector<HTMLTextAreaElement>(`textarea[id="${label?.htmlFor ?? ''}"]`)),
  );
};

/** Types like a user: React sees a native input event. */
const typeNote = async (value: string) => {
  await act(async () => {
    const field = noteField();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
  });
};

const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await settle();
  });
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

const text = () => document.body.textContent ?? '';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
  rstest
    .mocked(executeRecords)
    .mockReturnValue(Effect.succeed(recordsWith(orderOf({ note: 'Zavolat předem', updatedAt: savedHere }), 8)));
});

afterEach(() => {
  for (const view of views) {
    view.unmount();
  }
  views.length = 0;
  rstest.unstubAllGlobals();
});

describe('order edit form with one Save button', () => {
  it.live('has one Save button, disabled until something changes, and typing sends nothing', () =>
    Effect.gen(function* oneButton() {
      yield* Effect.promise(mount);
      expect(buttons('Uložit')).toHaveLength(1);
      expect(button('Uložit').disabled).toBe(true);
      expect(text()).not.toMatch(/automat/iu);

      yield* Effect.promise(() => typeNote('Zavolat předem'));
      expect(button('Uložit').disabled).toBe(false);
      expect(text()).toContain('Neuložené změny');
      // Longer than any debounce the form ever had.
      yield* Effect.sleep('1 second');
      yield* Effect.promise(() => act(settle));
      expect(edits()).toBe(0);
    }),
  );

  it.effect('one click on Save sends one edit and shows it saved', () =>
    Effect.gen(function* saveOnce() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => typeNote('Zavolat předem'));
      yield* Effect.promise(() => click(button('Uložit')));
      yield* Effect.promise(() => waitUntil(() => text().includes('Uloženo')));
      expect(edits()).toBe(1);
      expect(button('Uložit').disabled).toBe(true);
    }),
  );

  it.effect('leaving with unsaved changes asks first; Zůstat keeps the form, Zahodit změny leaves unsaved', () =>
    Effect.gen(function* leave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeNote('Zavolat předem'));
      yield* Effect.promise(() => click(button('merchandise.pages.orders.detail.backToDetail')));
      expect(buttons('Zahodit změny')).toHaveLength(1);
      expect(buttons('Zůstat')).toHaveLength(1);
      expect(view.cancelled).toEqual([]);

      yield* Effect.promise(() => click(button('Zůstat')));
      yield* Effect.promise(() => waitUntil(() => buttons('Zůstat').length === 0));
      expect(noteField().value).toBe('Zavolat předem');

      yield* Effect.promise(() => click(button('merchandise.pages.orders.detail.backToDetail')));
      yield* Effect.promise(() => click(button('Zahodit změny')));
      expect(view.cancelled).toEqual(['cancel']);
      expect(edits()).toBe(0);
    }),
  );

  it.effect('Uložit in the question saves once and then leaves', () =>
    Effect.gen(function* saveAndLeave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => typeNote('Zavolat předem'));
      yield* Effect.promise(() => click(button('merchandise.pages.orders.detail.backToDetail')));
      // The question's own Save button is the last one: the dialog renders after the form.
      const inDialog = buttons('Uložit').at(-1);
      expect(inDialog).toBeDefined();
      yield* Effect.promise(() => click(inDialog ?? document.createElement('button')));
      yield* Effect.promise(() => waitUntil(() => view.saved.length === 1));
      expect(edits()).toBe(1);
    }),
  );

  it.effect('an unchanged form leaves without asking', () =>
    Effect.gen(function* cleanLeave() {
      const view = yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('merchandise.pages.orders.detail.backToDetail')));
      expect(buttons('Zůstat')).toHaveLength(0);
      expect(view.cancelled).toEqual(['cancel']);
    }),
  );
});
