// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import { dialogCloseLabel, formatDate, formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { DateTime } from 'effect';
import { useEffect, useState } from 'react';
import type { Invoice } from '../../../../../shared/apis/records.ts';
import { paymentEvents, reminderText } from '../../../../../shared/domain/finance-planning.ts';
import {
  ACCEPTED_DOCUMENT_TYPES,
  downloadBase64,
  formatBytes,
  MAX_UPLOAD_BYTES,
  outcomeMessage,
  parseAmountMinor,
  previewUrl,
  readUpload,
  SimulationBadge,
} from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';

/** Stored instants are Effect DateTime values; the shared formatter takes ISO strings. */
const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));

const remainingOf = (invoice: Invoice) => Math.max(0, invoice.totalMinor - invoice.paidMinor);

const actorText = (label: string | undefined, principal: string | undefined) =>
  label ?? (principal === undefined ? 'neznámý uživatel' : `uživatel ${principal.slice(0, 8)}…`);

/** Uploaded documents of one invoice: download, inline preview, and upload of another file. */
export const InvoiceDocuments = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const documents = (vm.snapshot?.state.documents ?? []).filter(
    (document) => document.invoiceResourceId === invoice.ref.resourceId,
  );
  const [preview, setPreview] = useState<{ readonly mimeType: string; readonly name: string; readonly url: string }>();
  const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  useEffect(() => () => (preview === undefined ? undefined : URL.revokeObjectURL(preview.url)), [preview]);

  const load = async (id: string, mode: 'download' | 'preview') => {
    setError(undefined);
    const document = await vm.fetchDocument(id);
    if (document === undefined) {
      setError('Obsah dokladu se nepodařilo načíst.');
      return;
    }
    if (mode === 'download') {
      downloadBase64(document.contentBase64, document.mimeType, document.fileName);
    } else {
      setPreview({
        mimeType: document.mimeType,
        name: document.fileName,
        url: previewUrl(document.contentBase64, document.mimeType),
      });
    }
  };

  const upload = async (file: File | undefined) => {
    if (file === undefined) {
      return;
    }
    setError(undefined);
    if (!(ACCEPTED_DOCUMENT_TYPES as readonly string[]).includes(file.type) || file.size > MAX_UPLOAD_BYTES) {
      setError('Nahrajte PDF nebo obrázek do velikosti 3 MB.');
      return;
    }
    setUploading(true);
    const outcome = await vm.execute(
      {
        _tag: 'AttachDocument',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        document: await readUpload(file),
        invoiceRef: invoice.ref,
      },
      'Doklad nahrán',
    );
    setUploading(false);
    if (!outcome.ok) {
      setError(outcomeMessage(vm, outcome));
    }
  };

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
                  onClick={() => void load(document.id, 'preview')}
                  size="sm"
                  theme="borderless"
                  variant="secondary"
                >
                  Náhled
                </Button>
                <Button
                  icon="icon-[mdi--download]"
                  onClick={() => void load(document.id, 'download')}
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
              onChange={(event) => void upload(event.target.files?.[0])}
              type="file"
            />
          </label>
        )}
      </div>
      <Dialog
        closeLabel={dialogCloseLabel}
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
export const InvoicePayments = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const state = vm.snapshot?.state;
  const events =
    state === undefined
      ? []
      : paymentEvents(state).filter((event) => event.invoiceResourceId === invoice.ref.resourceId);
  const manual = new Map((state?.manualPayments ?? []).map((payment) => [payment.id, payment]));
  const remaining = remainingOf(invoice);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(vm.referenceDate);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const amountMinor = parseAmountMinor(amount);
  const canRecord = vm.canWrite && invoice.businessState === 'CONFIRMED' && remaining > 0;

  const reset = () => {
    setOpen(false);
    setConfirming(false);
    setAmount('');
    setNote('');
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
  const save = async () => {
    if (amountMinor === undefined) {
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'RecordManualPayment',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        amountMinor,
        invoiceRef: invoice.ref,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
        paidOn: paidOn === '' ? vm.referenceDate : paidOn,
      },
      'Úhrada zaznamenána',
    );
    if (outcome.ok) {
      reset();
    } else {
      setConfirming(false);
      setError(outcomeMessage(vm, outcome));
    }
  };

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
                  {event.source === 'MANUAL' ? (
                    <Badge size="sm" variant="success">
                      Ručně potvrzeno
                    </Badge>
                  ) : (
                    <SimulationBadge>
                      {event.source === 'SIMULATED' ? 'SIMULACE – bankovní výpis' : 'Převzato z importu'}
                    </SimulationBadge>
                  )}
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
              <Button disabled={vm.busy} isLoading={vm.busy} onClick={() => void save()} variant="primary">
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
        title={
          confirming
            ? invoice.direction === 'INCOMING'
              ? 'Potvrdit odeslání platby?'
              : 'Potvrdit přijetí platby?'
            : 'Zaznamenat úhradu'
        }
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
              value={paidOn}
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

