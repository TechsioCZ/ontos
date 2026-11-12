// @rstest-environment happy-dom
// The order edit form as the user sees it: one Save button in the form's footer, the draft's status next to it, and
// a question before unsaved changes are left. Only the generated clients, the i18n runtime and the router blocker are
// replaced.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { OrderSchema, ProductRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order, ProductRecord } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { OrderEditForm } from '../../src/routes/[lang]/prodej/objednavky/order-edit-form.tsx';
import type { ProductRecordState } from '../../src/routes/[lang]/provoz/produkty/product-reads.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { translateTaxCs } from './merchandise-translate.ts';

/** The product the mocked picker picks. */
interface OfferedProduct {
  current: ProductRecord | null;
}

const { offered } = rstest.hoisted(() => {
  // Set before each test, since the mocks exist before this module's constants.
  const pick: OfferedProduct = { current: null };
  return { offered: pick };
});

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => translateTaxCs(key, values),
  }),
}));
// The product picker: one button that picks the product the test offers.
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-search.tsx', () => ({
  ProductSearchCombobox: (props: { readonly onSelect: (product: ProductRecord | null) => void }) =>
    createElement('button', { onClick: () => props.onSelect(offered.current), type: 'button' }, 'pick product'),
}));
// The picked product's full record arrives at once.
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-reads.ts', () => ({
  loadProductRecord: (_productId: string, answer: (state: ProductRecordState) => void) => {
    if (offered.current !== null) {
      answer({ product: offered.current, status: 'ready' });
    }
  },
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
      {
        productId: 'product-1',
        productName: 'Cable',
        quantity: 2,
        sku: 'CABLE',
        taxClassificationCode: CZ_VAT_STANDARD,
        taxRuleRevisionId: 'tax-rule-revision-standard-21',
        unitPriceMinor: 100,
        vatRate: 21,
      },
    ],
    note: fields.note ?? '',
    number: 'ORD-1',
    partyId: 'party-1',
    status: 'NEW',
    totalMinor: 200,
    totalVatMinor: 42,
    updatedAt: fields.updatedAt,
  });

const rate = Schema.decodeSync(TaxRateViewSchema);
/** Today Tax gives the standard classification 23 %: the order's own line keeps the 21 % it was snapshotted with. */
const standardRate = rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 23 });
const reducedRate = rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 });
/** The company's rates the page passes in; a test replaces them. */
const payer: CompanyVat = { rates: [standardRate, reducedRate], regime: 'VAT_PAYER' };
let vat: CompanyVat = payer;

const beans: ProductRecord = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'Káva',
  createdAt: opened,
  currentPriceMinor: 800,
  id: 'product-2',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Zrnková káva',
  priceHistory: [],
  sku: 'BEANS',
  stockOnHand: 50,
  stockValueMinor: 40_000,
  taxClassificationCode: CZ_VAT_REDUCED,
  unit: 'ks',
  updatedAt: opened,
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
/** The order the form edits; a test replaces it. */
let shownOrder: Order = orderOf({ updatedAt: opened });
/** The lines of the edits the form sent. */
const sentLines = () =>
  rstest
    .mocked(executeManageCatalog)
    .mock.calls.flatMap(([payload]) => (payload.command._tag === 'EditOrder' ? (payload.command.lines ?? []) : []));

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
        order={shownOrder}
        products={[]}
        revision={7}
        vat={vat}
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

/** What the form shows, with non-breaking spaces (money, percent) read as plain spaces. */
const text = () => (document.body.textContent ?? '').replaceAll('\u00A0', ' ');

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  offered.current = beans;
  shownOrder = orderOf({ updatedAt: opened });
  vat = payer;
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

describe('VAT of the order lines', () => {
  it.effect("an order's own line shows the VAT it was snapshotted with, named by its classification", () =>
    Effect.gen(function* snapshot() {
      yield* Effect.promise(mount);
      expect(text()).toContain('merchandise.pages.orders.detail.lineVat Základní (21 %)');
      expect(text()).not.toContain('23 %');
      // 2 × 1 Kč net + 21 % VAT, as the order already counted it.
      expect(text()).toContain('2,42 Kč');
    }),
  );

  it.effect("an added product takes its classification from the product and today's rate from Tax", () =>
    Effect.gen(function* added() {
      yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('pick product')));
      yield* Effect.promise(() => click(button('Přidat')));
      expect(text()).toContain('merchandise.pages.orders.detail.lineVat Snížená (12 %)');
      // 2,42 Kč for the order's line, plus 8 Kč net and 0,96 Kč VAT for the new one.
      expect(text()).toContain('11,38 Kč');
      expect(edits()).toBe(0);
    }),
  );

  it.effect('a product whose classification has no rate in force cannot be added, and the form says why', () =>
    Effect.gen(function* missing() {
      vat = { ...payer, rates: [standardRate] };
      yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('pick product')));
      expect(text()).toContain('Sazba DPH „Snížená“ není pro tuto firmu nastavená, produkt nelze přidat.');
      expect(button('Přidat').disabled).toBe(true);
    }),
  );

  it.effect('a product without a VAT classification cannot be added, and the form says why', () =>
    Effect.gen(function* unclassified() {
      const { taxClassificationCode: _code, ...withoutClassification } = beans;
      void _code;
      offered.current = withoutClassification;
      yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('pick product')));
      expect(text()).toContain('Produkt nemá zařazení do sazby DPH, proto ho nelze přidat.');
      expect(text()).not.toContain('„není nastaveno“');
      expect(button('Přidat').disabled).toBe(true);
    }),
  );

  it.effect('a company that is not a VAT payer adds a product at 0 % and the line says so', () =>
    Effect.gen(function* nonPayer() {
      vat = { rates: [], regime: 'NON_PAYER' };
      yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('pick product')));
      expect(button('Přidat').disabled).toBe(false);
      yield* Effect.promise(() => click(button('Přidat')));
      expect(text()).toContain('merchandise.pages.orders.detail.lineVat Snížená (0 %)');
      // 2,42 Kč for the order's line, plus 8 Kč net and no VAT for the new one.
      expect(text()).toContain('10,42 Kč');
      expect(text()).not.toContain('není nastaveno');
    }),
  );
});

describe('a line added to a storefront order (prices include VAT)', () => {
  it.effect('takes the stored price including VAT and lets the server price it unless staff change the price', () =>
    Effect.gen(function* storedGross() {
      shownOrder = { ...orderOf({ updatedAt: opened }), pricesIncludeVat: true };
      // Stored gross 10 Kč, not 8 Kč net plus 12 % (8,96 Kč).
      offered.current = { ...beans, grossPriceMinor: 1000 };
      yield* Effect.promise(mount);
      yield* Effect.promise(() => click(button('pick product')));
      yield* Effect.promise(() => click(button('Přidat')));
      expect(text()).not.toContain('8,96 Kč');
      expect(text()).toContain('10 Kč');
      yield* Effect.promise(() => click(button('Uložit')));
      expect(sentLines().find((line) => line.productId === beans.id)).toEqual({ productId: beans.id, quantity: 1 });
    }),
  );
});
