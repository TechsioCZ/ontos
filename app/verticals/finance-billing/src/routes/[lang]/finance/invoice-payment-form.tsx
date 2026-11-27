// Records a manual payment of one invoice. Typing changes only the draft; the shared Uložit opens a review of the
// payment, and only its confirmation records it, once. Uložit in the leave question opens the same review.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatMoney } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormBuilder, FormReact, FormRoot, TextField, useAtomSet } from '@app/core-runtime/ui/form';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Schema } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import type { FinanceFormSave } from './finance-form-save.tsx';
import { PaymentReview } from './payment-review.tsx';
import { parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

/** The payment as typed: the amount and the date as their input text. Uložit opens the review, so the form only holds it. */
const paymentForm = FormReact.make(
  FormBuilder.empty.addField('amount', Schema.String).addField('note', Schema.String).addField('paidOn', Schema.String),
  {
    fields: { amount: TextField, note: TextField, paidOn: TextField },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

type PaymentDraft = typeof paymentForm.schema.Encoded;

const paymentAmount = paymentForm.getFieldAtoms(paymentForm.fields.amount);

/** Why the payment cannot be recorded yet, or undefined when it can. */
const paymentProblem = (draft: PaymentDraft, remaining: number): string | undefined => {
  const amountMinor = parseAmountMinor(draft.amount);
  if (amountMinor === undefined || amountMinor === 0) {
    return 'Zadejte kladnou částku.';
  }
  return amountMinor > remaining ? `Částka přesahuje zbývajících ${formatMoney(remaining)}.` : undefined;
};

const paymentCommand = (amountMinor: number, draft: PaymentDraft, invoice: Invoice, vm: FinanceViewModel) => {
  const command: FinanceCommandDraft<'RecordManualPayment'> = {
    _tag: 'RecordManualPayment',
    amountMinor,
    invoiceRef: invoice.ref,
    paidOn: draft.paidOn === '' ? vm.referenceDate : draft.paidOn,
  };
  if (vm.actorLabel !== undefined) {
    command.actorLabel = vm.actorLabel;
  }
  if (draft.note.trim() !== '') {
    command.note = draft.note.trim();
  }
  return command;
};

/** Where the review is: closed, open for the person to confirm, or confirmed and recording. */
const ReviewStepSchema = Schema.Literals(['closed', 'confirmed', 'open']);
type ReviewStep = typeof ReviewStepSchema.Type;

const paymentCommandOf = (draft: PaymentDraft, invoice: Invoice, vm: FinanceViewModel) => {
  const amountMinor = parseAmountMinor(draft.amount);
  return amountMinor === undefined ? undefined : paymentCommand(amountMinor, draft, invoice, vm);
};

export const InvoicePaymentForm = ({
  invoice,
  onClose,
  remaining,
  vm,
}: {
  readonly invoice: Invoice;
  readonly onClose: () => void;
  readonly remaining: number;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const initial: PaymentDraft = { amount: '', note: '', paidOn: vm.referenceDate };
  const { draft, ready, reset } = useFormDraft(paymentForm, initial);
  const setAmount = useAtomSet(paymentAmount.setValue);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => paymentProblem(value, remaining) === undefined,
    onClose,
    reset,
    send: (value) => {
      const command = paymentCommandOf(value, invoice, vm);
      return command === undefined ? undefined : vm.execute(command, 'Úhrada zaznamenána');
    },
    value: draft,
    vm,
  });
  const [review, setReview] = useState<ReviewStep>('closed');
  const amountMinor = parseAmountMinor(draft.amount);
  const problem = form.record.status === 'invalid' ? paymentProblem(draft, remaining) : undefined;
  const saving = form.record.status === 'saving';
  // A confirmed review stays up while the payment is recorded; a failure brings the form back with its reason.
  const reviewOpen = review === 'open' || (review === 'confirmed' && saving);
  const openReview = () => setReview('open');
  /** Uložit, in the footer and in the leave question, asks for the review first; it never records by itself. */
  const reviewed: FinanceFormSave = {
    ...form,
    guard: {
      ...form.guard,
      prompt: {
        ...form.guard.prompt,
        onSave: () => {
          form.guard.prompt.onStay();
          openReview();
        },
      },
    },
    handleSave: openReview,
  };
  return (
    <FinanceFormDialog
      description={`Zbývá uhradit ${formatMoney(remaining)} z ${formatMoney(invoice.totalMinor)}.`}
      form={reviewed}
      size="sm"
      title={t('finance-billing.financeUi.payments.record')}
    >
      <PaymentReview
        amountMinor={amountMinor ?? 0}
        invoice={invoice}
        onBack={() => setReview('closed')}
        onConfirm={() => {
          setReview('confirmed');
          form.handleSave();
        }}
        open={reviewOpen}
        paidOn={draft.paidOn === '' ? vm.referenceDate : draft.paidOn}
        remaining={remaining}
        saving={saving}
      />
      <FormRoot className="flex flex-col gap-150" defaultValues={initial} form={paymentForm} translateMessage={t}>
        {ready}
        {problem !== undefined && (
          <StatusText showIcon size="sm" status="warning">
            {problem}
          </StatusText>
        )}
        <paymentForm.amount
          helpText={amountMinor === undefined ? undefined : formatMoney(amountMinor)}
          id="payment-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.common.amount')}
          placeholder={(remaining / 100).toFixed(0)}
          size="sm"
        />
        <div className="flex gap-100">
          <Button
            appearance="ghost"
            onClick={() => setAmount(String(remaining / 100).replace('.', ','))}
            severity="secondary"
            size="sm"
          >
            Celý zbytek
          </Button>
        </div>
        <paymentForm.paidOn
          id="payment-date"
          label={t('finance-billing.financeUi.payments.date')}
          size="sm"
          type="date"
        />
        <paymentForm.note id="payment-note" label={t('finance-billing.financeUi.payments.note')} size="sm" />
      </FormRoot>
    </FinanceFormDialog>
  );
};
