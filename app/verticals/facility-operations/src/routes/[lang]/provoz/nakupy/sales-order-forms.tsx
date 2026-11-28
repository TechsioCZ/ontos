// The forms of one sales order: record a delivery, close with a remainder, create the invoice draft. Each keeps its
// own values in an effect-form form and sends them on the shared Uložit only; leaving with typed input asks first.
import { SectionCard } from '@app/admin-ui';
import { EntryTextField, FormBuilder, FormReact, FormRoot, TextAreaField, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useToast } from '@techsio/ui-kit/molecules/toast';
import { Effect, Schema } from 'effect';
import { useState } from 'react';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { salesRemainder } from '../../../../../shared/commands/sales.ts';
import type { SalesOrder } from '../../../../../shared/domain/purchasing.ts';
import { FormSaveFooter, refusedOutcome, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import type { FormSubmitResult } from '../../../../ui/form-save.tsx';
import { useFormValues } from '../../../../ui/form-values.tsx';
import { addDays } from '../../../../ui/ops-agenda/deadlines.ts';
import { failureKey, parsePositiveInt, todayIso, usePurchasingT } from './purchasing-model.ts';
import type { RunCommand } from './purchasing-model.ts';

const cancelLabelKey = 'facility-operations.common.cancel';

// Each form only holds its values: Uložit sends them through the form save, so Enter sends nothing. The panel shows one
// of them at a time, so each form is mounted once.

/** The delivery: its date and the quantity typed per order line. */
const deliverForm = FormReact.make(
  FormBuilder.empty
    .addField('deliveryDate', Schema.String)
    .addField('quantities', Schema.Record(Schema.String, Schema.String)),
  {
    fields: { deliveryDate: TextField, quantities: EntryTextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The reason an order is closed with its remainder. */
const closeForm = FormReact.make(FormBuilder.empty.addField('reason', Schema.String), {
  fields: { reason: TextAreaField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});

/** The dates of the invoice draft. */
const invoiceForm = FormReact.make(
  FormBuilder.empty.addField('dueDate', Schema.String).addField('issueDate', Schema.String),
  {
    fields: { dueDate: TextField, issueDate: TextField },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

const formClassName = 'flex flex-col gap-200';

/** A delivery opens dated today with nothing typed. */
const openedDelivery = (): typeof deliverForm.schema.Encoded => ({ deliveryDate: todayIso(), quantities: {} });
const openedClose = { reason: '' };
/** The invoice draft opens issued today, due in 14 days. */
const openedInvoice = (): typeof invoiceForm.schema.Encoded => ({
  dueDate: addDays(todayIso(), 14),
  issueDate: todayIso(),
});

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
  const opened = openedDelivery();
  const shown = useFormValues(deliverForm, opened);
  const { deliveryDate, quantities } = shown.values;
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
      <FormRoot
        className={formClassName}
        defaultValues={opened}
        form={deliverForm}
        key={order.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <deliverForm.deliveryDate id="sales-delivery-date" label={k('sales.fields.deliveryDate')} type="date" />
        {remainder.map(({ line, remaining }) => (
          <deliverForm.quantities
            entry={line.id}
            helpText={k('sales.form.remainingHelp', { count: remaining })}
            id={`sales-deliver-${line.id}`}
            inputMode="numeric"
            key={line.id}
            label={line.description}
          />
        ))}
      </FormRoot>
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
  const shown = useFormValues(closeForm, openedClose);
  const { error, send } = useOrderCommand({ onDone, run });
  // The order is closed with its remainder on Uložit only; the reason is required.
  const form = useFormSave({
    isValid: (value) => value.trim() !== '',
    submit: (value) =>
      send(
        { _tag: 'SalesOrderTransition', note: value.trim(), orderId: order.id, to: 'completed' },
        'sales.messages.closed',
      ),
    value: shown.values.reason,
  });
  return (
    <SectionCard title={closeLabel}>
      <FormRoot
        className={formClassName}
        defaultValues={openedClose}
        form={closeForm}
        key={order.id}
        translateMessage={(message) => t(message)}
      >
        {shown.ready}
        <closeForm.reason id="sales-close-reason" label={k('sales.fields.closeReason')} rows={2} />
      </FormRoot>
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};

/** The invoice of an order as the panel issues it: Finance creates the draft, then the order links it. */
export type IssueInvoice = (
  order: SalesOrder,
  issueDate: string,
  dueDate: string,
) => Effect.Effect<{
  readonly number?: string | undefined;
  readonly ok: boolean;
  readonly reason?: 'customer' | 'link' | 'vat';
}>;

const invoiceErrorKey = {
  customer: 'sales.form.invoiceOtherCustomer',
  failed: 'sales.form.invoiceFailed',
  link: 'sales.form.invoiceLinkFailed',
  vat: 'sales.form.invoiceVatUnresolved',
} as const;

export const SalesInvoiceForm = ({
  issueInvoice,
  onDone,
  order,
  retainedNumber,
  totalLabel,
}: Omit<SalesOrderFormProps, 'run'> & {
  readonly issueInvoice: IssueInvoice;
  /** An invoice Finance already created for this order whose link failed: Uložit only links it, the dates are kept. */
  readonly retainedNumber?: string | undefined;
  readonly totalLabel: string;
}) => {
  const k = usePurchasingT();
  const { t } = useModernI18n();
  const toast = useToast();
  const opened = openedInvoice();
  const shown = useFormValues(invoiceForm, opened);
  const { dueDate, issueDate } = shown.values;
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
            setError(k(invoiceErrorKey[outcome.reason ?? 'failed']));
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
      {retainedNumber === undefined ? (
        <>
          <p className="text-fg-secondary text-sm">{k('sales.form.invoiceIntro', { customer: order.customer.name })}</p>
          <FormRoot
            className="grid grid-cols-1 gap-200 sm:grid-cols-2"
            defaultValues={opened}
            form={invoiceForm}
            key={order.id}
            translateMessage={(message) => t(message)}
          >
            {shown.ready}
            <invoiceForm.issueDate id="sales-invoice-issue" label={k('sales.fields.issueDate')} type="date" />
            <invoiceForm.dueDate id="sales-invoice-due" label={k('sales.fields.dueDate')} type="date" />
          </FormRoot>
        </>
      ) : (
        <p className="text-fg-secondary text-sm">{k('sales.form.invoiceRetained', { number: retainedNumber })}</p>
      )}
      <p className="font-semibold text-sm">{totalLabel}</p>
      <FormSaveFooter cancelLabel={t(cancelLabelKey)} error={error} form={form} onCancel={onDone} />
    </SectionCard>
  );
};
