import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { dialogCloseLabel, formatDate, formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { DateTime, Effect, Option, Result } from 'effect';
import { useEffect, useState } from 'react';
import type { Invoice, AccountingExportStatus } from '../../../../shared/apis/records.ts';
import { isTestReminderRecipient, paymentEvents } from '../../../../shared/domain/finance-planning.ts';
import {
  ACCEPTED_DOCUMENT_TYPES,
  downloadBase64,
  formatBytes,
  MAX_UPLOAD_BYTES,
  outcomeMessage,
  previewUrl,
  readUpload,
} from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { ReminderEmailStatus, useEmailProvider, useReminderEmailReceipts } from './reminder-email-receipts.tsx';
import { useInvoiceIssuer } from './use-invoice-issuer.ts';
import { confirmedDocumentsLabel } from './invoice-view.ts';
import { InvoicePaymentForm } from './invoice-payment-form.tsx';
import { InvoiceReminderForm } from './invoice-reminder-form.tsx';

/** S08 handover package states as the finance screens show them. */
export const EXPORT_STATUS = {
  CONFIRMED_BY_ACCOUNTANT: { label: 'Potvrzeno účetní', variant: 'success' },
  FAILED: { label: 'Chyba předání', variant: 'danger' },
  HANDED_OVER: { label: 'Předáno – čeká na potvrzení účetní', variant: 'info' },
  PREPARED: { label: 'Připraveno k předání', variant: 'warning' },
} satisfies Readonly<
  Record<
    AccountingExportStatus,
    { readonly label: string; readonly variant: 'danger' | 'info' | 'success' | 'warning' }
  >
>;

/** Stored instants are Effect DateTime values; the shared formatter takes ISO strings. */
const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

const remainingOf = (invoice: Invoice) => Math.max(0, invoice.totalMinor - invoice.paidMinor);

const actorText = (label: string | undefined) => label ?? 'neznámý uživatel';

/** Uploaded documents of one invoice: download, inline preview, and upload of another file. */
const invoiceDocumentsLoadProgram = Effect.fn('Finance.load')(function* invoiceDocumentsLoadProgram(
  context: Pick<ReturnType<typeof useInvoiceDocuments>, 'setError' | 'setPreview' | 'vm'>,
  id: string,
  mode: 'download' | 'preview',
) {
  const { setError, setPreview, vm } = context;
  setError(undefined);
  const loaded = yield* Effect.result(vm.fetchDocument(id));
  if (Result.isFailure(loaded) || Option.isNone(loaded.success)) {
    setError('Obsah dokladu se nepodařilo načíst.');
    return;
  }
  const document = loaded.success.value;
  if (mode === 'download') {
    downloadBase64(document.contentBase64, document.mimeType, document.fileName);
  } else {
    setPreview({
      mimeType: document.mimeType,
      name: document.fileName,
      url: previewUrl(document.contentBase64, document.mimeType),
    });
  }
});

const invoiceDocumentsUploadProgram = Effect.fn('Finance.upload')(function* invoiceDocumentsUploadProgram(
  context: Pick<ReturnType<typeof useInvoiceDocuments>, 'invoice' | 'setError' | 'setUploading' | 'vm'>,
  file: File | undefined,
) {
  const { invoice, setError, setUploading, vm } = context;
  if (file === undefined) {
    return;
  }
  setError(undefined);
  if (!ACCEPTED_DOCUMENT_TYPES.some((mimeType) => mimeType === file.type) || file.size > MAX_UPLOAD_BYTES) {
    setError('Nahrajte PDF nebo obrázek do velikosti 3 MB.');
    return;
  }
  setUploading(true);
  const uploaded = yield* Effect.result(readUpload(file));
  if (Result.isFailure(uploaded)) {
    setUploading(false);
    setError('Obsah dokladu se nepodařilo načíst.');
    return;
  }
  const attachDocumentCommand: FinanceCommandDraft<'AttachDocument'> = {
    _tag: 'AttachDocument',
    document: uploaded.success,
    invoiceRef: invoice.ref,
  };
  if (vm.actorLabel !== undefined) {
    attachDocumentCommand.actorLabel = vm.actorLabel;
  }
  const outcome = yield* vm.execute(attachDocumentCommand, 'Doklad nahrán');
  setUploading(false);
  if (!outcome.ok) {
    setError(outcomeMessage(vm, outcome));
  }
});

const useInvoiceDocuments = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const documents = (vm.snapshot?.state.documents ?? []).filter(
    (document) => document.invoiceResourceId === invoice.ref.resourceId,
  );
  const [preview, setPreview] = useState<{ readonly mimeType: string; readonly name: string; readonly url: string }>();
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  useEffect(() => () => (preview === undefined ? undefined : URL.revokeObjectURL(preview.url)), [preview]);

  const load = (id: string, mode: 'download' | 'preview'): void => {
    void financeBrowserRuntime.runPromise(invoiceDocumentsLoadProgram({ setError, setPreview, vm }, id, mode));
  };

  const upload = (file: File | undefined): void => {
    void financeBrowserRuntime.runPromise(invoiceDocumentsUploadProgram({ invoice, setError, setUploading, vm }, file));
  };
  return { documents, error, invoice, load, preview, setError, setPreview, setUploading, upload, uploading, vm };
};

