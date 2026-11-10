import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { SidePanel } from '@app/admin-ui';
import { useState } from 'react';
import type { Order } from '../../../../../shared/apis/records.ts';
import type { OrderStatus } from '../../../../../shared/domain/merchandise-model.ts';
import type { CustomerDirectory } from './customers-directory.ts';
import type { OrderDetailState } from './orders-records.ts';
import { OrderDetailActions, OrderDetailContent, OrderPendingBody } from './order-detail-content.tsx';
import { orderDetailTitle, useOrderEditing } from './order-detail-view.ts';
import type { PendingOrderDetail } from './order-detail-content.tsx';

interface OrderDetailDialogProps {
  /** The company's e-shop brand (`storefrontBrandOf`); names e-shop orders and personal pickup. */
  readonly brand?: string | undefined;
  readonly busy: boolean;
  readonly canCleanupDemo?: boolean;
  readonly canEditOrders?: boolean;
  readonly canWrite: boolean;
  readonly currentPrincipalId: string | undefined;
  readonly customers: CustomerDirectory;
  /** The open order with its line products and whether it took goods from stock (quantity edits then move stock). */
  readonly detail: OrderDetailState;
  readonly onClose: () => void;
  readonly onEdited: (message: string) => void;
  readonly onStatus: (order: Order, status: OrderStatus) => void;
  readonly revision: number;
}

/** Read-only loading panel: an authorized list row still gives the header while the enriched detail lands. */
const OrderLoadingPanel = ({
  customers,
  detail,
  onClose,
}: {
  readonly customers: CustomerDirectory;
  readonly detail: PendingOrderDetail;
  readonly onClose: () => void;
}) => {
  const { t } = useModernI18n();
  const summary = detail.status === 'loading' ? detail.summary : undefined;
  return (
    <SidePanel
      actions={
        <Button onClick={onClose} size="sm" theme="outlined" variant="secondary">
          {t('merchandise.pages.orders.detail.close')}
        </Button>
      }
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      peek
      resizeLabel={t('merchandise.sidePanel.resize')}
      size="xl"
      title={
        summary === undefined
          ? t('merchandise.pages.orders.detail.loadingTitle')
          : t('merchandise.pages.orders.detail.title', { number: summary.order.number })
      }
    >
      <OrderPendingBody customers={customers} detail={detail} />
    </SidePanel>
  );
};

/**
 * The order detail as a quick-view side panel. It does not block the list behind it. While the order is edited the
 * panel is modal, its footer holds the edit form's actions, and closing it asks first while something is unsaved:
 * the form's unsaved-changes guard is inside the panel, which asks it on its own.
 */
export const OrderDetailDialog = ({
  brand,
  busy,
  canCleanupDemo = false,
  canWrite,
  canEditOrders = canWrite,
  currentPrincipalId,
  customers,
  detail,
  onClose,
  onEdited,
  onStatus,
  revision,
}: OrderDetailDialogProps) => {
  const { t } = useModernI18n();
  const { editing, setEditing } = useOrderEditing(detail.status === 'ready' ? detail.order.id : undefined);
  // The footer element the edit form renders its actions into, so the Save button stays in the panel footer.
  const [editActions, setEditActions] = useState<HTMLElement | null>(null);
  if (detail.status === 'idle') {
    return null;
  }
  if (detail.status !== 'ready') {
    return <OrderLoadingPanel customers={customers} detail={detail} onClose={onClose} />;
  }
  const { order } = detail;

  return (
    <SidePanel
      actions={
        editing ? (
          <div className="contents" ref={setEditActions} />
        ) : (
          <OrderDetailActions
            busy={busy}
            canCleanupDemo={canCleanupDemo}
            canEditOrders={canEditOrders}
            canWrite={canWrite}
            customers={customers}
            editing={editing}
            onClose={onClose}
            onStatus={onStatus}
            order={order}
          />
        )
      }
      onOpenChange={(next) => {
        if (!next) {
          setEditing(false);
          onClose();
        }
      }}
      open
      peek={!editing}
      resizeLabel={t('merchandise.sidePanel.resize')}
      size="xl"
      title={orderDetailTitle({ editing, number: order.number, t })}
    >
      <OrderDetailContent
        brand={brand}
        busy={busy}
        canCleanupDemo={canCleanupDemo}
        canEditOrders={canEditOrders}
        canWrite={canWrite}
        currentPrincipalId={currentPrincipalId}
        customers={customers}
        detail={detail}
        editActionsSlot={editActions}
        editing={editing}
        onClose={onClose}
        onEdited={onEdited}
        onEditingChange={setEditing}
        revision={revision}
      />
    </SidePanel>
  );
};
