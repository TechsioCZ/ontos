// @rstest-environment happy-dom
// A line added in the order editor whose product changed price before the edit was saved, as staff live through it:
// the server refuses the save with "the offered price changed", the form reads the product again, puts the current
// price on the line, says so with the new price, and the next Uložit sends that price and succeeds. When the form cannot
// read a new price (the product reads at the price the line carries, or cannot be read at all), it names the line and
// asks staff to remove and add it again until a save succeeds. Picking the same product again refreshes an added
// line's price too. Only the generated clients, the i18n runtime (real Czech texts)
// and the router blocker are replaced.
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD, TaxRateViewSchema } from '@app/shared-contracts/cz-vat-classifications';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ManageCatalogActionConflictProblemSchema } from '../../shared/apis/manage-catalog-action.ts';
import { OrderMarketSchema, convertGrossMinor } from '../../shared/domain/market-offers.ts';
import { OrderSchema, ProductRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { Order, ProductRecord } from '../../shared/apis/records.ts';
import { executeManageCatalog } from '../../src/api/manage-catalog-action-client.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { OrderEditForm } from '../../src/routes/[lang]/prodej/objednavky/order-edit-form.tsx';
import type { CompanyVat } from '../../src/routes/[lang]/provoz/produkty/product-tax-classification.ts';
import type { ProductRecordState } from '../../src/routes/[lang]/provoz/produkty/product-reads.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { translateCs } from './merchandise-translate.ts';

/** The product the mocked picker picks, and the record every read of it returns now. */
interface CatalogProduct {
  current: ProductRecord | null;
}

const { catalog } = rstest.hoisted(() => {
  const product: CatalogProduct = { current: null };
  return { catalog: product };
});

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');
rstest.mock('../../src/api/cleanup-demo-action-client.ts');
rstest.mock('../../src/api/change-order-status-action-client.ts');
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, values?: Record<string, number | string>) => translateCs(key, values),
  }),
}));
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-search.tsx', () => ({
  ProductSearchCombobox: (props: { readonly onSelect: (product: ProductRecord | null) => void }) =>
    createElement('button', { onClick: () => props.onSelect(catalog.current), type: 'button' }, 'pick product'),
}));
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-reads.ts', () => ({
  loadProductRecord: (_productId: string, answer: (state: ProductRecordState) => void) => {
    if (catalog.current !== null) {
      answer({ product: catalog.current, status: 'ready' });
    }
  },
  readProductRecord: () => Effect.sync(() => catalog.current ?? undefined),
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
}));

const opened = '2026-10-15T10:00:00.000Z';

/** A storefront order (prices include VAT) with one cable line. */
const order: Order = Schema.decodeSync(OrderSchema)({
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
      unitPriceMinor: 100,
      vatRate: 21,
    },
  ],
  note: '',
  number: 'ORD-1',
  partyId: 'party-1',
  pricesIncludeVat: true,
  status: 'NEW',
  totalMinor: 200,
  totalVatMinor: 35,
  updatedAt: opened,
});

const rate = Schema.decodeSync(TaxRateViewSchema);
const vat: CompanyVat = {
  rates: [
    rate({ code: CZ_VAT_STANDARD, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 21 }),
    rate({ code: CZ_VAT_REDUCED, effectiveFrom: '2020-01-01T00:00:00Z', ratePercent: 12 }),
  ],
  regime: 'VAT_PAYER',
};

/** Coffee beans stored at the given price including VAT. */
const beansAt = (grossPriceMinor: number): ProductRecord =>
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'Káva',
    createdAt: opened,
    currentPriceMinor: 800,
    grossPriceMinor,
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

const priceChanged = ManageCatalogActionConflictProblemSchema.make({
  code: 'merchandise_offered_price_changed',
  detail: 'The Action conflicts with current state.',
  status: 409,
  title: 'Action conflict',
  type: 'https://ontos.dev/problems/action-conflict',
});

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};
const unmounts: (() => void)[] = [];
const mount = async (shown: Order = order) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <OrderEditForm
        movesStock={false}
        onCancel={() => {}}
        onSaved={() => {}}
        order={shown}
        products={[]}
        revision={7}
        vat={vat}
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
};
const button = (name: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === name) ??
  document.createElement('button');
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
const text = () => (document.body.textContent ?? '').replaceAll(' ', ' ');
const addedPrice = () =>
  document.querySelector<HTMLInputElement>('input[name^="price-new-"]')?.value.replaceAll(' ', ' ');
const sentBeans = () =>
  rstest
    .mocked(executeManageCatalog)
    .mock.calls.flatMap(([payload]) =>
      payload.command._tag === 'EditOrder'
        ? (payload.command.lines ?? []).filter((line) => line.productId === 'product-2')
        : [],
    );

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  catalog.current = beansAt(1000);
  rstest.mocked(executeRecords).mockReturnValue(
    Effect.succeed(
      Schema.decodeSync(RecordsResponseSchema)({
        actorPrincipalRef: {
          principalId: '20000000-0000-4000-8000-000000000002',
          tenantId: '20000000-0000-4000-8000-000000000001',
        },
        canWrite: true,
        indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 1, productCount: 1, stockValueMinor: 0 },
        movements: [],
        orders: [Schema.encodeSync(OrderSchema)(order)],
        products: [],
        revision: 8,
      }),
    ),
  );
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  rstest.unstubAllGlobals();
});