/** S07.R7 / S07-04: reminder text from a template; delivery is simulated because no e-mail provider is configured. */
export const InvoiceReminders = ({
  counterpartyName,
  invoice,
  vm,
}: {
  readonly counterpartyName: string;
  readonly invoice: Invoice;
  readonly vm: FinanceViewModel;
}) => {
  const reminders = (vm.snapshot?.state.reminders ?? []).filter(
    (reminder) => reminder.invoiceResourceId === invoice.ref.resourceId,
  );
  const open = invoice.businessState === 'CONFIRMED' && remainingOf(invoice) > 0;
  const [editing, setEditing] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ readonly kind: 'error' | 'success'; readonly text: string }>();

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
  const send = async () => {
    if (!/^\S+@\S+\.\S+$/u.test(recipient.trim())) {
      setMessage({ kind: 'error', text: 'Zadejte platnou e-mailovou adresu příjemce.' });
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'RecordReminder',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        invoiceRef: invoice.ref,
        recipient: recipient.trim(),
        text,
      },
      'Upomínka zaznamenána (simulace odeslání)',
    );
    if (outcome.ok) {
      setEditing(false);
      setRecipient('');
    } else {
      setMessage({ kind: 'error', text: outcomeMessage(vm, outcome) });
    }
  };

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
          <div className="flex flex-col gap-150 rounded-md border border-border-primary p-200">
            <StatusText showIcon size="sm" status="warning">
              E-mailový poskytovatel není nakonfigurován. Skutečné odeslání není dostupné – lze text zkopírovat, nebo
              odeslání pouze simulovat (bude označeno SIMULACE).
            </StatusText>
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
              id="reminder-text"
              label="Text upomínky"
              onChange={(event) => setText(event.target.value)}
              rows={9}
              value={text}
            />
            <div className="flex flex-wrap gap-100">
              <Button onClick={() => setEditing(false)} size="sm" theme="outlined" variant="secondary">
                Zrušit
              </Button>
              <Button
                icon="icon-[mdi--content-copy]"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => setMessage({ kind: 'success', text: 'Text upomínky zkopírován do schránky.' }))
                }
                size="sm"
                theme="outlined"
                variant="secondary"
              >
                Kopírovat text
              </Button>
              <Button
                disabled={vm.busy}
                icon="icon-[mdi--send-outline]"
                onClick={() => void send()}
                size="sm"
                variant="primary"
              >
                Odeslat (simulace)
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
                <SimulationBadge>SIMULACE – „odesláno“</SimulationBadge>
                <span className="text-fg-secondary text-xs">
                  {actorText(reminder.actorLabel, reminder.actorPrincipalId)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
};

/** S08 status of the invoice: only a handover, never "booked" without the accountant's confirmation. */
export const InvoiceHandover = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const exports = (vm.snapshot?.state.accountingExports ?? []).filter((entry) =>
    entry.invoiceResourceIds.includes(invoice.ref.resourceId),
  );
  const latest = exports.at(-1);
  return (
    <SectionCard title="Účetní předání">
      {latest === undefined ? (
        <p className="text-fg-secondary text-sm">Doklad zatím nebyl předán účetní.</p>
      ) : (
        <div className="flex flex-col gap-100 text-sm">
          <Badge size="sm" variant={latest.status === 'HANDED_OVER' ? 'info' : 'success'}>
            {latest.status === 'HANDED_OVER' ? 'Předáno – čeká na potvrzení' : 'Potvrdila účetní'}
          </Badge>
          <span className="text-fg-secondary">
            Balíček {latest.batchNumber} (verze {latest.version}) · {at(latest.createdAt)} ·{' '}
            {actorText(latest.actorLabel, latest.actorPrincipalId)}
          </span>
          <span className="text-fg-secondary text-xs">
            OntOS nevede účetnictví – stav „zaúčtováno“ eviduje až účetní systém.
          </span>
        </div>
      )}
    </SectionCard>
  );
};

/** S09.R6: payment history of the counterparty across its other invoices. */
export const CounterpartyHistory = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const key = (entry: Invoice) =>
    entry.counterpartyRef.resourceId === '00000000-0000-4000-8000-000000000000'
      ? `name:${entry.counterpartyName ?? ''}`
      : entry.counterpartyRef.resourceId;
  const related = (vm.snapshot?.state.invoices ?? []).filter(
    (entry) => entry.businessState === 'CONFIRMED' && key(entry) === key(invoice),
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
          {related.length} potvrzených dokladů · uhrazeno {paid} · po splatnosti{' '}
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
              <Badge
                size="sm"
                variant={
                  entry.paymentState === 'PAID'
                    ? 'success'
                    : remainingOf(entry) > 0 && entry.dueDate < vm.referenceDate
                      ? 'danger'
                      : 'info'
                }
              >
                {entry.paymentState === 'PAID'
                  ? 'uhrazeno'
                  : entry.paymentState === 'PARTIALLY_PAID'
                    ? 'částečně'
                    : remainingOf(entry) > 0 && entry.dueDate < vm.referenceDate
                      ? 'po splatnosti'
                      : 'neuhrazeno'}
              </Badge>
            </li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
};
