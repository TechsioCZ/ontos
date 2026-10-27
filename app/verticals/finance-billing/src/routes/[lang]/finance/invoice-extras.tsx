import type { Schema } from 'effect';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import {
  dialogCloseLabel,
  formatDate,
  formatDateTime,
  formatMoney,
  SectionCard,
  surfaceTileClassName,
} from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Data, DateTime, Effect, Option, Result } from 'effect';
import { useEffect, useReducer, useState } from 'react';
import type { Invoice, AccountingExportStatus } from '../../../../shared/apis/records.ts';
import { isTestReminderRecipient, paymentEvents, reminderText } from '../../../../shared/domain/finance-planning.ts';
import {
  ACCEPTED_DOCUMENT_TYPES,
  downloadBase64,
  formatBytes,
  MAX_UPLOAD_BYTES,
  outcomeMessage,
  parseAmountMinor,
  previewUrl,
  readUpload,
} from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { ReminderEmailStatus, useEmailProvider, useReminderEmailReceipts } from './reminder-email-receipts.tsx';
import type { EmailProviderState } from './reminder-email-receipts.tsx';
import { useInvoiceIssuer } from './use-invoice-issuer.ts';
import { confirmedDocumentsLabel } from './invoice-view.ts';

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

/** Same bound as FinanceLongTextSchema in shared/apis/records.ts (trimmed reminder text, at most 4000 characters). */
const REMINDER_TEXT_MAX = 4000;

class FinanceClipboardError extends Data.TaggedError('FinanceClipboardError')<{
  readonly cause: Schema.Defect['Type'];
}> {}

/** Stored instants are Effect DateTime values; the shared formatter takes ISO strings. */
const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

const remainingOf = (invoice: Invoice) => Math.max(0, invoice.totalMinor - invoice.paidMinor);

