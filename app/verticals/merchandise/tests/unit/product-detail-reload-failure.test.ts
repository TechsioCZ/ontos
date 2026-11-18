// @rstest-environment happy-dom
// The product editor across a failed reload: the real `useProductDetail` over the real strict store, with the
// generated records client running through its HTTP contract. A reload of the product on screen that fails keeps the editor mounted with its
// unsaved draft and reports the failure; a first read that fails, a denied read, or another product never shows
// the product read before.
import { acted, settle, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RecordsApi,
  RecordsForbiddenProblemSchema,
  RecordsResponseSchema,
  RecordsUnavailableProblemSchema,
} from '../../shared/apis/records.ts';
import { ProductRecordSchema } from '../../shared/domain/merchandise-model.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import {
  detailInput,
  productDetailData,
  useProductDetail,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

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

let answer: Effect.Effect<RecordsResponse, typeof unavailable | typeof denied> = Effect.succeed(responseOf('Cable'));

const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const owner = HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
  group.handle('execute', ({ payload }) =>
    Effect.suspend(() => answer).pipe(
      Effect.map((response) => ({
        ...response,
        products: response.products.filter((entry) => entry.id === payload.view?.productId),
      })),
    ),
  ),
);
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(OwnerRecordsApi, owner),
);

const serve = (name: string) => {
  answer = Effect.succeed(responseOf(name));
};
const refuse = (problem: typeof unavailable | typeof denied) => {
  answer = Effect.fail(problem);
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

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement | null = null;

const show = (productId: string) =>
  acted(() => {
    if (root === null) {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    }
    root.render(createElement(Page, { productId }));
  });

/** The page reads the shown product again, as after a save of another tab or a photo change. */
const reload = (productId: string) =>
  Effect.promise(() =>
    act(async () => {
      const input = Option.getOrThrow(detailInput(context.legalEntityId, productId, context, 7));
      await browserRuntime.runPromise(productDetailData.refresh(input).pipe(Effect.ignore));
      await browserRuntime.runPromise(Effect.yieldNow);
    }),
  ).pipe(Effect.andThen(settle));

const text = () => container?.textContent ?? '';

beforeEach(() => {
  productDetailData.invalidate();
  shown.length = 0;
  mounts = 0;
  typeDraft = null;
});

afterEach(() => {
  act(() => {
    root?.unmount();
    container?.remove();
  });
  root = null;
  container = null;
});

it.live('a failed reload keeps the editor mounted with its draft and reports the failure; a retry clears it', () =>
  Effect.gen(function* failedReload() {
    yield* pinTestDocument;
    serve('Cable');
    yield* show('product-1');
    yield* waitUntil(() => shown.at(-1) === 'ready:Cable:current');
    yield* acted(() => typeDraft?.('Cable 2 m'));

    refuse(unavailable);
    shown.length = 0;
    yield* reload('product-1');
    yield* waitUntil(() => shown.at(-1) === 'ready:Cable:unavailable');
    expect(shown.filter((state) => !state.startsWith('ready:'))).toEqual([]);
    expect(mounts).toBe(1);
    expect(text()).toBe('Cable 2 m');

    serve('Cable B');
    yield* reload('product-1');
    yield* waitUntil(() => shown.at(-1) === 'ready:Cable B:current');
    expect(mounts).toBe(1);
    expect(text()).toBe('Cable 2 m');
  }).pipe(Effect.provide(network)),
);

it.live('a denied reload drops the shown product at once', () =>
  Effect.gen(function* deniedReload() {
    yield* pinTestDocument;
    serve('Cable');
    yield* show('product-1');
    yield* waitUntil(() => shown.at(-1) === 'ready:Cable:current');
    refuse(denied);
    yield* reload('product-1');
    yield* waitUntil(() => shown.at(-1) === 'error:forbidden');
    expect(text()).toBe('');
  }).pipe(Effect.provide(network)),
);
