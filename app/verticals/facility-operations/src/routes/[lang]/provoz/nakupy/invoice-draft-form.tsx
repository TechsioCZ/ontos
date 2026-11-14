import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import type { IsoDate } from '../../../../../shared/domain/common.ts';
// Real Finance draft; supplier and immutable line prices are copied from the purchase order.
import { SectionCard } from '@app/admin-ui';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@app/admin-ui/form-controls';
import { SelectTemplate as Select } from '@app/admin-ui/select-template';
import { Effect, Option, Random } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { PurchaseOrder, Supplier } from '../../../../../shared/domain/purchasing.ts';
import { executeApplyCommand as applyFinanceCommand } from '@app/finance-billing/clients/apply-command';
import { readFinance, readFinanceVatChoices } from '../../../../ui/finance-reads.ts';
import type { FinanceVatChoices } from '../../../../ui/finance-reads.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { incomingVatOptions } from './invoice-vat.ts';
import type { InvoiceVat } from './invoice-vat.ts';
import { FormSaveFooter, submitDone, useFormSave } from '../../../../ui/form-save.tsx';
import { formatAmount, todayIso } from './purchasing-model.ts';
import { purchaseInvoiceCommandOf } from './purchase-invoice-command.ts';

const saveFailure = 'Návrh se nepodařilo uložit. Obnovte detail objednávky a ověřte, zda již návrh existuje.';
interface SubmitInvoiceDraftInput {
  readonly documentNumber: string;
  readonly dueDate: IsoDate;
  readonly issueDate: IsoDate;
  readonly lines: readonly ({
    readonly description: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
  } & InvoiceVat)[];
  readonly onCreated: () => void;
  readonly order: PurchaseOrder;
  readonly vat: InvoiceVat | undefined;
  readonly setError: (value: string | undefined) => void;
  readonly submitting: { current: boolean };
  readonly supplier: Supplier;
  readonly totalMinor: number;
}
const submitInvoiceDraft = Effect.fn('FacilityOperations.Purchasing.submitInvoiceDraft')(
  function* submitPurchaseInvoiceDraft(input: SubmitInvoiceDraftInput) {
    const {
      documentNumber,
      dueDate,
      issueDate,
      lines,
      onCreated,
      order,
      vat,
      setError,
      submitting,
      supplier,
      totalMinor,
    } = input;
    if (submitting.current) {
      return 'failed' as const;
    }
    if (vat === undefined || issueDate === '' || dueDate < issueDate) {
      setError('Vyberte sazbu DPH a zkontrolujte datum vystavení a splatnost.');
      return 'failed' as const;
    }
    const command = purchaseInvoiceCommandOf({
      documentNumber,
      dueDate,
      issueDate,
      lines,
      order,
      supplier,
      totalMinor,
    });
    if (Option.isNone(command)) {
      setError(saveFailure);
      return 'failed' as const;
    }
    submitting.current = true;
    setError(undefined);
    const result = yield* Effect.gen(function* createPurchaseInvoice() {
      const parts = yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt], { concurrency: 1 });
      const idempotencyKey = `purchase-invoice:${parts.join(':')}`;
      const snapshot = yield* readFinance('facility-operations.invoice-draft.read');
      if (!snapshot.canWrite) {
        return { status: 'forbidden' as const };
      }
      yield* applyFinanceCommand(
        {
          command: command.value,
          expectedRevision: snapshot.revision,
        },
        'facility-operations.invoice-draft.create',
        { idempotencyKey },
      );
      return { status: 'created' as const };
    }).pipe(
      Effect.catchTag('ApplyCommandActionForbiddenProblem', (cause) =>
        Effect.succeed({ cause, status: 'forbidden' as const }),
      ),
      Effect.match({ onFailure: (cause) => ({ cause, status: 'failed' as const }), onSuccess: (outcome) => outcome }),
    );
    submitting.current = false;
    if (result.status === 'created') {
      return submitDone(onCreated);
    }
    if (result.status === 'forbidden') {
      setError('Návrh faktury může připravit jen účetní nebo vedení. Vaše role má ve Financích jen čtení.');
    } else {
      setError(saveFailure);
    }
    return 'failed' as const;
  },
);