const actorText = (label: string | undefined, principal: string | undefined) =>
  label ?? (principal === undefined ? 'neznámý uživatel' : `uživatel ${principal.slice(0, 8)}…`);

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
  const { documents, error, invoice, load, preview, setPreview, upload, uploading, vm } = useInvoiceDocuments(props);
  return (
    <SectionCard title="Doklady a přílohy">
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
                    {formatBytes(document.sizeBytes)} · {at(document.uploadedAt)} ·{' '}
                    {actorText(document.actorLabel, document.actorPrincipalId)} · SHA-256 {document.sha256.slice(0, 12)}
                    …
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

/** Payment history with the user's confirmation step (S07.R5, S07-02). */
interface PaymentDraft {
  readonly amount: string;
  readonly confirming: boolean;
  readonly note: string;
  readonly open: boolean;
  readonly paidOn: string;
}
const emptyPaymentDraft: PaymentDraft = { amount: '', confirming: false, note: '', open: false, paidOn: '' };
const paymentDialogTitle = (confirming: boolean, direction: Invoice['direction']) => {
  if (!confirming) {
    return 'Zaznamenat úhradu';
  }
  return direction === 'INCOMING' ? 'Potvrdit odeslání platby?' : 'Potvrdit přijetí platby?';
};
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

const invoicePaymentsSaveProgram = Effect.fn('Finance.save')(function* invoicePaymentsSaveProgram(
  context: Pick<
    ReturnType<typeof useInvoicePayments>,
    'amountMinor' | 'invoice' | 'note' | 'paidOn' | 'reset' | 'setConfirming' | 'setError' | 'vm'
  >,
) {
  const { amountMinor, invoice, note, paidOn, reset, setConfirming, setError, vm } = context;
  if (amountMinor === undefined) {
    return;
  }
  const recordManualPaymentCommand: FinanceCommandDraft<'RecordManualPayment'> = {
    _tag: 'RecordManualPayment',
    amountMinor,
    invoiceRef: invoice.ref,
    paidOn: paidOn === '' ? vm.referenceDate : paidOn,
  };
  if (vm.actorLabel !== undefined) {
    recordManualPaymentCommand.actorLabel = vm.actorLabel;
  }
  if (note.trim() !== '') {
    recordManualPaymentCommand.note = note.trim();
  }
  const outcome = yield* vm.execute(recordManualPaymentCommand, 'Úhrada zaznamenána');
  if (outcome.ok) {
    reset();
  } else {
    setConfirming(false);
    setError(outcomeMessage(vm, outcome));
  }
});

const useInvoicePayments = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const state = vm.snapshot?.state;
  const events =
    state === undefined
      ? []
      : paymentEvents(state).filter((event) => event.invoiceResourceId === invoice.ref.resourceId);
  const manual = new Map((state?.manualPayments ?? []).map((payment) => [payment.id, payment]));
  const remaining = remainingOf(invoice);
  const [draft, updateDraft] = useReducer(
    (current: PaymentDraft, patch: Partial<PaymentDraft>) => ({ ...current, ...patch }),
    emptyPaymentDraft,
  );
  const { amount, confirming, note, open, paidOn } = draft;
  const setOpen = (nextOpen: boolean) => updateDraft({ open: nextOpen });
  const setConfirming = (nextConfirming: boolean) => updateDraft({ confirming: nextConfirming });
  const setAmount = (nextAmount: string) => updateDraft({ amount: nextAmount });
  const setPaidOn = (nextPaidOn: string) => updateDraft({ paidOn: nextPaidOn });
  const setNote = (nextNote: string) => updateDraft({ note: nextNote });
  const [error, setError] = useState<string>();
  const amountMinor = parseAmountMinor(amount);
  const canRecord = vm.canWrite && invoice.businessState === 'CONFIRMED' && remaining > 0;

  const reset = () => {
    updateDraft({ amount: '', confirming: false, note: '', open: false });
    setError(undefined);
  };
  const review = () => {
    if (amountMinor === undefined || amountMinor === 0) {
      setError('Zadejte kladnou částku.');
      return;
    }
    if (amountMinor > remaining) {
      setError(`Částka přesahuje zbývajících ${formatMoney(remaining)}.`);
      return;
    }
    setError(undefined);
    setConfirming(true);
  };
  const save = (): void => {
    void financeBrowserRuntime.runPromise(
      invoicePaymentsSaveProgram({ amountMinor, invoice, note, paidOn, reset, setConfirming, setError, vm }),
    );
  };
  return {
    amount,
    amountMinor,
    canRecord,
    confirming,
    draft,
    error,
    events,
    invoice,
    manual,
    note,
    open,
    paidOn,
    remaining,
    reset,
    review,
    save,
    setAmount,
    setConfirming,
    setError,
    setNote,
    setOpen,
    setPaidOn,
    state,
    updateDraft,
    vm,
  };
};