export const InvoiceDocuments = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { documents, error, invoice, load, preview, setPreview, upload, uploading, vm } = useInvoiceDocuments(props);
  return (
    <SectionCard title={t('finance-billing.financeUi.documents.title')}>
      <div className="flex flex-col gap-150">
        {error !== undefined && (
          <StatusText showIcon size="sm" status="error">
            {error}
          </StatusText>
        )}
        {documents.length === 0 ? (
          <p className="text-fg-secondary text-sm">K faktuře zatím není nahraný žádný soubor.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-primary">
            {documents.map((document) => (
              <li className="flex items-center gap-150 py-100" key={document.id}>
                <span
                  aria-hidden
                  className={`size-6 shrink-0 text-fg-secondary ${document.mimeType === 'application/pdf' ? 'icon-[mdi--file-pdf-box]' : 'icon-[mdi--file-image-outline]'}`}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-sm">{document.fileName}</span>
                  <span className="truncate text-fg-secondary text-xs">
                    {formatBytes(document.sizeBytes)} · {at(document.uploadedAt)} · {actorText(document.actorLabel)}
                  </span>
                </span>
                <Button
                  icon="icon-[mdi--eye-outline]"
                  onClick={() => {
                    load(document.id, 'preview');
                  }}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  Náhled
                </Button>
                <Button
                  icon="icon-[mdi--download]"
                  onClick={() => {
                    load(document.id, 'download');
                  }}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  Stáhnout
                </Button>
              </li>
            ))}
          </ul>
        )}
        {vm.canWrite && (
          <label
            className="flex cursor-pointer items-center gap-100 self-start rounded-md border border-border-primary px-200 py-100 text-sm hover:bg-surface-hover print:hidden"
            htmlFor={`attach-${invoice.ref.resourceId}`}
          >
            <span aria-hidden className="icon-[mdi--paperclip] size-4" />
            {uploading ? 'Nahrávám…' : 'Nahrát soubor'}
            <input
              accept={ACCEPTED_DOCUMENT_TYPES.join(',')}
              className="sr-only"
              disabled={uploading}
              id={`attach-${invoice.ref.resourceId}`}
              onChange={(event) => {
                upload(event.target.files?.[0]);
              }}
              type="file"
            />
          </label>
        )}
      </div>
      <Dialog
        closeLabel={dialogCloseLabel}
        contentStyle={{ maxWidth: 'calc(100vw - 2rem)', width: '72rem' }}
        customTrigger
        onOpenChange={(details) => {
          if (!details.open) {
            setPreview(undefined);
          }
        }}
        open={preview !== undefined}
        placement="center"
        size="xl"
        title={preview?.name ?? ''}
      >
        {preview !== undefined &&
          (preview.mimeType === 'application/pdf' ? (
            <iframe
              className="h-[70vh] w-full rounded-md border border-border-primary"
              sandbox="allow-same-origin"
              src={preview.url}
              title={preview.name}
            />
          ) : (
            <img alt={preview.name} className="max-h-[70vh] w-full object-contain" src={preview.url} />
          ))}
      </Dialog>
    </SectionCard>
  );
};

