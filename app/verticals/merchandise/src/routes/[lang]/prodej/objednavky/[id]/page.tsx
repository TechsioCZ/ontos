import { FederatedI18nBoundary, useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext } from '@app/shared-contracts/page-data';
import { useNavigate, useParams } from '@modern-js/plugin-tanstack/runtime';
import type { RegisteredRouter } from '@tanstack/react-router';
import { Button } from '@techsio/ui-kit/atoms/button';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';
import { PageHeader, Toaster } from '@app/admin-ui';
import type { Order } from '../../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../../shared/domain/merchandise-model.ts';
import { storefrontBrandOf } from '../../../../../../shared/domain/storefront-brand.ts';
import { browserRuntime } from '../../../../../runtime/browser-effect-runtime.ts';
import { legalEntityOf } from '../../../../../runtime/page-data-hooks.ts';
import csResource from '../../../../../../locales/cs/merchandise.json';
import enResource from '../../../../../../locales/en/merchandise.json';
import { UltramodernRouteHead } from '../../../../ultramodern-route-head';
import '../../../../index.css';
import { useCustomerDirectory } from '../customers-directory.ts';
import { OrderCancelDialog } from '../order-cancel-dialog.tsx';
import { OrderDetailActions, OrderDetailContent, OrderPendingBody } from '../order-detail-content.tsx';
import { orderDetailTitle, useOrderEditing } from '../order-detail-view.ts';
import { orderNavigationFailureKey } from '../order-navigation.ts';
import type { PendingOrderDetail } from '../order-detail-content.tsx';
import { proposalToast, statusChangeNotification } from '../order-status-notice.ts';
import {
  changeOrderStatuses,
  firstOrdersPage,
  recordsCanEditOrders,
  useOrderDetail,
  useOrders,
} from '../orders-records.ts';
import type { OrderDetailState } from '../orders-records.ts';

const merchandiseI18nResources = {
  cs: { merchandise: csResource },
  en: { merchandise: enResource },
} as const;

const key = (path: string) => `merchandise.pages.orders.${path}`;

/** The order id from the route. An empty id reads as no order. */
export const OrderDetailPageRouteParams = Schema.Struct({
  id: Schema.String.pipe(Schema.brand('OrderDetailPageIdRouteParameter')),
});
export type OrderDetailPageRouteParameters = typeof OrderDetailPageRouteParams.Type;

/** Header title of the order page: the order number once it is known, otherwise the loading title. */
const orderPageTitle = ({
  detail,
  editing,
  pending,
  t,
}: {
  readonly detail: OrderDetailState;
  readonly editing: boolean;
  readonly pending: PendingOrderDetail;
  readonly t: ReturnType<typeof useModernI18n>['t'];
}) => {
  if (detail.status === 'ready') {
    return orderDetailTitle({ editing, number: detail.order.number, t });
  }
  if (pending.status === 'loading' && pending.summary !== undefined) {
    return t(key('detail.title'), { number: pending.summary.order.number });
  }
  return t(key('detail.loadingTitle'));
};

interface OrderDetailPageContentProps {
  readonly context?: ModulePageContext | undefined;
  readonly legalEntityId: string;
  /** Undefined when the route id is missing or invalid; such a page shows the not-found state. */
  readonly orderId: string | undefined;
}