export const InvoicePayments = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const {
    amount,
    amountMinor,
    canRecord,
    confirming,
    error,
    events,
    invoice,
    manual,
    note,
    open,
    paidOn,
    remaining,
    reset,
    review,
    save,
    setAmount,
    setConfirming,
    setNote,
    setOpen,
    setPaidOn,
    vm,
  } = useInvoicePayments(props);
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
      title="Úhrady"
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
                      {actorText(payment.actorLabel, payment.actorPrincipalId)} · {at(payment.recordedAt)}
                      {payment.note === undefined ? '' : ` · ${payment.note}`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Dialog
        actions={
          confirming ? (
            <>
              <Button onClick={() => setConfirming(false)} theme="outlined" variant="secondary">
                Zpět
              </Button>
              <Button
                disabled={vm.busy}
                isLoading={vm.busy}
                onClick={() => {
                  save();
                }}
                variant="primary"
              >
                Potvrzuji úhradu
              </Button>
            </>
          ) : (
            <>
              <Button onClick={reset} theme="outlined" variant="secondary">
                Zrušit
              </Button>
              <Button onClick={review} variant="primary">
                Pokračovat
              </Button>
            </>
          )
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={
          confirming
            ? 'Úhrada se zapíše jako ručně potvrzená vaším jménem. Tento krok nelze vzít zpět.'
            : `Zbývá uhradit ${formatMoney(remaining)} z ${formatMoney(invoice.totalMinor)}.`
        }
        onOpenChange={(details) => {
          if (!details.open) {
            reset();
          }
        }}
        open={open}
        placement="center"
        role={confirming ? 'alertdialog' : 'dialog'}
        size="sm"
        title={paymentDialogTitle(confirming, invoice.direction)}
      >
        {confirming ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-300 gap-y-100 text-sm">
            <dt className="text-fg-secondary">Faktura</dt>
            <dd>{invoice.number ?? invoice.documentNumber}</dd>
            <dt className="text-fg-secondary">Částka</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(amountMinor ?? 0)}</dd>
            <dt className="text-fg-secondary">Datum úhrady</dt>
            <dd>{formatDate(paidOn)}</dd>
            <dt className="text-fg-secondary">Po potvrzení úhrady zbývá</dt>
            <dd className="tabular-nums">{formatMoney(remaining - (amountMinor ?? 0))}</dd>
          </dl>
        ) : (
          <div className="flex flex-col gap-150">
            {error !== undefined && (
              <StatusText showIcon size="sm" status="error">
                {error}
              </StatusText>
            )}
            <FormInput
              helpText={amountMinor === undefined ? undefined : formatMoney(amountMinor)}
              id="payment-amount"
              inputMode="decimal"
              label="Částka (Kč)"
              onChange={(event) => setAmount(event.target.value)}
              placeholder={(remaining / 100).toFixed(0)}
              size="sm"
              value={amount}
            />
            <div className="flex gap-100">
              <Button
                onClick={() => setAmount(String(remaining / 100).replace('.', ','))}
                size="sm"
                theme="borderless"
                variant="secondary"
              >
                Celý zbytek
              </Button>
            </div>
            <FormInput
              id="payment-date"
              label="Datum úhrady"
              onChange={(event) => setPaidOn(event.target.value)}
              size="sm"
              type="date"
              value={paidOn === '' ? vm.referenceDate : paidOn}
            />
            <FormInput
              id="payment-note"
              label="Poznámka (např. číslo výpisu)"
              onChange={(event) => setNote(event.target.value)}
              size="sm"
              value={note}
            />
          </div>
        )}
      </Dialog>
    </SectionCard>
  );
};

const EmailProviderStatus = ({
  issuerName,
  provider,
}: {
  readonly issuerName: string | undefined;
  readonly provider: EmailProviderState;
}) => {
  if (provider.kind === 'loading') {
    return (
      <StatusText showIcon size="sm" status="default">
        Zjišťuji, zda je nastaven e-mailový poskytovatel…
      </StatusText>
    );
  }
  if (provider.kind === 'ready' && provider.provider.configured) {
    return (
      <StatusText showIcon size="sm" status="default">
        Po uložení se upomínka skutečně odešle e-mailem ({provider.provider.label ?? 'SMTP server'}) jménem{' '}
        {issuerName === undefined ? 'vybrané společnosti' : `společnosti ${issuerName}`}. Stav odeslání se zobrazí v
        seznamu upomínek.
      </StatusText>
    );
  }
  return (
    <StatusText showIcon size="sm" status="warning">
      {provider.kind === 'unavailable'
        ? 'Odeslání e-mailem teď není dostupné – e-mailovou službu nelze ověřit.'
        : 'Odeslání e-mailem není dostupné – e-mailový poskytovatel (SMTP server) není nastaven.'}{' '}
      Text upomínky zkopírujte nebo stáhněte a pošlete jinou cestou; jako odeslaná se nezaznamená.
    </StatusText>
  );
};

