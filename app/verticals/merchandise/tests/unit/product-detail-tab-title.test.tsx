// @rstest-environment happy-dom
// A product page names the browser tab after the product through the Shell frame's title. Only the product read, the
// detail view and the router are replaced.
import { useDocumentTitle } from '@app/admin-ui';
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

const copy = {
  productTab: 'product-name | OntOS',
  shellName: 'shell-destination',
  shellTitle: 'shell-destination | OntOS',
} as const;

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
// The module's own head is not the tab's title in the Shell; only the frame's title is.
rstest.mock('../../src/routes/ultramodern-route-head.tsx', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];

/** The Shell's frame: its title names the record a page gives, else its own destination. */
const Frame = ({ children }: { readonly children: ReactNode }) => {
  const title = useDocumentTitle();
  return (
    <>
      <title>{`${title ?? copy.shellName} | OntOS`}</title>
      {children}
    </>
  );
};

const mount = (page: ReactNode = <ProductDetailRoute />) =>
  Effect.sync(() => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push({ container, root });
    act(() => {
      root.render(<Frame>{page}</Frame>);
    });
  });

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

it.effect('gives the tab back to the Shell once the page is left', () =>
  mount().pipe(
    Effect.andThen(
      Effect.sync(() => {
        act(() => {
          roots[0]?.root.render(<Frame>{null}</Frame>);
        });
        expect(document.title).toBe(copy.shellTitle);
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
        expect(document.title).toBe(copy.shellTitle);
      }),
    ),
  ),
);
