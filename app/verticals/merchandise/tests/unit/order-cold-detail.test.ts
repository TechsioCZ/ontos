import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import { OrderSchema, ProductRecordSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { OrderDetailDialog } from '../../src/routes/[lang]/prodej/objednavky/order-detail-dialog.tsx';
import {
  firstOrdersPage,
  orderDetailData,
  ordersPageData,
  preloadOrderDetails,
  useOrderDetail,
} from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { OrderDetailState } from '../../src/routes/[lang]/prodej/objednavky/orders-records.ts';
import type { CustomerDirectory } from '../../src/routes/[lang]/prodej/objednavky/customers-directory.ts';

const { createElement } = rstest.requireActual<typeof React>('react');

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/apply-command-action-client.ts');
// Execute the first-render branch without running effects.
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof React>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  useModernI18n: () => ({
    language: 'cs',
    t: (key: string, params?: { readonly number?: string }) =>
      params?.number === undefined ? key : `${key}:${params.number}`,
  }),
}));
// The portal shell is not the behavior under test; the panel body is.
rstest.mock('@app/admin-ui', () => {
  const react = rstest.requireActual<typeof React>('react');
  return {
    ...rstest.requireActual('@app/admin-ui'),
    SidePanel: ({
      actions,
      children,
      title,
    }: {
      readonly actions?: React.ReactNode;
      readonly children?: React.ReactNode;
      readonly title?: React.ReactNode;
    }) => react.createElement('section', null, react.createElement('h2', null, title), children, actions),
  };
});

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};
beforeAll(() => {
  for (const [key, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, key, value);
  }
});
afterAll(() => {
  for (const key of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, key);
  }
});

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const otherContext = { ...context, legalEntityId: 'company-2' };
const scope = pageDataScopeKey(context, 'demo.merchandise') ?? '';
const instant = '2026-10-15T10:00:00Z';
const order = Schema.decodeSync(OrderSchema)({
  channel: 'STOREFRONT',
  contact: { email: 'ada@example.test', name: 'Ada Guest', phone: '+420123456789' },
  createdAt: instant,
  deliveryAddress: { city: 'Brno', country: 'CZ', postalCode: '60200', street: 'Kavárna 1' },
  demo: true,
  id: 'order-1',
  lines: [
    {
      productId: 'product-1',
      productName: 'Cable',
      quantity: 2,
      sku: 'CABLE-BLACK',
      unitPriceMinor: 100,
      variantId: 'variant-1',
      vatRate: 21,
    },
  ],
  number: 'ORD-1',
  partyId: 'party-1',
  shipping: { label: 'Osobní odběr', method: 'OSOBNI_ODBER', priceMinor: 0, vatRate: 21 },
  status: 'NEW',
  totalMinor: 200,
  totalVatMinor: 42,
  updatedAt: instant,
});
const product = Schema.decodeSync(ProductRecordSchema)({
  active: true,
  category: 'IT',
  createdAt: instant,
  currentPriceMinor: 100,
  id: 'product-1',
  lowStock: false,
  lowStockThreshold: 0,
  name: 'Cable',
  priceHistory: [],
  sku: 'CABLE',
  stockOnHand: 10,
  stockValueMinor: 1000,
  unit: 'ks',
  updatedAt: instant,
  vatRate: 21,
});
const fullProduct = Schema.decodeSync(ProductRecordSchema)({
  ...Schema.encodeSync(ProductRecordSchema)(product),
  variantRecords: [
    {
      active: true,
      attributes: 'black',
      availability: 'IN_STOCK',
      grossPriceMinor: 121,
      id: 'variant-1',
      name: 'Black cable',
      priceHistory: [],
      priceMinor: 100,
      sku: 'CABLE-BLACK',
      stockOnHand: 8,
    },
  ],
});
const base = Schema.decodeSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  canWrite: true,
  indicators: { lowStockCount: 0, openOrderValueMinor: 200, orderCount: 1, productCount: 1, stockValueMinor: 1000 },
  movements: [],
  orders: [Schema.encodeSync(OrderSchema)(order)],
  products: [],
  revision: 7,
});
const source = { legalEntityId: context.legalEntityId, query: firstOrdersPage(2), scope };
const detailInput = { orderId: order.id, revision: 7, scope, source };
const customers: CustomerDirectory = {
  active: [],
  entries: [{ companyId: null, name: 'Ada Guest', partyId: 'party-1', status: 'ACTIVE' }],
  nameOf: (partyId) => (partyId === 'party-1' ? 'Ada Guest' : null),
  reload: () => {},
  status: 'ready',
};