/** S07.R7 / S07-04: reminder text from a template; sent once over real SMTP by the demo e-mail dispatcher after commit. */
const invoiceRemindersSendProgram = Effect.fn('Finance.send')(function* invoiceRemindersSendProgram(
  context: Pick<
    ReturnType<typeof useInvoiceReminders>,
    | 'canSendEmail'
    | 'invoice'
    | 'recipient'
    | 'setEditing'
    | 'setMessage'
    | 'setRecipient'
    | 'text'
    | 'textLength'
    | 'vm'
  >,
) {
  const { canSendEmail, invoice, recipient, setEditing, setMessage, setRecipient, text, textLength, vm } = context;
  if (!canSendEmail) {
    setMessage({
      kind: 'error',
      text: 'Odeslání e-mailem není dostupné – e-mailový poskytovatel není nastaven. Nic se neodeslalo.',
    });
    return;
  }
  if (!/^\S+@\S+\.\S+$/u.test(recipient.trim())) {
    setMessage({ kind: 'error', text: 'Zadejte platnou e-mailovou adresu příjemce.' });
    return;
  }
  if (textLength === 0 || textLength > REMINDER_TEXT_MAX) {
    setMessage({
      kind: 'error',
      text:
        textLength === 0
          ? 'Text upomínky nesmí být prázdný.'
          : `Text upomínky je příliš dlouhý (${textLength} znaků, nejvýše ${REMINDER_TEXT_MAX}). Zkraťte ho.`,
    });
    return;
  }
  const recordReminderCommand: FinanceCommandDraft<'RecordReminder'> = {
    _tag: 'RecordReminder',
    invoiceRef: invoice.ref,
    recipient: recipient.trim(),
    text: text.trim(),
  };
  if (vm.actorLabel !== undefined) {
    recordReminderCommand.actorLabel = vm.actorLabel;
  }
  const outcome = yield* vm.execute(recordReminderCommand, 'Upomínka uložena a předána k odeslání e-mailem.');
  if (outcome.ok) {
    setEditing(false);
    setRecipient('');
  } else {
    setMessage({ kind: 'error', text: outcomeMessage(vm, outcome) });
  }
});

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
  const open = invoice.businessState === 'CONFIRMED' && remainingOf(invoice) > 0;
  const [editing, setEditing] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ readonly kind: 'error' | 'success'; readonly text: string }>();
  const issuerName = useInvoiceIssuer();
  const provider = useEmailProvider();
  const canSendEmail = provider.kind === 'ready' && provider.provider.configured;
  // The contract trims the text; an untrimmed value (e.g. a trailing space or newline) fails to encode in the browser.
  const textLength = text.trim().length;
  const textTooLong = textLength > REMINDER_TEXT_MAX;

  const start = () => {
    setText(
      reminderText({
        businessDate: vm.referenceDate,
        counterpartyName,
        invoice,
        senderName: vm.actorLabel ?? 'Finanční oddělení',
      }),
    );
    setMessage(undefined);
    setEditing(true);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text.trim()}\n`], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `upominka-${invoice.number ?? invoice.documentNumber}.txt`;
    link.click();
    void financeBrowserRuntime.runPromise(
      Effect.sleep('1 second').pipe(Effect.andThen(Effect.sync(() => URL.revokeObjectURL(url)))),
    );
    setMessage({
      kind: 'success',
      text: 'Návrh upomínky stažen jako textový soubor. Upomínka se jako odeslaná nezaznamenala.',
    });
  };
  const send = (): void => {
    void financeBrowserRuntime.runPromise(
      invoiceRemindersSendProgram({
        canSendEmail,
        invoice,
        recipient,
        setEditing,
        setMessage,
        setRecipient,
        text,
        textLength,
        vm,
      }),
    );
  };
  return {
    allReminders,
    canSendEmail,
    counterpartyName,
    download,
    editing,
    invoice,
    issuerName,
    message,
    open,
    provider,
    receipts,
    recipient,
    reminders,
    send,
    setEditing,
    setMessage,
    setRecipient,
    setShowTests,
    setText,
    showTests,
    start,
    testCount,
    text,
    textLength,
    textTooLong,
    vm,
  };
};

export const InvoiceReminders = (props: {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}) => {
  const {
    canSendEmail,
    download,
    editing,
    issuerName,
    message,
    open,
    provider,
    receipts,
    recipient,
    reminders,
    send,
    setEditing,
    setMessage,
    setRecipient,
    setShowTests,
    setText,
    showTests,
    start,
    testCount,
    text,
    textLength,
    textTooLong,
    vm,
  } = useInvoiceReminders(props);
  return (
    <SectionCard
      actions={
        vm.canWrite && open && !editing ? (
          <Button icon="icon-[mdi--email-alert-outline]" onClick={start} size="sm" theme="outlined" variant="secondary">
            Připravit upomínku
          </Button>
        ) : undefined
      }
      title="Upomínky"
    >
      <div className="flex flex-col gap-150 print:hidden">
        {editing && (
          <div className={`${surfaceTileClassName} flex flex-col gap-150 p-200`}>
            <EmailProviderStatus issuerName={issuerName} provider={provider} />
            {message !== undefined && (
              <StatusText showIcon size="sm" status={message.kind}>
                {message.text}
              </StatusText>
            )}
            <FormInput
              id="reminder-recipient"
              label="E-mail příjemce"
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="fakturace@odberatel.cz"
              size="sm"
              type="email"
              value={recipient}
            />
            <FormTextarea
              helpText={
                textTooLong
                  ? `${textLength} / ${REMINDER_TEXT_MAX} znaků – text je příliš dlouhý, zkraťte ho o ${textLength - REMINDER_TEXT_MAX}.`
                  : `${textLength} / ${REMINDER_TEXT_MAX} znaků`
              }
              id="reminder-text"
              label="Text upomínky"
              onChange={(event) => setText(event.target.value)}
              rows={9}
              validateStatus={textTooLong ? 'error' : 'default'}
              value={text}
            />
            <div className="flex flex-wrap gap-100">
              <Button onClick={() => setEditing(false)} size="sm" theme="outlined" variant="secondary">
                Zrušit
              </Button>
              <Button
                icon="icon-[mdi--content-copy]"
                onClick={() => {
                  void financeBrowserRuntime.runPromise(
                    Effect.tryPromise({
                      catch: (cause) => new FinanceClipboardError({ cause }),
                      try: navigator.clipboard.writeText.bind(navigator.clipboard, text),
                    }).pipe(
                      Effect.timeout('10 seconds'),
                      Effect.tap(() =>
                        Effect.sync(() =>
                          setMessage({ kind: 'success', text: 'Text upomínky zkopírován do schránky.' }),
                        ),
                      ),
                      Effect.result,
                    ),
                  );
                }}
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Kopírovat text
              </Button>
              <Button icon="icon-[mdi--download]" onClick={download} size="sm" theme="outlined" variant="secondary">
                Stáhnout návrh
              </Button>
              <Button
                disabled={vm.busy || textTooLong || !canSendEmail}
                icon="icon-[mdi--send-outline]"
                onClick={() => {
                  send();
                }}
                size="sm"
                variant="primary"
              >
                Odeslat e-mailem
              </Button>
            </div>
          </div>
        )}
        {reminders.length === 0 && !editing && (
          <p className="text-fg-secondary text-sm">
            {open
              ? 'K faktuře zatím nebyla odeslána žádná upomínka.'
              : 'Upomínka se připravuje jen k neuhrazené potvrzené faktuře.'}
          </p>
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
                <span className="text-fg-secondary text-xs">
                  {actorText(reminder.actorLabel, reminder.actorPrincipalId)}
                </span>
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

/** S08 status of the invoice: only a handover, never "booked" without the accountant's confirmation. */
export const InvoiceHandover = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const exports = (vm.snapshot?.state.accountingExports ?? []).filter((entry) =>
    entry.invoiceResourceIds.some((id) => id === invoice.ref.resourceId),
  );
  const latest = exports.at(-1);
  return (
    <SectionCard title="Účetní předání">
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
            {latest.version}) · {at(latest.createdAt)} · {actorText(latest.actorLabel, latest.actorPrincipalId)}
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
    <SectionCard title="Platební historie protistrany">
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
