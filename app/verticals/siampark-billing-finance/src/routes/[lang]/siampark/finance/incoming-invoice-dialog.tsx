// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { formatMoney, SidePanel } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import { addCalendarDaysTo } from '../../../../../shared/domain/finance-planning.ts';
import {
  ACCEPTED_DOCUMENT_TYPES,
  formatBytes,
  MAX_UPLOAD_BYTES,
  outcomeMessage,
  parseAmountMinor,
  readUpload,
} from './finance-ui.tsx';
import type { FinanceViewModel, PreparedUpload } from './finance-ui.tsx';

export const BUDGET_CATEGORIES = [
  'Energie',
  'Údržba a opravy',
  'Úklid a odpady',
  'Služby a správa',
  'Pojištění',
  'Marketing',
  'Nájemné',
  'Ubytování',
  'Ostatní',
] as const;

interface IncomingDraft {
  readonly amount: string;
  readonly category: string;
  readonly documentNumber: string;
  readonly dueDate: string;
  readonly issueDate: string;
  readonly note: string;
  readonly supplierCompanyId: string;
  readonly supplierName: string;
}

const emptyDraft = (today: string): IncomingDraft => ({
  amount: '',
  category: 'Energie',
  documentNumber: '',
  dueDate: addCalendarDaysTo(today, 14),
  issueDate: today,
  note: '',
  supplierCompanyId: '',
  supplierName: '',
});

interface IncomingInvoiceDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly vm: FinanceViewModel;
}

