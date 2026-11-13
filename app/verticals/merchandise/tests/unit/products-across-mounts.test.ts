// @rstest-environment happy-dom
// What a reopened products list shows first: the real `useProductPage` hook over the real strict list store, with
// only the generated records client replaced and the clock faked. A list left for a full product page and reopened
// after 30 s starts from its last ready read and reloads once in the background. A write in between starts it
// loading, as before.
import { moduleWriteEvent } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { useProductPage } from '../../src/routes/[lang]/provoz/produkty/product-list-page.ts';
import { firstProductPage, productListData } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');

const company: ModulePageContext = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const PAGE_SIZE = 2;

const product = Schema.encodeSync(ProductRecordSchema)(
  Schema.decodeSync(ProductRecordSchema)({
    active: true,
    category: 'IT',
    createdAt: instant,
    currentPriceMinor: 100,
    id: 'product-cable',
    lowStock: false,
    lowStockThreshold: 0,
    name: 'Cable',
    priceHistory: [],
    sku: 'CABLE',
    stockOnHand: 10,
    stockValueMinor: 1000,
    taxClassificationCode: 'cz.vat.standard',
    unit: 'ks',
    updatedAt: instant,
  }),
);

const responseOf = (
  products: readonly (typeof product)[],
  tax: Pick<typeof RecordsResponseSchema.Encoded, 'sellerVatRegime' | 'taxRates'>,
) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canManageCatalog: true,
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 1, stockValueMinor: 1000 },
    movements: [],
    orders: [],
    products,
    revision: 7,
    ...tax,
  });

/** Every list read the page sent. */
const reads: string[] = [];
const serve = () => {
  rstest.mocked(executeRecords).mockImplementation(() => {
    reads.push('list');
    return Effect.succeed(responseOf([product], { taxRates: [] }));
  });
};
const count = (kind: string) => reads.filter((read) => read === kind).length;

/** The status of every render of the list, in order, since the last reset. */
const renders: string[] = [];
const ProductsList = () => {
  const { state } = useProductPage(company.legalEntityId, firstProductPage(PAGE_SIZE), company);
  renders.push(state.status);
  // A ready list shows each product's classification and the company's VAT regime and rates from Tax.
  const vat =
    state.status === 'ready'
      ? [
          ...state.response.products.map((row) => `${row.sku}:${row.taxClassificationCode ?? '-'}`),
          ...(state.response.taxRates ?? []).map((rate) => `${rate.code}=${rate.ratePercent}`),
          state.response.sellerVatRegime ?? '-',
        ].join(' ')
      : '';
  return createElement('output', null, state.status, createElement('span', null, vat));
};

let unmount: (() => void) | null = null;

const mount = () =>
  Effect.promise(async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      act(() => {
        root.unmount();
        container.remove();
      });
    };
    await act(async () => {
      root.render(createElement(ProductsList));
      await browserRuntime.runPromise(Effect.yieldNow);
    });
  });

const unmountList = () => {
  unmount?.();
  unmount = null;
};

/** Lets fake time pass in one-second steps, so every timer and every render it causes runs in between. */
const idle = (seconds: number): Effect.Effect<void> =>
  seconds <= 0
    ? Effect.void
    : Effect.promise(() =>
        act(async () => {
          await rstest.advanceTimersByTimeAsync(1000);
        }),
      ).pipe(Effect.andThen(Effect.suspend(() => idle(seconds - 1))));

const writeHappened = Effect.sync(() => globalThis.dispatchEvent(new Event(moduleWriteEvent)));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  rstest.resetAllMocks();
  productListData.invalidate();
  reads.length = 0;
  renders.length = 0;
  serve();
  // Empties the copies an earlier test left behind, as any write does.
  globalThis.dispatchEvent(new Event(moduleWriteEvent));
});

afterEach(() => {
  unmountList();
  rstest.useRealTimers();
  rstest.unstubAllGlobals();
});

it.effect('a list reopened after 30 s shows its last ready read at once and reloads once', () =>
  Effect.gen(function* reopened() {
    yield* mount();
    yield* idle(5);
    unmountList();
    reads.length = 0;
    renders.length = 0;

    yield* idle(30);
    yield* mount();
    expect(renders[0]).toBe('ready');
    expect(renders).not.toContain('loading');

    yield* idle(5);
    expect(count('list')).toBe(1);
    expect(renders[0]).toBe('ready');
  }),
);

it.effect('a write in between makes the reopened list load, not show the rows of before', () =>
  Effect.gen(function* afterWrite() {
    yield* mount();
    yield* idle(5);
    unmountList();
    reads.length = 0;
    renders.length = 0;

    yield* idle(30);
    yield* writeHappened;
    yield* mount();
    expect(renders[0]).toBe('loading');

    yield* idle(5);
    expect(count('list')).toBe(1);
  }),
);

it.effect('a reopened list keeps each product classification and the company VAT rates and regime from Tax', () =>
  Effect.gen(function* classified() {
    const reduced: typeof product = {
      ...product,
      id: 'product-coffee',
      name: 'Coffee',
      sku: 'COFFEE',
      taxClassificationCode: 'cz.vat.reduced',
    };
    rstest.mocked(executeRecords).mockImplementation(() => {
      reads.push('list');
      return Effect.succeed(
        responseOf([product, reduced], {
          sellerVatRegime: 'VAT_PAYER',
          taxRates: [
            { code: 'cz.vat.standard', effectiveFrom: '2020-01-01T00:00:00.000Z', ratePercent: 21 },
            { code: 'cz.vat.reduced', effectiveFrom: '2020-01-01T00:00:00.000Z', ratePercent: 12 },
          ],
        }),
      );
    });
    yield* mount();
    yield* idle(5);
    unmountList();
    renders.length = 0;

    yield* idle(30);
    yield* mount();
    expect(renders[0]).toBe('ready');
    expect(document.querySelector('output span')?.textContent).toBe(
      'CABLE:cz.vat.standard COFFEE:cz.vat.reduced cz.vat.standard=21 cz.vat.reduced=12 VAT_PAYER',
    );
  }),
);
