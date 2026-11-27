// The document kind of a draft invoice. Picking a kind writes nothing: a confirmation names the change, and only
// its confirm button sends SetInvoiceDetails, once. Until then the picker keeps showing the saved kind.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { dialogCloseLabel } from '@app/admin-ui';
import {
  FormBuilder,
  FormReact,
  FormRoot,
  SelectTemplateField,
  useAtomSet,
  useAtomSubscribe,
} from '@app/core-runtime/ui/form';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Effect, Option, Schema } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../runtime/browser.ts';
import type { FinanceViewModel } from './finance-ui.tsx';

type DocumentKind = NonNullable<Invoice['documentKind']>;

const P = 'finance-billing.financeUi.documentKind';
/** Every kind, in the order the picker lists them. */
const KINDS: readonly DocumentKind[] = ['ADVANCE', 'FINAL', 'PARTIAL', 'RECURRING', 'STANDARD'];

/**
 * The picker of the one invoice detail on screen. It only asks: a picked kind opens the confirmation and the picker
 * goes back to the saved kind.
 */
const documentKindForm = FormReact.make(FormBuilder.empty.addField('kind', Schema.String), {
  fields: { kind: SelectTemplateField },
  onSubmit: () => Effect.void,
  runtime: financeBrowserAtomRuntime,
});
const pickedKind = documentKindForm.getFieldAtoms(documentKindForm.fields.kind);

/** Hands a kind other than the saved one to the confirmation and shows the saved kind again. */
const KindPicked = ({
  current,
  onPicked,
}: {
  readonly current: DocumentKind;
  readonly onPicked: (kind: DocumentKind) => void;
}) => {
  const setKind = useAtomSet(pickedKind.setValue);
  useAtomSubscribe(
    pickedKind.value,
    (value) => {
      const next = KINDS.find((kind) => Option.contains(value, kind));
      if (next !== undefined && next !== current) {
        onPicked(next);
        setKind(current);
      }
    },
    // Immediate: a subscription that does not read the value first never hears a change of a value not read yet.
    { immediate: true },
  );
  return null;
};

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
  // A newly saved kind starts the picker afresh.
  return (
    <>
      <FormRoot defaultValues={{ kind: current }} form={documentKindForm} key={current} translateMessage={t}>
        <KindPicked current={current} onPicked={setPicked} />
        <documentKindForm.kind
          disabled={disabled}
          items={KINDS.map((kind) => ({ displayValue: kinds[kind], label: kinds[kind], value: kind }))}
          label={t('finance-billing.financeUi.common.documentKind')}
          labelProps={{ className: 'font-label text-label-sm' }}
          size="sm"
        />
      </FormRoot>
      <Dialog
        actions={
          <>
            <Button appearance="outline" disabled={sending} onClick={handleCancel} severity="secondary">
              {t('finance-billing.financeUi.common.cancel')}
            </Button>
            <Button disabled={sending} isLoading={sending} onClick={handleConfirm} severity="primary">
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
