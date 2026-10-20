import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Match, Option, Result, Schema } from 'effect';
import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Toaster } from '@app/admin-ui';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { createProductDetailQuery, productNavigationFailureKey } from '../products-api.ts';
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

interface ProductDetailPageProps {
  readonly routeParams: ProductDetailPageRouteParameters;
}

const ProductDetailPageContent = ({ routeParams }: ProductDetailPageProps) => {
  const { language, t } = useModernI18n();
  const k = (path: string) => t(`merchandise.pages.products.${path}`);
  const navigate = useNavigate();
  const toaster = useToast();
  const [query, setQuery] = useState(() => createProductDetailQuery(routeParams.id));
  const state = useSyncExternalStore(query.subscribe, query.getSnapshot, query.getServerSnapshot);
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
  const handleReload = () => {
    query.reload();
  };
  const reloadRequired =
    (state.status === 'error' && state.reason === 'reload-required') ||
    (state.status === 'ready' && state.refreshFailure === 'reload-required');
  const handleRetry = () => {
    if (reloadRequired) {
      window.location.reload();
      return;
    }
    setQuery(createProductDetailQuery(routeParams.id));
  };
  const committed = (message: string) => {
    toaster.create({ title: message, type: 'success' });
    query.reload();
  };
  return (
    <>
      <UltramodernRouteHead />
      {state.status === 'ready' && state.refreshFailure !== undefined && (
        <div className="flex flex-col gap-200">
          <StatusText status="warning">
            {k(reloadRequired ? 'states.reloadRequired' : 'states.errorDescription')}
          </StatusText>
          {reloadRequired && (
            <Button onClick={handleRetry} variant="secondary">
              {k('common.reloadPage')}
            </Button>
          )}
        </div>
      )}
      {state.status === 'ready' ? (
        <ProductDetailView
          canWrite={state.response.canManageCatalog ?? state.response.canWrite}
          canMoveStock={state.response.canWrite}
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

export const ProductDetailPage = ({ routeParams }: ProductDetailPageProps) => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <ProductDetailPageContent key={routeParams.id} routeParams={routeParams} />
  </FederatedI18nBoundary>
);

const ProductDetailRoute = ({ routeParams: suppliedParams }: Partial<ProductDetailPageProps>) => {
  const params = useParams({ from: '/$lang/provoz/produkty/$id', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(ProductDetailPageRouteParams)(params);
  return <ProductDetailPage routeParams={suppliedParams ?? Option.getOrElse(routeParams, () => emptyRouteParams)} />;
};
export default ProductDetailRoute;