/** Payment history; a payment is recorded by its own form (S07.R5, S07-02). */
const PaymentSourceBadge = ({
  event,
  invoice,
}: {
  readonly event: ReturnType<typeof paymentEvents>[number];
  readonly invoice: Invoice;
}) => {
  if (event.source === 'MANUAL') {
    return (
      <Badge size="sm" variant="success">
        Ručně potvrzeno
      </Badge>
    );
  }
  if (event.source === 'PRIOR') {
    return (
      <Badge
        size="sm"
        variant="info"
      >{`Zohledněno z ${invoice.priorSettlement?.entries[Number(event.id.split(':').at(-1))]?.number ?? 'zálohy'} · bez pohybu peněz`}</Badge>
    );
  }
  return (
    <Badge size="sm" variant="outline">
      Převzato z importu
    </Badge>
  );
};

const useInvoicePayments = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const state = vm.snapshot?.state;
  const events =
    state === undefined
      ? []
      : paymentEvents(state).filter((event) => event.invoiceResourceId === invoice.ref.resourceId);
  const manual = new Map((state?.manualPayments ?? []).map((payment) => [payment.id, payment]));
  const remaining = remainingOf(invoice);
  const [open, setOpen] = useState(false);
  const canRecord = vm.canWrite && invoice.businessState === 'CONFIRMED' && remaining > 0;
  return { canRecord, events, invoice, manual, open, remaining, setOpen, vm };
};