export const InvoiceDraftForm = ({
  onCancel,
  onCreated,
  order,
  supplier,
}: {
  readonly onCancel: () => void;
  readonly onCreated: () => void;
  readonly order: PurchaseOrder;
  readonly supplier: Supplier;
}) => {
  const { t } = useModernI18n();
  const [issueDate, setIssueDate] = useState(todayIso);
  const [documentNumber, setDocumentNumber] = useState('');
  const [dueDate, setDueDate] = useState(todayIso);
  const [vatKey, setVatKey] = useState('');
  const [choices, setChoices] = useState<FinanceVatChoices>();
  const [vatUnavailable, setVatUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setChoices(undefined);
    setVatUnavailable(false);
    if (issueDate !== '') {
      void browserRuntime.runPromiseExit(
        readFinanceVatChoices(issueDate).pipe(
          Effect.match({
            onFailure: () => setVatUnavailable(true),
            onSuccess: setChoices,
          }),
        ),
        { signal: controller.signal },
      );
    }
    return () => controller.abort();
  }, [issueDate]);
  const vatOptions = choices?.on === issueDate ? incomingVatOptions(choices) : [];
  const vat = vatOptions.find((candidate) => candidate.key === vatKey)?.vat;
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const lines = order.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    ...(vat ?? { vatRate: 0 }),
  }));
  let totalMinor = 0;
  for (const line of lines) {
    const base = line.quantity * line.unitPriceMinor;
    totalMinor += base + Math.floor((base * line.vatRate + 50) / 100);
  }
  // The draft is created on Uložit only; the dates it opens with are not typed input.
  const form = useFormSave({
    isValid: (value) => value.documentNumber.trim() !== '' && vat !== undefined,
    submit: () =>
      submitInvoiceDraft({
        documentNumber,
        dueDate,
        issueDate,
        lines,
        onCreated,
        order,
        vat,
        setError,
        submitting,
        supplier,
        totalMinor,
      }),
    value: { documentNumber, dueDate, issueDate, vatKey },
  });
  return (
    <SectionCard title={t('facility-operations.ui.prepareIncomingInvoice')}>
      <p className="text-fg-secondary text-sm">
        Dodavatel {supplier.name} a řádky se převezmou jako samostatná kopie z {order.number}. Nejde o vystavený doklad
        dodavatele ani o zaúčtování.
      </p>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
      <FormInput
        id="draft-invoice-number"
        label={t('facility-operations.ui.supplierDocumentNumber')}
        onChange={(event) => setDocumentNumber(event.target.value)}
        required
        value={documentNumber}
      />
      <div className="flex flex-col gap-100">
        {order.lines.map((line) => (
          <div className="rounded-md bg-surface-secondary p-150 text-sm" key={line.id}>
            <span className="font-medium">{line.description}</span>
            <div>
              {line.quantity} × {formatAmount(line.unitPriceMinor)} bez DPH
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-200 sm:grid-cols-2">
        <FormInput
          id="draft-invoice-issue"
          label={t('facility-operations.ui.issueDate')}
          onChange={(event) => {
            setIssueDate(event.target.value);
            setVatKey('');
          }}
          required
          type="date"
          value={issueDate}
        />
        <FormInput
          id="draft-invoice-due"
          label={t('facility-operations.ui.dueDate')}
          onChange={(event) => setDueDate(event.target.value)}
          required
          type="date"
          value={dueDate}
        />
      </div>
      <Select
        items={vatOptions.map((option) => ({
          displayValue: t(option.labelKey, { rate: option.vat.vatRate }),
          label: t(option.labelKey, { rate: option.vat.vatRate }),
          value: option.key,
        }))}
        label={t('facility-operations.ui.supplierDocumentVat')}
        name="invoice-vat-rate"
        onValueChange={({ value }) => setVatKey(value[0] ?? '')}
        placeholder={t('facility-operations.ui.selectVatRate')}
        value={vatKey === '' ? [] : [vatKey]}
      />
      {vatUnavailable && <StatusText status="error">{t('facility-operations.ui.vat.unavailable')}</StatusText>}
      <p className="text-fg-secondary text-xs">
        Ceny objednávky se přebírají beze změny jako základ bez DPH. Zvolená sazba se použije pro všechny řádky; ověřte
        ji podle skutečného dokladu dodavatele.
      </p>
      {vat !== undefined && <p className="font-semibold text-sm">Celkem včetně DPH: {formatAmount(totalMinor)}</p>}
      <FormSaveFooter
        cancelLabel={t('facility-operations.common.cancel')}
        error={error}
        form={form}
        onCancel={onCancel}
      />
    </SectionCard>
  );
};
