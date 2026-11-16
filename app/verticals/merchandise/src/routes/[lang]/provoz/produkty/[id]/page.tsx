import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { companyVatOf } from '../product-tax-classification.ts';
import { modulePagePreload } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { constUndefined } from 'effect/Function';
import { useState } from 'react';
import { useNavigate, useParams, useRouterState } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { DocumentTitle, Toaster } from '@app/admin-ui';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../../runtime/page-data-hooks.ts';
import {
  detailInput,
  prepareProductDetail,
  productDetailData,
  productListData,
  productNavigationFailureKey,
  productRevisionOf,
  productScope,
  useProductDetail,
} from '../products-api.ts';
import { ProductDetailView } from '../product-detail-dialog.tsx';
import type { ProductDetailTab } from '../product-detail-dialog.tsx';
import { productVariantIdFromSearch } from '../product-variant-destination.ts';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import csResource from '../../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../../locales/en/merchandise.json';
import '../../../../index.css';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

export const ProductDetailPageRouteParams = Schema.Struct({
  id: Schema.String.pipe(Schema.brand('ProductDetailPageIdRouteParameter')),
});
export type ProductDetailPageRouteParameters = typeof ProductDetailPageRouteParams.Type;
export const ProductDetailPageRouteParamsStandardSchema = Schema.toStandardSchemaV1(ProductDetailPageRouteParams);

const emptyRouteParams = Result.getOrThrow(Schema.decodeResult(ProductDetailPageRouteParams)({ id: '' }));

interface ProductDetailPageProps {
  readonly context?: ModulePageContext | undefined;
  readonly routeParams: ProductDetailPageRouteParameters;
  readonly search?: string | undefined;
}

interface ProductDetailPageContentProps {
  readonly context?: ModulePageContext | undefined;
  readonly legalEntityId: string;
  readonly routeParams: ProductDetailPageRouteParameters;
  readonly search: string;
}

const productFailureKey = (reason: string) => {
  if (reason === 'reload-required') {
    return 'states.reloadRequired';
  }
  return reason === 'forbidden' ? 'states.forbidden' : 'states.errorDescription';
};

