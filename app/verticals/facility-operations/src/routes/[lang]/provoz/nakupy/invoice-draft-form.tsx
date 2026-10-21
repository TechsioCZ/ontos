// @effect-diagnostics asyncFunction:off
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

type VatRate = 0 | 10 | 12 | 21;
export const InvoiceDraftForm = ({
  order,
  supplier,
  onCancel,
  onCreated,
}: {
  readonly order: PurchaseOrder;
  readonly supplier: Supplier;
  readonly onCancel: () => void;
  readonly onCreated: () => void;
}) => {
  const [issueDate, setIssueDate] = useState(todayIso());
  const [dueDate, setDueDate] = useState(todayIso());
  const [rate, setRate] = useState<VatRate | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string>();
  const lines = order.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    vatRate: rate ?? 0,
  }));
  const totalMinor = lines.reduce((sum, line) => {
    const base = line.quantity * line.unitPriceMinor;
    return sum + base + Math.floor((base * line.vatRate + 50) / 100);
  }, 0);
  const submit = async () => {
    if (submitting.current) return;
    if (rate === undefined || issueDate === '' || dueDate < issueDate) {
      setError('Vyberte sazbu DPH a zkontrolujte datum vystavení a splatnost.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    const result = await browserRuntime.runPromise(
      Effect.gen(function* createPurchaseInvoice() {
        const parts = yield* Effect.all([Random.nextInt, Random.nextInt, Random.nextInt]);
        const idempotencyKey = `purchase-invoice:${parts.join(':')}`;
        const snapshot = yield* readFinance('facility-operations.invoice-draft.read');
        if (!snapshot.canWrite) {
          return 'forbidden' as const;
        }
        yield* applyFinanceCommand(
          {
            expectedRevision: snapshot.revision,
            command: {
              _tag: 'RecordIncomingInvoice',
              documentNumber: `NÁVRH-${order.number}`,
              supplierName: supplier.name,
              issueDate,
              dueDate,
              lines,
              totalMinor,
              sourceOrder: { id: order.id, number: order.number },
              note: `Návrh z nákupní objednávky ${order.number}. Číslo a sazbu DPH ověří účetní podle dokladu dodavatele.`,
            },
          },
          'facility-operations.invoice-draft.create',
          { idempotencyKey },
        );
        return 'created' as const;
      }).pipe(
        Effect.catchTag('ApplyCommandActionForbiddenProblem', () => Effect.succeed('forbidden' as const)),
        Effect.match({ onSuccess: (outcome) => outcome, onFailure: () => 'failed' as const }),
      ),
    );
    submitting.current = false;
    setBusy(false);
    if (result === 'created') onCreated();
    else if (result === 'forbidden')
      setError('Návrh faktury může připravit jen účetní nebo vedení. Vaše role má ve Financích jen čtení.');
    else setError('Návrh se nepodařilo uložit. Obnovte detail objednávky a ověřte, zda již návrh existuje.');
  };
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
        {lines.map((line, index) => (
          <div className="rounded-md bg-surface-secondary p-150 text-sm" key={index}>
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
          type="date"
          required
          value={issueDate}
          onChange={(event) => setIssueDate(event.target.value)}
        />
        <FormInput
          id="draft-invoice-due"
          label="Datum splatnosti"
          type="date"
          required
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
        />
      </div>
      <Select
        placeholder="Vyberte sazbu DPH"
        label="DPH podle dokladu dodavatele"
        name="invoice-vat-rate"
        items={([0, 10, 12, 21] as const).map((value) => ({
          value: String(value),
          label: `${value} %`,
          displayValue: `${value} %`,
        }))}
        value={rate === undefined ? [] : [String(rate)]}
        onValueChange={({ value }) => setRate(value[0] === undefined ? undefined : (Number(value[0]) as VatRate))}
      />
      <p className="text-fg-secondary text-xs">
        Ceny objednávky se přebírají beze změny jako základ bez DPH. Zvolená sazba se použije pro všechny řádky;
        ověřte ji podle skutečného dokladu dodavatele.
      </p>
      {rate !== undefined && <p className="font-semibold text-sm">Celkem včetně DPH: {formatAmount(totalMinor)}</p>}
      <div className="flex flex-wrap justify-end gap-100">
        <Button size="sm" variant="secondary" theme="outlined" disabled={busy} onClick={onCancel}>
          Zrušit
        </Button>
        <Button size="sm" variant="primary" isLoading={busy} onClick={() => void submit()}>
          Uložit návrh
        </Button>
      </div>
    </SectionCard>
  );
};
