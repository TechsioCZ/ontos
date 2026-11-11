// @rstest-environment happy-dom
// The product editor across a failed reload: the real `useProductDetail` over the real strict store, with only the
// generated records client replaced. A reload of the product on screen that fails keeps the editor mounted with its
// unsaved draft and reports the failure; a first read that fails, a denied read, or another product never shows
// the product read before.
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import {
  detailInput,
  productDetailData,
  useProductDetail,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

rstest.mock('../../src/api/records-consumer.ts');
rstest.mock('../../src/api/manage-catalog-action-client.ts');

const context = { legalEntityId: 'company-1', principalId: 'principal-1', tenantId: 'tenant-1' };
const instant = '2026-10-15T10:00:00Z';
const productOf = (id: string, name: string) =>
  Schema.encodeSync(ProductRecordSchema)(
    Schema.decodeSync(ProductRecordSchema)({
      active: true,
      category: 'IT',
      createdAt: instant,
      currentPriceMinor: 100,
      id,
      lowStock: false,
      lowStockThreshold: 0,
      name,
      priceHistory: [],
      sku: id.toUpperCase(),
      stockOnHand: 8,
      stockValueMinor: 800,
      unit: 'ks',
      updatedAt: instant,
      vatRate: 21,
    }),
  );
const responseOf = (name: string) =>
  Schema.decodeSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '20000000-0000-4000-8000-000000000002',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    canWrite: true,
    indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 2, stockValueMinor: 1600 },
    movements: [],
    orders: [],
    products: [productOf('product-1', name), productOf('product-2', 'Mouse')],
    revision: 7,
  });
const unavailable = Schema.decodeSync(RecordsUnavailableProblemSchema)({
  _tag: 'RecordsUnavailableProblem',
  detail: 'Try again',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

const serve = (name: string) => {
  rstest.mocked(executeRecords).mockImplementation(({ view }) => {
    const response = responseOf(name);
    return Effect.succeed({ ...response, products: response.products.filter((entry) => entry.id === view?.productId) });
  });
};
const refuse = (problem: typeof unavailable | typeof denied) => {
  rstest.mocked(executeRecords).mockReturnValue(Effect.fail(problem));
};

/** What the page showed on every render, how often the editor mounted, and the editor's typed draft. */
const shown: string[] = [];
let mounts = 0;
let typeDraft: ((text: string) => void) | null = null;

/** Stands for the editor: it exists only while the detail is ready, and keeps its own unsaved draft. */
const Editor = ({ name }: { readonly name: string }) => {
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    mounts += 1;
    typeDraft = setDraft;
  }, []);
  return createElement('output', null, draft);
};

const Page = ({ productId }: { readonly productId: string }) => {
  const detail = useProductDetail(context.legalEntityId, productId, context, 7);
  shown.push(
    detail.status === 'ready'
      ? `ready:${detail.product.name}:${detail.reloadFailure ?? 'current'}`
      : `${detail.status}:${detail.status === 'error' ? detail.reason : ''}`,
  );
  return detail.status === 'ready' ? createElement(Editor, { name: detail.product.name }) : null;
};

const settle = async (): Promise<void> => {
  await browserRuntime.runPromise(Effect.yieldNow);
};

const waitUntil = async (condition: () => boolean, attempt = 0): Promise<void> => {
  if (condition() || attempt >= 400) {
    expect(condition()).toBe(true);
    return;
  }
  await act(settle);
  await waitUntil(condition, attempt + 1);
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

const show = (productId: string) =>
  Effect.promise(() =>
    act(async () => {
      if (root === null) {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
      }
      root.render(createElement(Page, { productId }));
      await settle();
    }),
  );

/** The page reads the shown product again, as after a save of another tab or a photo change. */
const reload = (productId: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(detailInput(context.legalEntityId, productId, context, 7));
      await browserRuntime.runPromise(productDetailData.refresh(input).pipe(Effect.ignore));
      await settle();
    }),
  );

const text = () => container?.textContent ?? '';

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  rstest.resetAllMocks();
  productDetailData.invalidate();
  shown.length = 0;
  mounts = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
    container?.remove();
  });
  root = null;
  container = null;
  rstest.unstubAllGlobals();
});

it.effect('a failed reload keeps the editor mounted with its draft and reports the failure; a retry clears it', () =>
  Effect.gen(function* failedReload() {
    serve('Cable');
    yield* show('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:Cable:current'));
    yield* Effect.promise(() => act(async () => typeDraft?.('Cable 2 m')));

    refuse(unavailable);
    shown.length = 0;
    yield* reload('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:Cable:unavailable'));
    expect(shown.filter((state) => !state.startsWith('ready:'))).toEqual([]);
    expect(mounts).toBe(1);
    expect(text()).toBe('Cable 2 m');

    serve('Cable B');
    yield* reload('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:Cable B:current'));
    expect(mounts).toBe(1);
    expect(text()).toBe('Cable 2 m');
  }),
);

it.effect('a first read that fails shows the error, never a product', () =>
  Effect.gen(function* firstFailure() {
    refuse(unavailable);
    yield* show('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'error:unavailable'));
    expect(mounts).toBe(0);
  }),
);

it.effect('a denied reload drops the shown product at once', () =>
  Effect.gen(function* deniedReload() {
    serve('Cable');
    yield* show('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:Cable:current'));
    refuse(denied);
    yield* reload('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'error:forbidden'));
    expect(text()).toBe('');
  }),
);

it.effect('a failed read of another product never shows the product read before', () =>
  Effect.gen(function* otherProduct() {
    serve('Cable');
    yield* show('product-1');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'ready:Cable:current'));
    refuse(unavailable);
    shown.length = 0;
    yield* show('product-2');
    yield* Effect.promise(() => waitUntil(() => shown.at(-1) === 'error:unavailable'));
    expect(shown.some((state) => state.startsWith('ready:'))).toBe(false);
    expect(text()).toBe('');
  }),
);