const OrderDetailPageContent = ({ context, legalEntityId, orderId }: OrderDetailPageContentProps) => {
  const { language, t } = useModernI18n();
  const navigate = useNavigate();
  const toaster = useToast();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<readonly Order[] | null>(null);
  // The detail read does not carry the permissions, so the order list supplies them. One row keeps that read small.
  const list = useOrders(legalEntityId, firstOrdersPage(1), context);
  const records = list.state.kind === 'ready' ? list.state.records : undefined;
  const canWrite = records?.canWrite === true;
  const canEditOrders = records === undefined ? false : recordsCanEditOrders(records);
  const canCleanupDemo = records?.canCleanupDemo === true;
  const directory = useCustomerDirectory(legalEntityId, canEditOrders);
  const detail = useOrderDetail(orderId ?? null, version, context);
  const { editing, setEditing } = useOrderEditing(detail.status === 'ready' ? detail.order.id : undefined);
  const revision = Math.max(records?.revision ?? 0, detail.status === 'ready' ? detail.revision : 0);

  /** Every change reloads the page's order list (permissions and counts) and the open order. */
  const reload = () => {
    list.load();
    setVersion((current) => current + 1);
  };
  const navigateToList = navigate<RegisteredRouter, string>;
  const back = () => {
    void browserRuntime.runPromise(
      Effect.tryPromise(
        navigateToList.bind(undefined, {
          to: `/${language ?? 'cs'}/prodej/objednavky`,
        }),
      ).pipe(
        Effect.timeout('10 seconds'),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              const messageKey = orderNavigationFailureKey(error);
              toaster.create({ title: t(key(messageKey)), type: 'error' });
            }),
          onSuccess: Effect.succeed,
        }),
      ),
    );
  };

  const runStatusChange = (targets: readonly Order[], status: OrderStatus, reason?: string) => {
    if (detail.status !== 'ready') {
      return;
    }
    setBusy(true);
    const input: {
      -readonly [Key in keyof Parameters<typeof changeOrderStatuses>[0]]: Parameters<
        typeof changeOrderStatuses
      >[0][Key];
    } = { orders: targets, revision, status };
    if (reason !== undefined) {
      input.reason = reason;
    }
    void browserRuntime.runPromise(
      changeOrderStatuses(input).pipe(
        Effect.flatMap(({ changed, failed, proposals }) =>
          Effect.sync(() => {
            for (const proposal of proposals ?? []) {
              toaster.create(proposalToast(proposal, t));
            }
            if (changed > 0 || failed > 0) {
              toaster.create(statusChangeNotification(t, status, changed + failed, changed, failed));
            }
            setBusy(false);
            setPendingCancel(null);
            reload();
          }),
        ),
      ),
    );
  };

  /** Cancelling asks first, in the same confirm dialog as the list page. */
  const requestStatus = (order: Order, status: OrderStatus) => {
    if (status === 'CANCELLED') {
      setPendingCancel([order]);
      return;
    }
    runStatusChange([order], status);
  };

  const handleEdited = (message: string) => {
    toaster.create({ title: message, type: 'success' });
    reload();
  };

  // Not-ready states reuse the panel's pending body; a missing id reads as not found.
  const pending: PendingOrderDetail =
    detail.status === 'idle' || detail.status === 'ready' ? { status: 'not-found' } : detail;
  const title = orderPageTitle({ detail, editing, pending, t });

  return (
    <>
      <UltramodernRouteHead />
      <section className="flex flex-col gap-200">
        <PageHeader
          actions={
            detail.status === 'ready' ? (
              <OrderDetailActions
                busy={busy}
                canCleanupDemo={canCleanupDemo}
                canEditOrders={canEditOrders}
                canWrite={canWrite}
                customers={directory}
                editing={editing}
                onClose={back}
                onEditingChange={setEditing}
                onStatus={requestStatus}
                order={detail.order}
              />
            ) : undefined
          }
          breadcrumbs={
            <div>
              <Button icon="icon-[mdi--arrow-left]" onClick={back} size="sm" theme="outlined" variant="secondary">
                {t(key('detail.backToList'))}
              </Button>
            </div>
          }
          title={title}
        />
        {detail.status === 'ready' ? (
          <OrderDetailContent
            brand={storefrontBrandOf(legalEntityId)}
            busy={busy}
            canCleanupDemo={canCleanupDemo}
            canEditOrders={canEditOrders}
            canWrite={canWrite}
            currentPrincipalId={records?.actorPrincipalRef.principalId}
            customers={directory}
            detail={detail}
            editing={editing}
            onClose={back}
            onEdited={handleEdited}
            onEditingChange={setEditing}
            revision={revision}
          />
        ) : (
          <div className="flex flex-col gap-200">
            <OrderPendingBody customers={directory} detail={pending} />
            {detail.status === 'error' && (
              <Button onClick={reload} size="sm" theme="outlined" variant="secondary">
                {t(key('states.retry'))}
              </Button>
            )}
          </div>
        )}
      </section>
      <OrderCancelDialog
        busy={busy}
        onConfirm={(targets, reason) => runStatusChange(targets, 'CANCELLED', reason)}
        onDismiss={() => setPendingCancel(null)}
        orders={pendingCancel}
      />
      <Toaster />
    </>
  );
};

export const OrderDetailPage = ({
  context,
  orderId,
}: {
  readonly context?: ModulePageContext | undefined;
  readonly orderId: string | undefined;
}) => (
  <FederatedI18nBoundary
    defaultNamespace="merchandise"
    fallbackLanguage="en"
    resources={merchandiseI18nResources}
    supportedLanguages={['en', 'cs']}
  >
    <OrderDetailPageContent
      context={context}
      key={`${pageDataScopeKey(context, 'demo.merchandise') ?? ''}|${orderId ?? ''}`}
      legalEntityId={legalEntityOf({ context })}
      orderId={orderId}
    />
  </FederatedI18nBoundary>
);

const OrderDetailRoute = ({ context }: { readonly context?: ModulePageContext | undefined }) => {
  const params: unknown = useParams({ from: '/$lang/prodej/objednavky/$id', shouldThrow: false });
  const routeParams = Schema.decodeUnknownOption(OrderDetailPageRouteParams)(params);
  const orderId = Option.isSome(routeParams) && routeParams.value.id !== '' ? routeParams.value.id : undefined;
  return <OrderDetailPage context={context} orderId={orderId} />;
};

export default OrderDetailRoute;
