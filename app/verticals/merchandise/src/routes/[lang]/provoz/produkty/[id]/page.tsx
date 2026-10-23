import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { modulePagePreload, pageDataPending } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { useEffect, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Toaster } from '@app/admin-ui';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../../runtime/page-data-hooks.ts';
import { detailInput, detailState, productDetailData, productNavigationFailureKey } from '../products-api.ts';
import type { ProductDetailState } from '../products-api.ts';
import { ProductDetailView } from '../product-detail-dialog.tsx';
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

/** The product's detail entry; an invalid route id reads and loads nothing. */
const useProductDetail = (legalEntityId: string, routeId: string): ProductDetailState => {
  const input = detailInput(legalEntityId, routeId);
  const snapshot = useSyncExternalStore(
    productDetailData.subscribe,
    () => (Option.isSome(input) ? productDetailData.snapshot(input.value) : pageDataPending),
    () => pageDataPending,
  );
  useEffect(() => {
    const cold = detailInput(legalEntityId, routeId);
    if (Option.isSome(cold)) {
      productDetailData.ensure(cold.value);
    }
  }, [legalEntityId, routeId]);
  return detailState(Option.isSome(input), snapshot);
};

interface ProductDetailPageProps {
  readonly context?: ModulePageContext | undefined;
  readonly routeParams: ProductDetailPageRouteParameters;
}

interface ProductDetailPageContentProps {
  readonly legalEntityId: string;
  readonly routeParams: ProductDetailPageRouteParameters;
}

const ProductDetailPageContent = ({ legalEntityId, routeParams }: ProductDetailPageContentProps) => {
  const { language, t } = useModernI18n();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);
  const navigate = useNavigate();
  const toaster = useToast();
  const input = detailInput(legalEntityId, routeParams.id);
  const state = useProductDetail(legalEntityId, routeParams.id);
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
  /** Reads the product again; the current record stays on screen until the fresh one lands. */
  const handleReload = () => {
    if (Option.isSome(input)) {
      browserRuntime.runFork(productDetailData.refresh(input.value));
    }
  };
  const reloadRequired = state.status === 'error' && state.reason === 'reload-required';
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
      {state.status === 'ready' ? (
        <ProductDetailView
          canWrite={state.response.canManageCatalog ?? state.response.canWrite}
          canMoveStock={state.response.canWrite}
          {...(state.response.storefrontOrigin === undefined
            ? {}
            : { storefrontOrigin: state.response.storefrontOrigin })}
          category={state.response.categoryTrails?.find((trail) => trail.id === state.product.categoryId) ?? null}
          hasCategoryTree={state.response.hasCategoryTree === true}
          key={state.product.id}
          movements={state.response.movements.filter((movement) => movement.productId === state.product.id)}
          onBack={back}
          onCommitted={committed}
          onReload={handleReload}
          product={state.product}
          revision={state.response.revision}
        />
      ) : (
        <div className="flex flex-col gap-200">
          <StatusText status={state.status === 'loading' ? 'default' : 'error'}>
            {Match.value(state).pipe(
              Match.when({ status: 'loading' }, () => k('states.loading')),
              Match.when({ status: 'invalid' }, () => k('states.invalidId')),
              Match.when({ status: 'not-found' }, () => k('states.notFound')),
              Match.when({ status: 'error' }, ({ reason }) =>
                k(
                  reason === 'reload-required'
                    ? 'states.reloadRequired'
                    : reason === 'forbidden'
                      ? 'states.forbidden'
                      : 'states.errorDescription',
                ),
              ),
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

export const ProductDetailPage = ({ context, routeParams }: ProductDetailPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ProductDetailPageContent
      key={routeParams.id}
      legalEntityId={legalEntityOf({ context })}
      routeParams={routeParams}
    />
  </FederatedI18nBoundary>
);

/** The Shell prepares the product's record before it reveals the page; an invalid id reads nothing. */
export const preloadPage = modulePagePreload((props) =>
  Option.match(detailInput(legalEntityOf(props), props.routeParams['id'] ?? ''), {
    onNone: () => Effect.void,
    onSome: (input) => productDetailData.preload(input),
  }),
);

const ProductDetailRoute = ({ context, routeParams: suppliedParams }: Partial<ProductDetailPageProps>) => {
  const params = useParams({ from: '/$lang/provoz/produkty/$id', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(ProductDetailPageRouteParams)(params);
  return (
    <ProductDetailPage
      context={context}
      routeParams={suppliedParams ?? Option.getOrElse(routeParams, () => emptyRouteParams)}
    />
  );
};
export default ProductDetailRoute;