/** S07.R6: a received invoice is entered by hand and its PDF/scan is stored with it. */
export const IncomingInvoiceDialog = ({ onOpenChange, open, vm }: IncomingInvoiceDialogProps) => {
  const today = vm.referenceDate === '' ? new Intl.DateTimeFormat('en-CA').format(Date.now()) : vm.referenceDate;
  const [draft, setDraft] = useState<IncomingDraft>(() => emptyDraft(today));
  const [file, setFile] = useState<{ readonly size: number; readonly upload: PreparedUpload }>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<IncomingDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const amountMinor = parseAmountMinor(draft.amount);

  const pickFile = async (picked: File | undefined) => {
    setError(undefined);
    if (picked === undefined) {
      setFile(undefined);
      return;
    }
    if (!(ACCEPTED_DOCUMENT_TYPES as readonly string[]).includes(picked.type)) {
      setError('Podporované jsou soubory PDF, PNG, JPEG a WebP.');
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError('Soubor je příliš velký (nejvýše 3 MB).');
      return;
    }
    setFile({ size: picked.size, upload: await readUpload(picked) });
  };

  const close = () => {
    setDraft(emptyDraft(today));
    setFile(undefined);
    setError(undefined);
    onOpenChange(false);
  };

  const submit = async () => {
    if (draft.supplierName.trim() === '' || draft.documentNumber.trim() === '') {
      setError('Vyplňte dodavatele a číslo dokladu.');
      return;
    }
    if (amountMinor === undefined || amountMinor === 0) {
      setError('Zadejte kladnou částku, např. 12 100 nebo 12 100,50.');
      return;
    }
    if (draft.dueDate < draft.issueDate) {
      setError('Splatnost nesmí být dřív než datum vystavení.');
      return;
    }
    setSaving(true);
    const outcome = await vm.execute(
      {
        _tag: 'RecordIncomingInvoice',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        budgetCategory: draft.category,
        ...(file === undefined ? {} : { document: file.upload }),
        documentNumber: draft.documentNumber.trim(),
        dueDate: draft.dueDate,
        issueDate: draft.issueDate,
        ...(draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
        ...(draft.supplierCompanyId.trim() === '' ? {} : { supplierCompanyId: draft.supplierCompanyId.trim() }),
        supplierName: draft.supplierName.trim(),
        totalMinor: amountMinor,
      },
      'Přijatá faktura zaevidována',
    );
    setSaving(false);
    if (outcome.ok) {
      close();
      if (outcome.invoice !== undefined) {
        vm.openDetail(outcome.invoice.ref.resourceId);
      }
    } else {
      setError(outcomeMessage(vm, outcome));
    }
  };

  return (
    <SidePanel
      actions={
        <>
          <Button onClick={close} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button isLoading={saving} loadingText="Ukládám…" onClick={() => void submit()} variant="primary">
            Zaevidovat fakturu
          </Button>
        </>
      }
      closeOnInteractOutside={false}
      description="Ruční evidence došlé faktury. Přiložený doklad se uloží a lze jej kdykoli stáhnout nebo zobrazit."
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      open={open}
      resizeLabel={vm.t('siampark-billing-finance.sidePanel.resize')}
      size="lg"
      title="Přijatá faktura"
    >
      <form
        className="flex flex-col gap-200 py-200"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error !== undefined && (
          <StatusText showIcon size="sm" status="error">
            {error}
          </StatusText>
        )}
        <div className="grid grid-cols-1 gap-200 md:grid-cols-[2fr_1fr]">
          <FormInput
            id="incoming-supplier"
            label="Dodavatel"
            onChange={(event) => set({ supplierName: event.target.value })}
            placeholder="např. ČEZ Prodej, a.s."
            required
            size="sm"
            value={draft.supplierName}
          />
          <FormInput
            id="incoming-ico"
            label="IČO"
            onChange={(event) => set({ supplierCompanyId: event.target.value })}
            placeholder="nepovinné"
            size="sm"
            value={draft.supplierCompanyId}
          />
        </div>
        <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
          <FormInput
            id="incoming-number"
            label="Číslo dokladu dodavatele"
            onChange={(event) => set({ documentNumber: event.target.value })}
            placeholder="např. 2026-1184"
            required
            size="sm"
            value={draft.documentNumber}
          />
          <FormInput
            helpText={amountMinor === undefined ? 'Celková částka včetně DPH' : formatMoney(amountMinor)}
            id="incoming-amount"
            inputMode="decimal"
            label="Částka celkem (Kč)"
            onChange={(event) => set({ amount: event.target.value })}
            placeholder="0,00"
            required
            size="sm"
            value={draft.amount}
          />
        </div>
        <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
          <FormInput
            id="incoming-issued"
            label="Datum vystavení"
            onChange={(event) => set({ issueDate: event.target.value })}
            required
            size="sm"
            type="date"
            value={draft.issueDate}
          />
          <FormInput
            id="incoming-due"
            label="Splatnost"
            onChange={(event) => set({ dueDate: event.target.value })}
            required
            size="sm"
            type="date"
            value={draft.dueDate}
          />
        </div>
        <SelectTemplate
          items={BUDGET_CATEGORIES.map((category) => ({ displayValue: category, label: category, value: category }))}
          label="Kategorie rozpočtu"
          labelProps={{ className: 'font-label text-label-md' }}
          onValueChange={({ value }) => {
            const [next] = value;
            if (next !== undefined) {
              set({ category: next });
            }
          }}
          size="sm"
          value={[draft.category]}
        />
        <FormInput
          id="incoming-note"
          label="Poznámka"
          onChange={(event) => set({ note: event.target.value })}
          placeholder="nepovinné"
          size="sm"
          value={draft.note}
        />
        <div className="flex flex-col gap-100">
          <span className="font-label text-label-md">Doklad (PDF nebo obrázek)</span>
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-100 rounded-md border border-border-primary border-dashed bg-surface-secondary px-300 py-300 text-center text-sm hover:bg-surface-hover"
            htmlFor="incoming-file"
          >
            <span aria-hidden className="icon-[mdi--file-upload-outline] size-6 text-fg-secondary" />
            {file === undefined ? (
              <span className="text-fg-secondary">Klikněte a vyberte soubor · PDF, PNG, JPEG · max. 3 MB</span>
            ) : (
              <span className="font-medium">
                {file.upload.fileName} · {formatBytes(file.size)}
              </span>
            )}
          </label>
          <input
            accept={ACCEPTED_DOCUMENT_TYPES.join(',')}
            className="sr-only"
            id="incoming-file"
            onChange={(event) => void pickFile(event.target.files?.[0])}
            type="file"
          />
          {file !== undefined && (
            <Button
              className="self-start"
              icon="icon-[mdi--close]"
              onClick={() => setFile(undefined)}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              Odebrat soubor
            </Button>
          )}
        </div>
      </form>
    </SidePanel>
  );
};
