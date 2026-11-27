// Records a manual payment of one invoice. Typing changes only the draft; the shared Uložit opens a review of the
// payment, and only its confirmation records it, once. Uložit in the leave question opens the same review.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatMoney } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Schema } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceFormSave } from './finance-form-save.tsx';
import { PaymentReview } from './payment-review.tsx';
import { parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

interface PaymentDraft {
  readonly amount: string;
  readonly note: string;
  readonly paidOn: string;
}

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
  const [draft, setDraft] = useState(initial);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => paymentProblem(value, remaining) === undefined,
    onClose,
    reset: setDraft,
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
      <div className="flex flex-col gap-150">
        {problem !== undefined && (
          <StatusText showIcon size="sm" status="warning">
            {problem}
          </StatusText>
        )}
        <FormInput
          helpText={amountMinor === undefined ? undefined : formatMoney(amountMinor)}
          id="payment-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.common.amount')}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, amount: value }));
          }}
          placeholder={(remaining / 100).toFixed(0)}
          size="sm"
          value={draft.amount}
        />
        <div className="flex gap-100">
          <Button
            onClick={() => setDraft((current) => ({ ...current, amount: String(remaining / 100).replace('.', ',') }))}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            Celý zbytek
          </Button>
        </div>
        <FormInput
          id="payment-date"
          label={t('finance-billing.financeUi.payments.date')}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, paidOn: value }));
          }}
          size="sm"
          type="date"
          value={draft.paidOn}
        />
        <FormInput
          id="payment-note"
          label={t('finance-billing.financeUi.payments.note')}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, note: value }));
          }}
          size="sm"
          value={draft.note}
        />
      </div>
    </FinanceFormDialog>
  );
};
