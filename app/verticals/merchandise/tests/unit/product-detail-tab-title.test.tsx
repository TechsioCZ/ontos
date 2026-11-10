// @rstest-environment happy-dom
// A directly loaded product page names the browser tab after the product, over the title the Shell's frame renders
// in the same commit. Only the product read, the detail view and the router are replaced.
import { constVoid } from 'effect/Function';
import { Effect } from 'effect';
import { afterEach, beforeEach, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import ProductDetailRoute from '../../src/routes/[lang]/provoz/produkty/[id]/page.tsx';
import {
  detailInput,
  prepareProductDetail,
  productDetailData,
  productListData,
  productNavigationFailureKey,
  productRevisionOf,
  productScope,
} from '../../src/routes/[lang]/provoz/produkty/products-api.ts' with { rstest: 'importActual' };

const copy = { productName: 'product-name', productTab: 'product-name | OntOS', shellTitle: 'Domů | OntOS' } as const;

const mocks = rstest.hoisted(() => ({ ready: true }));
rstest.mock('../../src/routes/[lang]/provoz/produkty/products-api.ts', () => ({
  detailInput,
  prepareProductDetail,
  productDetailData,
  productListData,
  productNavigationFailureKey,
  productRevisionOf,
  productScope,
  useProductDetail: () =>
    mocks.ready
      ? {
          product: { categoryId: null, id: 'product-1', name: 'product-name' },
          response: { canWrite: false, movements: [], revision: 1 },
          status: 'ready',
        }
      : { status: 'loading' },
}));
rstest.mock('../../src/routes/[lang]/provoz/produkty/product-detail-dialog.tsx', () => ({
  ProductDetailView: () => null,
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ proceed: constVoid, reset: constVoid, status: 'idle' }),
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({ id: 'product-1', lang: 'cs' }),
  useRouterState: () => '',
}));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const mountPage = (lateShellTitle: boolean) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ container, root });
  act(() => {
    // The Shell's frame renders its own title in the same commit as the page.
    root.render(
      <>
        <title>{copy.shellTitle}</title>
        <ProductDetailRoute />
      </>,
    );
  });
  if (lateShellTitle) {
    // A Shell frame that commits its title after the page.
    act(() => {
      root.render(
        <>
          <title>{copy.shellTitle}</title>
          <ProductDetailRoute />
          <title>{copy.shellTitle}</title>
        </>,
      );
    });
  }
};
// The head observer answers in a microtask, as in the browser.
const mount = (lateShellTitle = false) =>
  Effect.sync(() => mountPage(lateShellTitle)).pipe(Effect.andThen(Effect.promise(() => Promise.resolve())));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.ready = true;
});

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

it.effect('names the browser tab after the product once it is loaded', () =>
  mount().pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(document.title).toBe(copy.productTab);
      }),
    ),
  ),
);

it.effect('keeps the product name when the Shell renders its title after the page', () =>
  mount(true).pipe(
    Effect.andThen(
      Effect.sync(() => {
        expect(document.title).toBe(copy.productTab);
      }),
    ),
  ),
);

it.effect('does not name the tab before the product has loaded', () =>
  Effect.sync(() => {
    mocks.ready = false;
  }).pipe(
    Effect.andThen(mount()),
    Effect.andThen(
      Effect.sync(() => {
        expect(document.title).not.toBe(copy.productTab);
      }),
    ),
  ),
);
