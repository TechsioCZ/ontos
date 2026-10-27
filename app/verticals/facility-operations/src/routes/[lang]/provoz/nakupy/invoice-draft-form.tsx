import type { IsoDate } from '../../../../../shared/domain/common.ts';
// Real Finance draft; supplier and immutable line prices are copied from the purchase order.
import { SectionCard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { Effect, Random } from 'effect';
import { useRef, useState } from 'react';
import type { PurchaseOrder, Supplier } from '../../../../../shared/domain/purchasing.ts';
import { applyFinanceCommand, readFinance } from '../../../../api/finance-reads.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { formatAmount, todayIso } from './purchasing-model.ts';

const vatRates = [0, 10, 12, 21] as const;
type VatRate = (typeof vatRates)[number];
interface SubmitInvoiceDraftInput {
  readonly dueDate: IsoDate;
  readonly issueDate: IsoDate;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly vatRate: VatRate;
  }[];
  readonly onCreated: () => void;
  readonly order: PurchaseOrder;
  readonly rate: VatRate | undefined;
  readonly setBusy: (value: boolean) => void;
  readonly setError: (value: string | undefined) => void;
  readonly submitting: { current: boolean };
  readonly supplier: Supplier;
  readonly totalMinor: number;
}
const submitInvoiceDraft = Effect.fn('FacilityOperations.Purchasing.submitInvoiceDraft')(
  function* submitPurchaseInvoiceDraft(input: SubmitInvoiceDraftInput) {
    const { dueDate, issueDate, lines, onCreated, order, rate, setBusy, setError, submitting, supplier, totalMinor } =
      input;
    if (submitting.current) {
      return;
    }
    if (rate === undefined || issueDate === '' || dueDate < issueDate) {
      setError('Vyberte sazbu DPH a zkontrolujte datum vystavení a splatnost.');
      return;
    }
    submitting.current = true;
    setBusy(true);
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
          command: {
            _tag: 'RecordIncomingInvoice',
            documentNumber: `NÁVRH-${order.number}`,
            dueDate,
            issueDate,
            lines,
            note: `Návrh z nákupní objednávky ${order.number}. Číslo a sazbu DPH ověří účetní podle dokladu dodavatele.`,
            sourceOrder: { id: order.id, number: order.number },
            supplierName: supplier.name,
            totalMinor,
          },
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
    setBusy(false);
    if (result.status === 'created') {
      onCreated();
    } else if (result.status === 'forbidden') {
      setError('Návrh faktury může připravit jen účetní nebo vedení. Vaše role má ve Financích jen čtení.');
    } else {
      setError('Návrh se nepodařilo uložit. Obnovte detail objednávky a ověřte, zda již návrh existuje.');
    }
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
  const [issueDate, setIssueDate] = useState(todayIso);
  const [dueDate, setDueDate] = useState(todayIso);
  const [rate, setRate] = useState<VatRate | undefined>();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const lines = order.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: rate ?? 0,
  }));
  let totalMinor = 0;
  for (const line of lines) {
    const base = line.quantity * line.unitPriceMinor;
    totalMinor += base + Math.floor((base * line.vatRate + 50) / 100);
  }
  const submit = () =>
    submitInvoiceDraft({
      dueDate,
      issueDate,
      lines,
      onCreated,
      order,
      rate,
      setBusy,
      setError,
      submitting,
      supplier,
      totalMinor,
    });
  return (
    <SectionCard title="Připravit návrh přijaté faktury">
      <p className="text-fg-secondary text-sm">
        Dodavatel {supplier.name} a řádky se převezmou jako samostatná kopie z {order.number}. Nejde o vystavený doklad
        dodavatele ani o zaúčtování.
      </p>
      {error !== undefined && (
        <StatusText showIcon status="error">
          {error}
        </StatusText>
      )}
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
          label="Datum vystavení"
          onChange={(event) => setIssueDate(event.target.value)}
          required
          type="date"
          value={issueDate}
        />
        <FormInput
          id="draft-invoice-due"
          label="Datum splatnosti"
          onChange={(event) => setDueDate(event.target.value)}
          required
          type="date"
          value={dueDate}
        />
      </div>
      <Select
        items={vatRates.map((value) => ({
          displayValue: `${value} %`,
          label: `${value} %`,
          value: String(value),
        }))}
        label="DPH podle dokladu dodavatele"
        name="invoice-vat-rate"
        onValueChange={({ value }) => setRate(vatRates.find((candidate) => String(candidate) === value[0]))}
        placeholder="Vyberte sazbu DPH"
        value={rate === undefined ? [] : [String(rate)]}
      />
      <p className="text-fg-secondary text-xs">
        Ceny objednávky se přebírají beze změny jako základ bez DPH. Zvolená sazba se použije pro všechny řádky; ověřte
        ji podle skutečného dokladu dodavatele.
      </p>
      {rate !== undefined && <p className="font-semibold text-sm">Celkem včetně DPH: {formatAmount(totalMinor)}</p>}
      <div className="flex flex-wrap justify-end gap-100">
        <Button disabled={busy} onClick={onCancel} size="sm" theme="outlined" variant="secondary">
          Zrušit
        </Button>
        <Button
          isLoading={busy}
          onClick={() => {
            browserRuntime.runFork(submit());
          }}
          size="sm"
          variant="primary"
        >
          Uložit návrh
        </Button>
      </div>
    </SectionCard>
  );
};
