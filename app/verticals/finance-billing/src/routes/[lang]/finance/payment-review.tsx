// The review of a manual payment before the irreversible write: invoice, amount, date and what remains after it.
// Uložit of the payment form opens it; only its confirm button records the payment.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel, formatDate, formatMoney } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import type { Invoice } from '../../../../shared/apis/records.ts';

const P = 'finance-billing.financeUi.payments';

export interface PaymentReviewProps {
  readonly amountMinor: number;
  readonly invoice: Invoice;
  /** Zpět: back to the form, nothing is recorded. */
  readonly onBack: () => void;
  /** Records the payment once. */
  readonly onConfirm: () => void;
  readonly open: boolean;
  readonly paidOn: string;
  readonly remaining: number;
  readonly saving: boolean;
}

export const PaymentReview = ({
  amountMinor,
  invoice,
  onBack,
  onConfirm,
  open,
  paidOn,
  remaining,
  saving,
}: PaymentReviewProps) => {
  const { t } = useModernI18n();
  return (
    <Dialog
      actions={
        <>
          <Button disabled={saving} onClick={onBack} theme="outlined" variant="secondary">
            {t(`${P}.reviewBack`)}
          </Button>
          <Button disabled={saving} isLoading={saving} onClick={onConfirm} variant="primary">
            {t(`${P}.reviewConfirm`)}
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={t(`${P}.reviewDescription`)}
      onOpenChange={(details) => {
        if (!details.open && !saving) {
          onBack();
        }
      }}
      open={open}
      placement="center"
      role="alertdialog"
      size="sm"
      title={t(invoice.direction === 'INCOMING' ? `${P}.reviewIncoming` : `${P}.reviewOutgoing`)}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-300 gap-y-100 text-sm" data-testid="payment-review">
        <dt className="text-fg-secondary">{t(`${P}.reviewInvoice`)}</dt>
        <dd>{invoice.number ?? invoice.documentNumber}</dd>
        <dt className="text-fg-secondary">{t('finance-billing.financeUi.common.amount')}</dt>
        <dd className="font-semibold tabular-nums">{formatMoney(amountMinor)}</dd>
        <dt className="text-fg-secondary">{t(`${P}.date`)}</dt>
        <dd>{formatDate(paidOn)}</dd>
        <dt className="text-fg-secondary">{t(`${P}.reviewRemaining`)}</dt>
        <dd className="tabular-nums">{formatMoney(remaining - amountMinor)}</dd>
      </dl>
    </Dialog>
  );
};