const ProductDetailPageContent = ({ context, legalEntityId, routeParams, search }: ProductDetailPageContentProps) => {
  const { language, t } = useModernI18n();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);
  const navigate = useNavigate();
  const toaster = useToast();
  const revisionHint = productRevisionOf(search);
  const variantId = productVariantIdFromSearch(search);
  const input = detailInput(legalEntityId, routeParams.id, context, revisionHint);
  // The page keeps the active tab, so it survives an editor remount (a failed reload, another product).
  const [tab, setTab] = useState<ProductDetailTab>(() => (variantId === undefined ? 'detail' : 'variants'));
  const [variantTabKey, setVariantTabKey] = useState(variantId);
  if (variantTabKey !== variantId) {
    setVariantTabKey(variantId);
    if (variantId !== undefined) {
      setTab('variants');
    }
  }
  const [refreshVersion, setRefreshVersion] = useState(0);
  const state = useProductDetail(legalEntityId, routeParams.id, context, revisionHint, refreshVersion);
  const back = () => {
    void browserRuntime.runPromise(
      Effect.tryPromise(navigate.bind(undefined, { to: `/${language ?? 'cs'}/provoz/produkty` })).pipe(
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              const messageKey = productNavigationFailureKey(error);
              toaster.create({ title: k(messageKey), type: 'error' });
            }),
          onSuccess: Effect.succeed,
        }),
      ),
    );
  };
  /** An explicit retry revalidates the owner; a denied refresh cannot keep old fields or actions. */
  const handleReload = () => {
    productListData.invalidate();
    if (Option.isSome(input) && input.value.scope !== undefined) {
      browserRuntime.runFork(productDetailData.refresh(input.value));
    }
    setRefreshVersion((current) => current + 1);
  };
  const failure = Match.value(state).pipe(
    Match.when({ status: 'error' }, ({ reason }) => reason),
    Match.when({ status: 'ready' }, ({ reloadFailure }) => reloadFailure),
    Match.orElse(constUndefined),
  );
  const reloadRequired = failure === 'reload-required';
  const handleRetry = () => {
    if (reloadRequired) {
      window.location.reload();
      return;
    }
    handleReload();
  };
  const committed = (message: string) => {
    toaster.create({ title: message, type: 'success' });
    handleReload();
  };
  return (
    <>
      <UltramodernRouteHead />
      <DocumentTitle title={state.status === 'ready' ? state.product.name : undefined} />
      {/* A failed reload of the product on screen keeps the editor and its unsaved drafts; it only says so. */}
      {state.status === 'ready' && failure !== undefined && (
        <div className="flex flex-wrap items-center gap-200">
          <StatusText showIcon status="error">
            {k(reloadRequired ? 'states.reloadRequired' : 'states.reloadFailed')}
          </StatusText>
          <Button onClick={handleRetry} size="sm" theme="outlined" variant="secondary">
            {k(reloadRequired ? 'common.reloadPage' : 'common.retry')}
          </Button>
        </div>
      )}
      {state.status === 'ready' ? (
        <ProductDetailView
          canMoveStock={state.response.canWrite}
          canWrite={state.response.canManageCatalog ?? state.response.canWrite}
          {...(state.response.storefrontOrigin === undefined
            ? {}
            : { storefrontOrigin: state.response.storefrontOrigin })}
          category={state.response.categoryTrails?.find((trail) => trail.id === state.product.categoryId) ?? null}
          hasCategoryTree={state.response.hasCategoryTree === true}
          key={state.product.id}
          markets={{
            canManage: state.response.canManageMarkets === true,
            entries: state.response.productMarkets ?? [],
          }}
          movements={state.response.movements.filter((movement) => movement.productId === state.product.id)}
          onBack={back}
          onCommitted={committed}
          onReload={handleReload}
          onTabChange={setTab}
          product={state.product}
          revision={state.response.revision}
          tab={tab}
          variantId={variantId}
          vat={companyVatOf(state.response)}
        />
      ) : (
        <div className="flex flex-col gap-200">
          <StatusText status={state.status === 'loading' ? 'default' : 'error'}>
            {Match.value(state).pipe(
              Match.when({ status: 'loading' }, () => k('states.loading')),
              Match.when({ status: 'invalid' }, () => k('states.invalidId')),
              Match.when({ status: 'not-found' }, () => k('states.notFound')),
              Match.when({ status: 'error' }, ({ reason }) => k(productFailureKey(reason))),
              Match.exhaustive,
            )}
          </StatusText>
          {state.status === 'error' && (
            <Button onClick={handleRetry} variant="secondary">
              {k(reloadRequired ? 'common.reloadPage' : 'common.retry')}
            </Button>
          )}
          <Button onClick={back} theme="outlined" variant="secondary">
            {k('detail.back')}
          </Button>
        </div>
      )}
      <Toaster />
    </>
  );
};

export const ProductDetailPage = ({ context, routeParams, search = '' }: ProductDetailPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ProductDetailPageContent
      context={context}
      key={`${productScope(context) ?? ''}|${routeParams.id}`}
      legalEntityId={legalEntityOf({ context })}
      routeParams={routeParams}
      search={search}
    />
  </FederatedI18nBoundary>
);

/** The Shell prepares the product's record before it reveals the page; an invalid id reads nothing. */
export const preloadPage = modulePagePreload(prepareProductDetail);

const ProductDetailRoute = ({
  context,
  routeParams: suppliedParams,
  search: suppliedSearch,
}: Partial<ProductDetailPageProps>) => {
  const params: unknown = useParams({ from: '/$lang/provoz/produkty/$id', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(ProductDetailPageRouteParams)(params);
  const search = useRouterState({ select: (state) => state.location.searchStr });
  return (
    <ProductDetailPage
      context={context}
      routeParams={suppliedParams ?? Option.getOrElse(routeParams, () => emptyRouteParams)}
      search={suppliedSearch ?? search}
    />
  );
};
export default ProductDetailRoute;
