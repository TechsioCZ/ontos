// The document kind of a draft invoice. Picking a kind writes nothing: a confirmation names the change, and only
// its confirm button sends SetInvoiceDetails, once. Until then the picker keeps showing the saved kind.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import type { FinanceViewModel } from './finance-ui.tsx';

type DocumentKind = NonNullable<Invoice['documentKind']>;

const P = 'finance-billing.financeUi.documentKind';
/** Every kind, in the order the picker lists them. */
const KINDS: readonly DocumentKind[] = ['ADVANCE', 'FINAL', 'PARTIAL', 'RECURRING', 'STANDARD'];

export interface DocumentKindSelectProps {
  readonly disabled: boolean;
  readonly invoice: Invoice;
  /** The readable name of each kind. */
  readonly kinds: Readonly<Record<DocumentKind, string>>;
  readonly vm: FinanceViewModel;
}

export const DocumentKindSelect = ({ disabled, invoice, kinds, vm }: DocumentKindSelectProps) => {
  const { t } = useModernI18n();
  const current = invoice.documentKind ?? 'STANDARD';
  /** The kind picked and waiting for confirmation. */
  const [picked, setPicked] = useState<DocumentKind>();
  const [sending, setSending] = useState(false);
  const handleCancel = () => setPicked(undefined);
  const handleConfirm = () => {
    if (picked === undefined) {
      return;
    }
    setSending(true);
    financeBrowserRuntime.runFork(
      vm
        .execute({ _tag: 'SetInvoiceDetails', documentKind: picked, invoiceRef: invoice.ref }, 'Druh dokladu uložen')
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              setSending(false);
              setPicked(undefined);
            }),
          ),
        ),
    );
  };
  return (
    <>
      <SelectTemplate
        disabled={disabled}
        items={KINDS.map((kind) => ({ displayValue: kinds[kind], label: kinds[kind], value: kind }))}
        label={t('finance-billing.financeUi.common.documentKind')}
        labelProps={{ className: 'font-label text-label-sm' }}
        onValueChange={({ value }) => {
          const next = KINDS.find((kind) => kind === value[0]);
          if (next !== undefined && next !== current) {
            setPicked(next);
          }
        }}
        size="sm"
        value={[current]}
      />
      <Dialog
        actions={
          <>
            <Button disabled={sending} onClick={handleCancel} theme="outlined" variant="secondary">
              {t('finance-billing.financeUi.common.cancel')}
            </Button>
            <Button disabled={sending} isLoading={sending} onClick={handleConfirm} variant="primary">
              {t(`${P}.confirm`)}
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={t(`${P}.description`, {
          from: kinds[current],
          to: picked === undefined ? '' : kinds[picked],
        })}
        onOpenChange={(details) => {
          if (!details.open && !sending) {
            handleCancel();
          }
        }}
        open={picked !== undefined}
        placement="center"
        role="alertdialog"
        size="sm"
        title={t(`${P}.title`)}
      />
    </>
  );
};
