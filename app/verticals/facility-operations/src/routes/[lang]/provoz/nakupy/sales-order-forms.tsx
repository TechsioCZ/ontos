// The forms of one sales order: record a delivery, close with a remainder, create the invoice draft. Each keeps its
// own draft and sends it on the shared Uložit only; leaving with typed input asks first.
import { SectionCard } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect } from 'effect';
import { useState } from 'react';
import type { salesRemainder } from '../../../../../shared/commands/sales.ts';
import type { SalesOrder } from '../../../../../shared/domain/purchasing.ts';
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { addDays } from '../../../../ui/ops-agenda/deadlines.ts';
import { failureKey, parsePositiveInt, todayIso, usePurchasingT } from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const cancelLabelKey = 'facility-operations.common.cancel';

/** What every sales-order form gets from the panel. */
export interface SalesOrderFormProps {
  /** The form is finished (saved or left): the panel shows the order again. */
  readonly onDone: () => void;
  readonly order: SalesOrder;
  readonly run: RunCommand;
}

/** Runs one order command for a form: a refusal stays on the form, success toasts and closes the form. */
const useOrderCommand = ({ onDone, run }: Pick<SalesOrderFormProps, 'onDone' | 'run'>) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const send = (command: Parameters<RunCommand>[0], success: string): Effect.Effect<FormSubmitResult> => {
    setError(undefined);
    return run(command).pipe(
      Effect.map((outcome): FormSubmitResult => {
        if (!outcome.ok) {
          setError(t(failureKey(outcome.reason)));
          return refusedOutcome(outcome);
        }
        return submitDone(() => {
          toast.create({ title: k(success), type: 'success' });
          onDone();
        });
      }),
    );
  };
  return { error, send, setError };
};

export const SalesDeliverForm = ({
  onDone,
  order,
  remainder,
  run,
}: SalesOrderFormProps & { readonly remainder: ReturnType<typeof salesRemainder> }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const [deliveryDate, setDeliveryDate] = useState(todayIso);
  const [quantities, setQuantities] = useState<Readonly<Record<string, string>>>({});
  const { error, send, setError } = useOrderCommand({ onDone, run });
  // The delivery is recorded on Uložit only.
  const form = useFormSave({
    submit: () => {
      const lines = remainder
        .map(({ line }) => ({ lineId: line.id, quantity: parsePositiveInt(quantities[line.id] ?? '') }))
        .filter((entry): entry is { lineId: typeof entry.lineId; quantity: number } => entry.quantity !== undefined);
      if (lines.length === 0) {
        setError(k('sales.form.deliveryRequired'));
        return Effect.succeed<FormSubmitResult>('failed');
      }
      return send(
        { _tag: 'SalesOrderDeliver', date: deliveryDate, lines, orderId: order.id },
        'sales.messages.delivered',
      );
    },
    value: { deliveryDate, quantities },
  });
  return (
    <SectionCard title={k('sales.actions.deliver')}>
      <FormInput
        id="sales-delivery-date"
        label={k('sales.fields.deliveryDate')}
        onChange={(event) => setDeliveryDate(event.target.value)}
        type="date"
        value={deliveryDate}
      />
      {remainder.map(({ line, remaining }) => (
        <FormInput
          helpText={k('sales.form.remainingHelp', { count: remaining })}
          id={`sales-deliver-${line.id}`}
          inputMode="numeric"
          key={line.id}
          label={line.description}
          onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
          value={quantities[line.id] ?? ''}
        />
      ))}
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};

export const SalesCloseForm = ({
  closeLabel,
  onDone,
  order,
  run,
}: SalesOrderFormProps & { readonly closeLabel: string }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const [reason, setReason] = useState('');
  const { error, send } = useOrderCommand({ onDone, run });
  // The order is closed with its remainder on Uložit only; the reason is required.
  const form = useFormSave({
    isValid: (value) => value.trim() !== '',
    submit: (value) =>
      send(
        { _tag: 'SalesOrderTransition', note: value.trim(), orderId: order.id, to: 'completed' },
        'sales.messages.closed',
      ),
    value: reason,
  });
  return (
    <SectionCard title={closeLabel}>
      <FormTextarea
        id="sales-close-reason"
        label={k('sales.fields.closeReason')}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        value={reason}
      />
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};

/** The invoice of an order as the panel issues it: Finance creates the draft, then the order links it. */
export type IssueInvoice = (
  order: SalesOrder,
  issueDate: string,
  dueDate: string,
) => Effect.Effect<{ readonly number?: string | undefined; readonly ok: boolean; readonly reason?: 'vat' }>;

export const SalesInvoiceForm = ({
  issueInvoice,
  onDone,
  order,
  totalLabel,
}: Omit<SalesOrderFormProps, 'run'> & { readonly issueInvoice: IssueInvoice; readonly totalLabel: string }) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const [issueDate, setIssueDate] = useState(todayIso);
  const [dueDate, setDueDate] = useState(() => addDays(todayIso(), 14));
  const [error, setError] = useState<string>();
  // The invoice draft is created on Uložit only; the dates it opens with can be used as they are.
  const form = useFormSave({
    savableAtOnce: true,
    submit: () => {
      if (dueDate < issueDate) {
        setError(k('sales.form.dueDate'));
        return Effect.succeed<FormSubmitResult>('failed');
      }
      setError(undefined);
      return issueInvoice(order, issueDate, dueDate).pipe(
        Effect.map((outcome): FormSubmitResult => {
          if (!outcome.ok) {
            setError(k(outcome.reason === 'vat' ? 'sales.form.invoiceVatUnresolved' : 'sales.form.invoiceFailed'));
            return 'failed';
          }
          return submitDone(() => {
            toast.create({ title: k('sales.messages.invoiced', { number: outcome.number ?? '' }), type: 'success' });
            onDone();
          });
        }),
      );
    },
    value: { dueDate, issueDate },
  });
  return (
    <SectionCard title={k('sales.actions.invoice')}>
      <p className="text-fg-secondary text-sm">{k('sales.form.invoiceIntro', { customer: order.customer.name })}</p>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          id="sales-invoice-issue"
          label={k('sales.fields.issueDate')}
          onChange={(event) => setIssueDate(event.target.value)}
          type="date"
          value={issueDate}
        />
        <FormInput
          id="sales-invoice-due"
          label={k('sales.fields.dueDate')}
          onChange={(event) => setDueDate(event.target.value)}
          type="date"
          value={dueDate}
        />
      </div>
      <p className="font-semibold text-sm">{totalLabel}</p>
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};
