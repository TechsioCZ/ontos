import { dialogCloseLabel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import type { Order } from '../../../../../shared/apis/records.ts';

const key = (path: string) => `merchandise.pages.orders.${path}`;

interface OrderCancelDialogProps {
  readonly busy: boolean;
  readonly onConfirm: (orders: readonly Order[]) => void;
  readonly onDismiss: () => void;
  /** Orders awaiting cancellation; `null` keeps the dialog closed. */
  readonly orders: readonly Order[] | null;
}

/** Destructive confirmation. Names the record when one order is cancelled, counts the rest otherwise. */
export const OrderCancelDialog = ({ busy, onConfirm, onDismiss, orders }: OrderCancelDialogProps) => {
  const { t } = useModernI18n();
  const [only] = orders ?? [];
  const single = orders?.length === 1 ? only : undefined;

  return (
    <Dialog
      actions={
        <>
          <Button onClick={onDismiss} theme="outlined" variant="secondary">
            {t(key('confirm.back'))}
          </Button>
          <Button
            isLoading={busy}
            loadingText={t(key('create.submitting'))}
            onClick={() => onConfirm(orders ?? [])}
            variant="danger"
          >
            {single === undefined ? t(key('confirm.cancelBulkAction')) : t(key('confirm.cancelAction'))}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(key('confirm.description'))}
      onOpenChange={({ open }) => {
        if (!open) {
          onDismiss();
        }
      }}
      open={orders !== null}
      role="alertdialog"
      size="sm"
      title={
        single === undefined
          ? t(key('confirm.cancelBulkTitle'))
          : t(key('confirm.cancelTitle'), { number: single.number })
      }
    />
  );
};