export const InvoicePayments = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { canRecord, events, invoice, manual, open, remaining, setOpen, vm } = useInvoicePayments(props);
  return (
    <SectionCard
      actions={
        canRecord ? (
          <Button
            icon="icon-[mdi--cash-plus]"
            onClick={() => setOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Zaznamenat úhradu
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.payments.title')}
    >
      <div className="flex flex-col gap-150">
        <div className="flex flex-wrap gap-300 text-sm">
          <span>
            Uhrazeno <strong className="tabular-nums">{formatMoney(invoice.paidMinor)}</strong>
          </span>
          <span>
            Zbývá <strong className="tabular-nums">{formatMoney(remaining)}</strong>
          </span>
        </div>
        <div aria-hidden className="h-2 overflow-hidden rounded-full bg-surface-secondary">
          <div
            className="h-full rounded-full bg-(--color-chart-series-1)"
            style={{ width: `${Math.min(100, (invoice.paidMinor / Math.max(1, invoice.totalMinor)) * 100)}%` }}
          />
        </div>
        {events.length === 0 ? (
          <p className="text-fg-secondary text-sm">Zatím nebyla potvrzena žádná úhrada.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border-primary text-sm">
            {events.map((event) => {
              const payment = manual.get(event.id);
              return (
                <li className="flex flex-wrap items-center gap-150 py-100" key={event.id}>
                  <span className="w-24 tabular-nums">{formatDate(event.date)}</span>
                  <span className="font-medium tabular-nums">{formatMoney(event.amountMinor)}</span>
                  <PaymentSourceBadge event={event} invoice={invoice} />
                  {payment !== undefined && (
                    <span className="text-fg-secondary text-xs">
                      {actorText(payment.actorLabel)} · {at(payment.recordedAt)}
                      {payment.note === undefined ? '' : ` · ${payment.note}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {open && <InvoicePaymentForm invoice={invoice} onClose={() => setOpen(false)} remaining={remaining} vm={vm} />}
    </SectionCard>
  );
};

/**
 * Reminders exist only for outgoing receivables: an incoming supplier invoice is money the company owes, so it
 * never offers prepare/send. Draft, voided and settled documents stay out as well.
 */
export const invoiceReminderEligible = (invoice: Invoice): boolean =>
  invoice.direction === 'OUTGOING' && invoice.businessState === 'CONFIRMED' && remainingOf(invoice) > 0;

const useInvoiceReminders = ({
  counterpartyName,
  invoice,
  vm,
}: {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}) => {
  const allReminders = (vm.snapshot?.state.reminders ?? []).filter(
    (reminder) => reminder.invoiceResourceId === invoice.ref.resourceId,
  );
  // Test sends to reserved test domains stay in the audit record but are not shown as customer reminders.
  const testCount = allReminders.filter((reminder) => isTestReminderRecipient(reminder.recipient)).length;
  const [showTests, setShowTests] = useState(false);
  const reminders = showTests
    ? allReminders
    : allReminders.filter((reminder) => !isTestReminderRecipient(reminder.recipient));
  const receipts = useReminderEmailReceipts(
    reminders.flatMap((reminder) => (reminder.deliveryMode === 'EMAIL' ? [reminder.id] : [])),
  );
  const open = invoiceReminderEligible(invoice);
  const [editing, setEditing] = useState(false);
  const issuerName = useInvoiceIssuer();
  const provider = useEmailProvider();
  // The prepare/send form renders only while an eligible document is being edited, so a retained editing flag
  // can never keep a stale form visible once the shown invoice is ineligible (incoming, draft, voided or paid).
  const editingVisible = editing && open;
  return {
    counterpartyName,
    editing,
    editingVisible,
    invoice,
    issuerName,
    open,
    provider,
    receipts,
    reminders,
    setEditing,
    setShowTests,
    showTests,
    testCount,
    vm,
  };
};

interface InvoiceRemindersProps {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}

/** Direction and eligibility select the reminder section's translated empty state. */
const reminderEmptyKey = (invoice: Invoice, open: boolean): string => {
  if (open) {
    return 'finance-billing.financeUi.reminders.empty';
  }
  if (invoice.direction === 'INCOMING') {
    return 'finance-billing.financeUi.reminders.incoming';
  }
  return 'finance-billing.financeUi.reminders.ineligible';
};

const InvoiceRemindersCard = (props: InvoiceRemindersProps) => {
  const { t } = useModernI18n();
  const {
    counterpartyName,
    editing,
    editingVisible,
    invoice,
    issuerName,
    open,
    provider,
    receipts,
    reminders,
    setEditing,
    setShowTests,
    showTests,
    testCount,
    vm,
  } = useInvoiceReminders(props);
  return (
    <SectionCard
      actions={
        vm.canWrite && open && !editing ? (
          <Button
            icon="icon-[mdi--email-alert-outline]"
            onClick={() => setEditing(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            Připravit upomínku
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.reminders.title')}
    >
      <div className="flex flex-col gap-150 print:hidden">
        {editingVisible && (
          <InvoiceReminderForm
            counterpartyName={counterpartyName}
            invoice={invoice}
            issuerName={issuerName}
            onClose={() => setEditing(false)}
            provider={provider}
            vm={vm}
          />
        )}
        {reminders.length === 0 && !editingVisible && (
          <p className="text-fg-secondary text-sm">{t(reminderEmptyKey(invoice, open))}</p>
        )}
        {reminders.length > 0 && (
          <ul className="flex flex-col divide-y divide-border-primary text-sm">
            {reminders.map((reminder) => (
              <li className="flex flex-wrap items-center gap-150 py-100" key={reminder.id}>
                <span className="tabular-nums">{at(reminder.createdAt)}</span>
                <span className="font-medium">{reminder.recipient}</span>
                {isTestReminderRecipient(reminder.recipient) && (
                  <Badge size="sm" variant="outline">
                    Zkušební adresa – nejde o upomínku zákazníkovi
                  </Badge>
                )}
                <ReminderEmailStatus receipts={receipts} reminderId={reminder.id} />
                <span className="text-fg-secondary text-xs">{actorText(reminder.actorLabel)}</span>
              </li>
            ))}
          </ul>
        )}
        {testCount > 0 && (
          <Button
            className="self-start"
            data-finance-test-reminders={testCount}
            onClick={() => setShowTests((current) => !current)}
            size="sm"
            theme="borderless"
            variant="secondary"
          >
            {showTests
              ? 'Skrýt zkušební odeslání'
              : `Zkušební odeslání na testovací adresy: ${testCount} (skryto, v auditu zůstává)`}
          </Button>
        )}
      </div>
    </SectionCard>
  );
};

/**
 * Identity of the reminder card's editable state. The invoice detail keeps the section mounted while the
 * selected document changes, so keying the card by document remounts it and drops any editing draft instead
 * of leaking an outgoing invoice's prepare/send form onto an incoming one.
 */
export const invoiceReminderDraftKey = (invoice: Invoice): string =>
  `${invoice.ref.tenantId}:${invoice.ref.resourceId}:${invoice.direction}`;

export const InvoiceReminders = (props: InvoiceRemindersProps) => (
  <InvoiceRemindersCard key={invoiceReminderDraftKey(props.invoice)} {...props} />
);

/** S08 status of the invoice: only a handover, never "booked" without the accountant's confirmation. */
export const InvoiceHandover = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const exports = (vm.snapshot?.state.accountingExports ?? []).filter((entry) =>
    entry.invoiceResourceIds.some((id) => id === invoice.ref.resourceId),
  );
  const latest = exports.at(-1);
  return (
    <SectionCard title={t('finance-billing.financeUi.accounting.handover')}>
      {latest === undefined ? (
        <p className="text-fg-secondary text-sm">Doklad zatím nebyl předán účetní.</p>
      ) : (
        <div className="flex flex-col gap-100 text-sm">
          <Badge className="self-start" size="sm" variant={EXPORT_STATUS[latest.status].variant}>
            {EXPORT_STATUS[latest.status].label}
          </Badge>
          {latest.status === 'FAILED' && latest.failureReason !== undefined && (
            <span className="break-words text-xs" style={{ color: 'var(--color-danger)' }}>
              Chyba: {latest.failureReason}. Doklad lze zařadit do nového balíčku.
            </span>
          )}
          <span className="text-fg-secondary">
            Balíček {latest.batchNumber} ({latest.format === 'POHODA_XML' ? 'POHODA XML' : latest.format}, verze{' '}
            {latest.version}) · {at(latest.createdAt)} · {actorText(latest.actorLabel)}
          </span>
          <span className="text-fg-secondary text-xs">
            OntOS nevede účetnictví – stav „zaúčtováno“ eviduje až účetní systém.
          </span>
        </div>
      )}
    </SectionCard>
  );
};

const counterpartyHistoryKey = (entry: Invoice) =>
  entry.counterpartyRef.resourceId === '00000000-0000-4000-8000-000000000000'
    ? `name:${entry.counterpartyName ?? ''}`
    : entry.counterpartyRef.resourceId;

const HistoryPaymentBadge = ({
  invoice,
  referenceDate,
}: {
  readonly invoice: Invoice;
  readonly referenceDate: string;
}) => {
  if (invoice.paymentState === 'PAID') {
    return (
      <Badge size="sm" variant="success">
        uhrazeno
      </Badge>
    );
  }
  const overdue = remainingOf(invoice) > 0 && invoice.dueDate < referenceDate;
  let label = 'neuhrazeno';
  if (invoice.paymentState === 'PARTIALLY_PAID') {
    label = 'částečně';
  } else if (overdue) {
    label = 'po splatnosti';
  }
  return (
    <Badge size="sm" variant={overdue ? 'danger' : 'info'}>
      {label}
    </Badge>
  );
};

/** S09.R6: payment history of the counterparty across its other invoices. */
export const CounterpartyHistory = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const related = (vm.snapshot?.state.invoices ?? []).filter(
    (entry) => entry.businessState === 'CONFIRMED' && counterpartyHistoryKey(entry) === counterpartyHistoryKey(invoice),
  );
  if (related.length <= 1) {
    return null;
  }
  const paid = related.filter((entry) => entry.paymentState === 'PAID').length;
  const overdue = related.filter((entry) => remainingOf(entry) > 0 && entry.dueDate < vm.referenceDate).length;
  const outstanding = related.reduce((sum, entry) => sum + remainingOf(entry), 0);
  return (
    <SectionCard title={t('finance-billing.financeUi.payments.counterpartyHistory')}>
      <div className="flex flex-col gap-100 text-sm">
        <span>
          {confirmedDocumentsLabel(related.length)} · uhrazeno {paid} · po splatnosti{' '}
          <strong style={overdue > 0 ? { color: 'var(--color-danger)' } : undefined}>{overdue}</strong>
        </span>
        <span>
          Celkem neuhrazeno <strong className="tabular-nums">{formatMoney(outstanding)}</strong>
        </span>
        <ul className="flex flex-col divide-y divide-border-primary">
          {related.slice(0, 6).map((entry) => (
            <li className="flex items-center justify-between gap-100 py-50 text-xs" key={entry.ref.resourceId}>
              <span>{entry.number ?? entry.documentNumber}</span>
              <span className="tabular-nums">{formatMoney(entry.totalMinor)}</span>
              <HistoryPaymentBadge invoice={entry} referenceDate={vm.referenceDate} />
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
};
