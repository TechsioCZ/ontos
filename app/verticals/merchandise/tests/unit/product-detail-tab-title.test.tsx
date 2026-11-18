// @rstest-environment happy-dom
// The real product page names the browser tab through the Shell frame's title.
// Its records client reaches the real HTTP contract over an in-process network.
import { useDocumentTitle } from '@app/admin-ui';
import { settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Helmet } from '@modern-js/runtime/head';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import type { ReactNode } from 'react';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import ProductDetailRoute from '../../src/routes/[lang]/provoz/produkty/[id]/page.tsx';
import { productDetailData } from '../../src/routes/[lang]/provoz/produkty/products-api.ts';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const copy = {
  productTab: 'product-name | OntOS',
  shellName: 'shell-destination',
  shellTitle: 'shell-destination | OntOS',
} as const;
const context = {
  legalEntityId: 'company-1',
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const instant = '2026-10-15T10:00:00Z';
const records = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: { principalId: context.principalId, tenantId: context.tenantId },
  canWrite: false,
  indicators: { lowStockCount: 0, openOrderValueMinor: 0, orderCount: 0, productCount: 1, stockValueMinor: 0 },
  movements: [],
  orders: [],
  products: [
    {
      active: true,
      category: 'IT',
      createdAt: instant,
      currentPriceMinor: 0,
      id: 'product-1',
      lowStock: false,
      lowStockThreshold: 0,
      name: 'product-name',
      priceHistory: [],
      sku: 'PRODUCT-1',
      stockOnHand: 0,
      stockValueMinor: 0,
      unit: 'ks',
      updatedAt: instant,
    },
  ],
  revision: 1,
});
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(records);
const OwnerRecordsApi = RecordsApi.prefix('/merchandise-api');
const owner = HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
  group.handle('execute', () => Effect.suspend(() => answer)),
);
const network = browserNetwork(
  shellGatewayIssuer({ merchandise: '/merchandise-api' }).application,
  serveApi(OwnerRecordsApi, owner),
);

/** The Shell's frame: its title names the record a page gives, else its own destination. */
const Frame = ({ children }: { readonly children: ReactNode }) => {
  const title = useDocumentTitle();
  return (
    <>
      {children}
      <Helmet>
        <title>{`${title ?? copy.shellName} | OntOS`}</title>
      </Helmet>
    </>
  );
};

const mount = () =>
  mountInRoute(
    <Frame>
      <ProductDetailRoute context={context} />
    </Frame>,
    { path: 'provoz/produkty/$id', url: '/cs/provoz/produkty/product-1' },
  );

beforeEach(() => {
  answer = Effect.succeed(records);
  productDetailData.invalidate();
});
afterEach(unmountAll);

it.live('names the browser tab after the product once it is loaded', () =>
  Effect.gen(function* loaded() {
    yield* pinTestDocument;
    yield* mount();
    yield* waitUntil(() => text().includes('product-name'));
    yield* settle;
    expect(document.title).toBe(copy.productTab);
  }).pipe(Effect.provide(network)),
);

it.live('does not name the tab before the product has loaded', () =>
  Effect.gen(function* loading() {
    yield* pinTestDocument;
    const arrived = yield* Deferred.make<boolean>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Effect.never));
    yield* mount();
    yield* Deferred.await(arrived);
    yield* settle;
    expect(text()).toContain(moduleText('cs')('merchandise.pages.products.states.loading'));
    expect(document.title).toBe(copy.shellTitle);
  }).pipe(Effect.provide(network)),
);