it.effect(
  'a price changed before saving is refused, taken onto the line with a notice, and the next save succeeds',
  () =>
    Effect.promise(async () => {
      await mount();
      await click(button('pick product'));
      await click(button('Přidat'));
      expect(addedPrice()).toContain('10');
      // The beans now sell at 12 Kč: the server refuses the 10 Kč offer.
      catalog.current = beansAt(1200);
      rstest
        .mocked(executeManageCatalog)
        .mockReturnValueOnce(Effect.fail(priceChanged))
        .mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
      await click(button('Uložit'));
      await waitUntil(() => text().includes('Cena přidaného zboží se mezitím změnila'));
      expect(text()).toContain('Zrnková káva: 12 Kč');
      expect(addedPrice()).toContain('12');
      // Uložit again sends the current price and is not refused.
      await click(button('Uložit'));
      await waitUntil(() => sentBeans().length === 2);
      expect(sentBeans().map((line) => line.offeredUnitPriceMinor)).toEqual([1000, 1200]);
      await waitUntil(() => !text().includes('Cena přidaného zboží se mezitím změnila'));
    }),
);

it.effect('picking a product already added again takes its current price onto that line', () =>
  Effect.promise(async () => {
    await mount();
    await click(button('pick product'));
    await click(button('Přidat'));
    catalog.current = beansAt(1200);
    await click(button('pick product'));
    await click(button('Přidat'));
    expect(addedPrice()).toContain('12');
    await click(button('Uložit'));
    await waitUntil(() => sentBeans().length === 1);
    expect(sentBeans()).toEqual([{ offeredUnitPriceMinor: 1200, productId: 'product-2', quantity: 2 }]);
  }),
);

it.effect('a market order offers an added line in its own currency, as the server prices it', () =>
  Effect.promise(async () => {
    const market = Schema.decodeSync(OrderMarketSchema)({
      currency: 'EUR',
      exchangeRate: '0.04',
      marketCode: 'TEST-SK',
      marketId: '30000000-0000-4000-8000-000000000001',
      roundingMinor: 10,
    });
    rstest.mocked(executeManageCatalog).mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
    await mount({ ...order, market });
    await click(button('pick product'));
    await click(button('Přidat'));
    await click(button('Uložit'));
    await waitUntil(() => sentBeans().length === 1);
    // 10 Kč with VAT at 0.04 EUR per Kč, rounded to 0.10 EUR: 0.40 EUR, never the CZK amount.
    expect(sentBeans()).toEqual([
      { offeredUnitPriceMinor: convertGrossMinor(1000, market), productId: 'product-2', quantity: 1 },
    ]);
    expect(convertGrossMinor(1000, market)).toBe(40);
  }),
);

const unreadable = 'novou cenu se nepodařilo načíst';

it.effect(
  'a refused price the form reads back unchanged names the line and asks to add it again until a save succeeds',
  () =>
    Effect.promise(async () => {
      await mount();
      await click(button('pick product'));
      await click(button('Přidat'));
      // The server refuses the 10 Kč offer, yet the product still reads at 10 Kč (e.g. priced without a stored gross
      // at a rate the server no longer uses): nothing new to take, and saving again is refused the same way.
      rstest
        .mocked(executeManageCatalog)
        .mockReturnValueOnce(Effect.fail(priceChanged))
        .mockReturnValueOnce(Effect.fail(priceChanged))
        .mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
      await click(button('Uložit'));
      await waitUntil(() => text().includes(unreadable));
      expect(text()).toContain('Řádek odeberte a přidejte znovu. Týká se: Zrnková káva.');
      expect(text()).not.toContain('Řádky teď nesou aktuální cenu');
      await click(button('Uložit'));
      await waitUntil(() => sentBeans().length === 2);
      await act(settle);
      expect(text()).toContain(unreadable);
      // A save that succeeds ends it.
      await click(button('Uložit'));
      await waitUntil(() => sentBeans().length === 3);
      await waitUntil(() => !text().includes(unreadable));
    }),
);

it.effect('a refused price whose product can no longer be read names that line', () =>
  Effect.promise(async () => {
    await mount();
    await click(button('pick product'));
    await click(button('Přidat'));
    // The beans were deleted meanwhile: the form cannot read their new price.
    catalog.current = null;
    rstest
      .mocked(executeManageCatalog)
      .mockReturnValueOnce(Effect.fail(priceChanged))
      .mockReturnValue(Effect.succeed({ entityIds: [], revision: 8 }));
    await click(button('Uložit'));
    await waitUntil(() => text().includes(unreadable));
    expect(text()).toContain('Týká se: Zrnková káva.');
    expect(addedPrice()).toContain('10');
    await click(button('Uložit'));
    await waitUntil(() => sentBeans().length === 2);
    await waitUntil(() => !text().includes(unreadable));
  }),
);