beforeEach(() => {
  rstest.resetAllMocks();
  orderDetailData.invalidate();
  ordersPageData.invalidate();
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    if (view?.productId !== undefined) {
      return Effect.succeed({ ...base, movements: [], orders: [], products: [product] });
    }
    if (view?.productIds !== undefined) {
      return Effect.succeed({ ...base, orders: [], products: [view.summary === true ? product : fullProduct] });
    }
    return Effect.succeed(base);
  });
});

const detailLabel = (state: OrderDetailState): string => {
  if (state.status === 'ready') {
    return `ready:${state.order.number}`;
  }
  if (state.status === 'loading') {
    return `loading:${state.summary?.order.number ?? 'none'}`;
  }
  return state.status;
};

const DetailStateProbe = () => {
  const state = useOrderDetail(order.id, 0, context, source);
  return createElement('output', null, detailLabel(state));
};

const ColdOrderDialog = () => {
  const state = useOrderDetail(order.id, 0, context, source);
  return createElement(OrderDetailDialog, {
    busy: false,
    canWrite: false,
    currentPrincipalId: 'principal-1',
    customers,
    detail: state,
    onClose: () => {},
    onEdited: () => {},
    onStatus: () => {},
    revision: 7,
  });
};

it.effect('a cold table click renders the authorized row while the detail enriches', () =>
  Effect.gen(function* coldClick() {
    yield* ordersPageData.read(source);
    rstest.mocked(executeRecords).mockClear();

    expect(renderToStaticMarkup(createElement(DetailStateProbe))).toBe('<output>loading:ORD-1</output>');
    expect(executeRecords).not.toHaveBeenCalled();

    const html = renderToStaticMarkup(createElement(ColdOrderDialog));
    expect(html).toContain('merchandise.pages.orders.detail.title:ORD-1');
    expect(html).toContain('merchandise.pages.orders.detail.customer');
    expect(html).toContain('Ada Guest');
    expect(html).toContain('merchandise.ui.deliveryAddress');
    expect(html).toContain('merchandise.pages.orders.detail.grossTotal');
    expect(html).toContain('merchandise.pages.orders.detail.loading');
    expect(html).not.toContain('merchandise.pages.orders.detail.loadingTitle');
    expect(html).not.toContain('merchandise.pages.orders.detail.lines');
    expect(html).not.toContain('merchandise.pages.orders.detail.updatedAt');
    expect(html).not.toContain('merchandise.pages.orders.actions.cancel');
    expect(html).not.toContain('Upravit objednávku');
    expect(html).not.toContain('Odstranit DEMO objednávku');
  }),
);

it.effect('a warm detail shows canonical order data instead of the list summary', () =>
  Effect.gen(function* warmDetail() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detailInput)).toMatchObject({ state: 'ready' });

    expect(renderToStaticMarkup(createElement(DetailStateProbe))).toBe('<output>ready:ORD-1</output>');
  }),
);

it.effect('a scope change neither reuses the old detail nor summarizes its stale row', () =>
  Effect.gen(function* scopeChange() {
    yield* ordersPageData.read(source);
    yield* preloadOrderDetails(source, base);
    expect(orderDetailData.snapshot(detailInput)).toMatchObject({ state: 'ready' });

    const ScopeChangeProbe = () => {
      const state = useOrderDetail(order.id, 0, otherContext, source);
      return createElement('output', null, detailLabel(state));
    };
    expect(renderToStaticMarkup(createElement(ScopeChangeProbe))).toBe('<output>loading:none</output>');
  }),
);
