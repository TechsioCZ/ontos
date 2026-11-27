import { dialogCloseLabel } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormBuilder, FormInputField, FormReact, FormRoot, useAtomSet, useAtomValue } from '@app/core-runtime/ui/form';
import { Effect, Option, Schema } from 'effect';
import type { Order } from '../../../../../shared/apis/records.ts';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';

const key = (path: string) => `merchandise.pages.orders.${path}`;

/** The optional cancellation reason. The dialog's button sends it; the form itself is never submitted. */
const cancelReasonForm = FormReact.make(FormBuilder.empty.addField('reason', Schema.String), {
  fields: { reason: FormInputField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const noReason = { reason: '' };

interface OrderCancelDialogProps {
  readonly busy: boolean;
  /** `reason` is the trimmed optional cancellation reason; e-shop customers see it in the cancellation e-mail. */
  readonly onConfirm: (orders: readonly Order[], reason: string | undefined) => void;
  readonly onDismiss: () => void;
  /** Orders awaiting cancellation; `null` keeps the dialog closed. */
  readonly orders: readonly Order[] | null;
}

const CancelDialog = ({ busy, onConfirm, onDismiss, orders }: OrderCancelDialogProps) => {
  const { t } = useModernI18n();
  const [only] = orders ?? [];
  const single = orders?.length === 1 ? only : undefined;
  const { reason } = Option.getOrElse(useAtomValue(cancelReasonForm.values), () => noReason);
  const setValues = useAtomSet(cancelReasonForm.setValues);
  const trimmed = reason.trim();
  const storefront = orders?.some((order) => order.channel === 'STOREFRONT') === true;

  return (
    <Dialog
      actions={
        <div className="flex w-full flex-wrap justify-end gap-100">
          <Button appearance="outline" className="shrink-0 whitespace-nowrap" onClick={onDismiss} severity="secondary">
            {t(key('confirm.back'))}
          </Button>
          <Button
            className="shrink-0 whitespace-nowrap"
            isLoading={busy}
            loadingText={t(key('create.submitting'))}
            onClick={() => {
              onConfirm(orders ?? [], trimmed === '' ? undefined : trimmed);
              setValues(noReason);
            }}
            severity="danger"
            style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            {single === undefined ? t(key('confirm.cancelBulkAction')) : t(key('confirm.cancelAction'))}
          </Button>
        </div>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(key('confirm.description'))}
      onOpenChange={({ open }) => {
        if (!open) {
          setValues(noReason);
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
    >
      <cancelReasonForm.reason
        id="order-cancel-reason"
        label={t('merchandise.ui.cancellationReason')}
        maxLength={500}
        name="reason"
        placeholder={t('merchandise.ui.cancellationReasonPlaceholder')}
        {...(storefront ? { helpText: 'Zákazník z e-shopu uvidí důvod v e-mailu o stornování.' } : {})}
      />
    </Dialog>
  );
};

/**
 * Destructive confirmation. Names the record when one order is cancelled, counts the rest otherwise. The reason
 * stays in its form while the dialog is closed between confirmations; confirming or dismissing clears it.
 */
export const OrderCancelDialog = (props: OrderCancelDialogProps) => {
  const { t } = useModernI18n();
  return (
    <FormRoot className="contents" defaultValues={noReason} form={cancelReasonForm} translateMessage={t}>
      <CancelDialog {...props} />
    </FormRoot>
  );
};
