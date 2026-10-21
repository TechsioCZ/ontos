// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalDate:off
import { dialogCloseLabel, formatDate, formatDateTime, formatMoney, SectionCard } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../../shared/apis/records.ts';
import { minorToInput, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { invoiceLifecycle, latestHandover, LIFECYCLE_PRESENTATION } from './invoice-view.ts';

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));
const numberOf = (invoice: Invoice) => invoice.number ?? invoice.documentNumber;

const STEPS = [
  ['DRAFT', 'Návrh'],
  ['PREPARED', 'Připraveno'],
  ['APPROVED', 'Schváleno'],
  ['HANDED_OVER', 'Předáno do účetnictví'],
] as const;
type Step = (typeof STEPS)[number][0];
const ORDER = ['DRAFT', 'PREPARED', 'APPROVED', 'HANDED_OVER', 'ACCOUNTANT_CONFIRMED'];

/** S07.R5: the four lifecycle steps with who did what and when. */
export const InvoiceLifecycleCard = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const exports = vm.snapshot?.state.accountingExports ?? [];
  const lifecycle = invoiceLifecycle(invoice, exports);
  const handover = latestHandover(invoice, exports);
  const reached = (step: Step) => {
    if (lifecycle === 'VOIDED') {
      return false;
    }
    // A received invoice entered by hand is recorded and approved in one step, so "připraveno" is skipped.
    if (step === 'PREPARED' && invoice.preparedAt === undefined && ORDER.indexOf(lifecycle) >= 2) {
      return false;
    }
    return ORDER.indexOf(lifecycle) >= ORDER.indexOf(step);
  };
  const detail: Record<Step, string | undefined> = {
    APPROVED:
      invoice.approvedAt === undefined ? undefined : `${invoice.approvedByLabel ?? 'uživatel'} · ${at(invoice.approvedAt)}`,
    DRAFT: at(invoice.createdAt),
    HANDED_OVER:
      handover === undefined
        ? undefined
        : `${handover.batchNumber}${handover.handedOverAt === undefined ? '' : ` · ${at(handover.handedOverAt)}`}${handover.status === 'CONFIRMED_BY_ACCOUNTANT' ? ' · potvrdila účetní' : ''}`,
    PREPARED:
      invoice.preparedAt === undefined ? undefined : `${invoice.preparedByLabel ?? 'uživatel'} · ${at(invoice.preparedAt)}`,
  };
  const presentation = LIFECYCLE_PRESENTATION[lifecycle];
  const pendingPackage = handover?.status === 'PREPARED' ? handover.batchNumber : undefined;
  return (
    <div className="flex flex-col gap-150" data-finance-lifecycle={lifecycle}>
      <Badge className="self-start" size="sm" variant={presentation.variant}>
        {presentation.label}
      </Badge>
      {lifecycle !== 'VOIDED' && (
        <ol className="flex flex-col gap-75 text-sm">
          {STEPS.map(([step, label]) => (
            <li className="flex items-start gap-100" key={step}>
              <span
                aria-hidden
                className="mt-[5px] size-[10px] shrink-0 rounded-full"
                style={{
                  background: reached(step) ? 'var(--color-success)' : 'transparent',
                  border: `2px solid ${reached(step) ? 'var(--color-success)' : 'var(--color-fg-secondary)'}`,
                }}
              />
              <span className="flex min-w-0 flex-col">
                <span className={reached(step) ? 'font-medium' : 'text-fg-secondary'}>
                  {label}
                  <span className="sr-only">{reached(step) ? ' – hotovo' : ' – zatím ne'}</span>
                </span>
                {reached(step) && detail[step] !== undefined && (
                  <span className="break-words text-fg-secondary text-xs">{detail[step]}</span>
                )}
                {step === 'HANDED_OVER' && pendingPackage !== undefined && (
                  <span className="break-words text-fg-secondary text-xs">
                    V balíčku {pendingPackage} (připraveno, zatím nepředáno)
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};

/**
 * S07.R2: a final or partial invoice lists the earlier advance/partial invoices it takes into account, with the
 * amounts a user confirmed by hand. The amount settles that part of the invoice once it is approved.
 */
export const PriorSettlementCard = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const isTarget =
    invoice.direction === 'OUTGOING' && (invoice.documentKind === 'FINAL' || invoice.documentKind === 'PARTIAL');
  const invoices = vm.snapshot?.state.invoices ?? [];
  const settlement = invoice.priorSettlement;
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string>>>({});
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  if (!isTarget && settlement === undefined) {
    return null;
  }
  const usedElsewhere = (id: string) =>
    invoices
      .filter((entry) => entry.ref.resourceId !== invoice.ref.resourceId && entry.businessState !== 'VOIDED')
      .flatMap((entry) => entry.priorSettlement?.entries ?? [])
      .filter((entry) => entry.invoiceResourceId === id)
      .reduce((sum, entry) => sum + entry.amountMinor, 0);
  const candidates = invoices.filter(
    (entry) =>
      entry.ref.resourceId !== invoice.ref.resourceId &&
      entry.direction === 'OUTGOING' &&
      entry.businessState === 'CONFIRMED' &&
      (entry.documentKind === 'ADVANCE' || entry.documentKind === 'PARTIAL') &&
      entry.counterpartyRef.resourceId === invoice.counterpartyRef.resourceId,
  );
  const available = (entry: Invoice) => Math.max(0, entry.paidMinor - usedElsewhere(entry.ref.resourceId));
  const total = (settlement?.entries ?? []).reduce((sum, entry) => sum + entry.amountMinor, 0);
  const editable = vm.canWrite && invoice.businessState === 'DRAFT';

  const start = () => {
    setAmounts(
      Object.fromEntries(
        candidates.map((entry) => {
          const stored = settlement?.entries.find((item) => item.invoiceResourceId === entry.ref.resourceId);
          return [entry.ref.resourceId, stored === undefined ? '' : minorToInput(stored.amountMinor)];
        }),
      ),
    );
    setNote(settlement?.note ?? '');
    setConfirmed(false);
    setError(undefined);
    setOpen(true);
  };
  const save = async () => {
    const entries = candidates.flatMap((entry) => {
      const raw = (amounts[entry.ref.resourceId] ?? '').trim();
      if (raw === '') {
        return [];
      }
      const amountMinor = parseAmountMinor(raw);
      return [{ amountMinor: amountMinor ?? -1, invoiceResourceId: entry.ref.resourceId }];
    });
    if (entries.some((entry) => entry.amountMinor <= 0)) {
      setError('Zadejte kladné částky, např. 25 000 nebo 25 000,50.');
      return;
    }
    const over = entries.find((entry) => {
      const source = candidates.find((item) => item.ref.resourceId === entry.invoiceResourceId);
      return source === undefined || entry.amountMinor > available(source);
    });
    if (over !== undefined) {
      setError('Částka přesahuje uhrazenou a dosud nezohledněnou část dřívějšího dokladu.');
      return;
    }
    if (entries.reduce((sum, entry) => sum + entry.amountMinor, 0) > invoice.totalMinor) {
      setError('Součet zohledněných částek přesahuje celkovou částku této faktury.');
      return;
    }
    if (!confirmed) {
      setError('Potvrďte, že jste částky zkontrolovali.');
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'SetPriorSettlement',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        entries,
        invoiceRef: invoice.ref,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      },
      entries.length === 0 ? 'Zohlednění předchozích dokladů odebráno' : 'Zohlednění předchozích dokladů potvrzeno',
    );
    if (outcome.ok) {
      setOpen(false);
    } else {
      setError(outcomeMessage(vm, outcome));
    }
  };

  return (
    <SectionCard
      actions={
        editable ? (
          <Button icon="icon-[mdi--link-variant-plus]" onClick={start} size="sm" theme="outlined" variant="secondary">
            {settlement === undefined ? 'Zohlednit předchozí doklady' : 'Upravit'}
          </Button>
        ) : undefined
      }
      title="Předchozí zálohové a dílčí doklady"
    >
      <div className="flex flex-col gap-150 text-sm" data-finance-prior-settlement="">
        {settlement === undefined ? (
          <p className="text-fg-secondary">
            {candidates.length === 0
              ? 'Pro tohoto odběratele zatím není žádná potvrzená zálohová ani dílčí faktura.'
              : 'Zatím nebyly ručně potvrzeny žádné částky z dřívějších dokladů.'}
          </p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border-primary">
              {settlement.entries.map((entry) => (
                <li className="flex flex-wrap items-center justify-between gap-100 py-75" key={entry.invoiceResourceId}>
                  <a
                    className="inline-flex items-center gap-50 font-medium underline"
                    href={`?resourceId=${encodeURIComponent(entry.invoiceResourceId)}`}
                  >
                    {entry.number}
                  </a>
                  <span className="tabular-nums">− {formatMoney(entry.amountMinor)}</span>
                </li>
              ))}
            </ul>
            <span>
              Zohledněno celkem <strong className="tabular-nums">{formatMoney(total)}</strong> · k úhradě po
              zohlednění{' '}
              <strong className="tabular-nums">{formatMoney(Math.max(0, invoice.totalMinor - total))}</strong>
            </span>
            <Badge className="self-start whitespace-normal" size="sm" variant="success">
              {`Ručně potvrdil(a) ${settlement.confirmedByLabel ?? 'uživatel'} · ${at(settlement.confirmedAt)}`}
            </Badge>
            {settlement.note !== undefined && <span className="text-fg-secondary text-xs">{settlement.note}</span>}
          </>
        )}
        <p className="text-fg-secondary text-xs">
          Zohledněná částka se po schválení započte jako již uhrazená část (bez nového pohybu peněz). Daňové vyúčtování
          záloh potvrzuje účetní, OntOS ho automaticky neprovádí.
        </p>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={() => setOpen(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button disabled={vm.busy} isLoading={vm.busy} onClick={() => void save()} variant="primary">
              Uložit potvrzení
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={`Faktura ${numberOf(invoice)} na ${formatMoney(invoice.totalMinor)}. Zadejte částky, které se z dřívějších dokladů zohlední.`}
        onOpenChange={(details) => setOpen(details.open)}
        open={open}
        placement="center"
        size="md"
        title="Zohlednění předchozích dokladů"
      >
        <div className="flex flex-col gap-150">
          {error !== undefined && (
            <StatusText showIcon size="sm" status="error">
              {error}
            </StatusText>
          )}
          {candidates.length === 0 ? (
            <p className="text-fg-secondary text-sm">Žádný vhodný dřívější doklad tohoto odběratele.</p>
          ) : (
            candidates.map((entry) => (
              <div
                className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,1fr)_10rem]"
                key={entry.ref.resourceId}
              >
                <span className="flex min-w-0 flex-col text-sm">
                  <span className="font-medium">
                    {numberOf(entry)} · {entry.documentKind === 'ADVANCE' ? 'zálohová' : 'dílčí'} ·{' '}
                    {formatDate(entry.issueDate)}
                  </span>
                  <span className="text-fg-secondary text-xs">
                    Uhrazeno {formatMoney(entry.paidMinor)} z {formatMoney(entry.totalMinor)} · lze zohlednit nejvýše{' '}
                    {formatMoney(available(entry))}
                  </span>
                </span>
                <FormInput
                  id={`prior-${entry.ref.resourceId}`}
                  label="Zohlednit (Kč)"
                  inputMode="decimal"
                  onChange={(event) =>
                    setAmounts((current) => ({ ...current, [entry.ref.resourceId]: event.target.value }))
                  }
                  placeholder="0"
                  size="sm"
                  value={amounts[entry.ref.resourceId] ?? ''}
                />
              </div>
            ))
          )}
          <FormInput
            id="prior-note"
            label="Poznámka (např. číslo daňového dokladu k přijaté platbě)"
            onChange={(event) => setNote(event.target.value)}
            size="sm"
            value={note}
          />
          <FormCheckbox
            checked={confirmed}
            id="prior-confirm"
            label="Potvrzuji, že jsem částky zkontroloval(a) a mají se na této faktuře zohlednit."
            onCheckedChange={setConfirmed}
            size="sm"
          />
        </div>
      </Dialog>
    </SectionCard>
  );
};

/** S09: agreed skonto and late-payment interest as text or a hand-approved amount; OntOS never computes them. */
export const PaymentTermsCard = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const terms = invoice.paymentTerms;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ lateAmount: '', lateText: '', skontoAmount: '', skontoText: '' });
  const [error, setError] = useState<string>();
  const editable = vm.canWrite && invoice.businessState !== 'VOIDED';
  const start = () => {
    setForm({
      lateAmount: minorToInput(terms?.lateInterestApprovedMinor),
      lateText: terms?.lateInterestText ?? '',
      skontoAmount: minorToInput(terms?.skontoApprovedMinor),
      skontoText: terms?.skontoText ?? '',
    });
    setError(undefined);
    setOpen(true);
  };
  const save = async () => {
    const optionalAmount = (raw: string) => (raw.trim() === '' ? undefined : parseAmountMinor(raw));
    const skontoAmount = optionalAmount(form.skontoAmount);
    const lateAmount = optionalAmount(form.lateAmount);
    if (
      (form.skontoAmount.trim() !== '' && skontoAmount === undefined) ||
      (form.lateAmount.trim() !== '' && lateAmount === undefined)
    ) {
      setError('Částky zadejte jako číslo, např. 1 250 nebo 1 250,50.');
      return;
    }
    if (
      (skontoAmount !== undefined && form.skontoText.trim() === '') ||
      (lateAmount !== undefined && form.lateText.trim() === '')
    ) {
      setError('Ke schválené částce uveďte i sjednanou podmínku textem.');
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'SetPaymentTerms',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        invoiceRef: invoice.ref,
        ...(lateAmount === undefined ? {} : { lateInterestApprovedMinor: lateAmount }),
        ...(form.lateText.trim() === '' ? {} : { lateInterestText: form.lateText.trim() }),
        ...(skontoAmount === undefined ? {} : { skontoApprovedMinor: skontoAmount }),
        ...(form.skontoText.trim() === '' ? {} : { skontoText: form.skontoText.trim() }),
      },
      'Platební podmínky uloženy',
    );
    if (outcome.ok) {
      setOpen(false);
    } else {
      setError(
        outcome.reason?.includes('payment_terms_invalid') === true
          ? 'Schválené skonto nesmí být vyšší než částka faktury a ke každé částce patří i text podmínky.'
          : outcomeMessage(vm, outcome),
      );
    }
  };
  return (
    <SectionCard
      actions={
        editable ? (
          <Button icon="icon-[mdi--pencil-outline]" onClick={start} size="sm" theme="outlined" variant="secondary">
            {terms === undefined ? 'Doplnit' : 'Upravit'}
          </Button>
        ) : undefined
      }
      title="Skonto a úrok z prodlení"
    >
      <div className="flex flex-col gap-150 text-sm" data-finance-payment-terms="">
        {terms === undefined ? (
          <p className="text-fg-secondary">U dokladu není evidováno skonto ani sjednaný úrok z prodlení.</p>
        ) : (
          <dl className="flex flex-col gap-100">
            <div className="flex flex-col gap-25">
              <dt className="text-fg-secondary text-xs">Skonto</dt>
              <dd className="break-words">
                {terms.skontoText ?? '—'}
                {terms.skontoApprovedMinor !== undefined && (
                  <span className="block font-medium tabular-nums">
                    ručně schválená částka {formatMoney(terms.skontoApprovedMinor)}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-25">
              <dt className="text-fg-secondary text-xs">Sjednaný úrok z prodlení</dt>
              <dd className="break-words">
                {terms.lateInterestText ?? '—'}
                {terms.lateInterestApprovedMinor !== undefined && (
                  <span className="block font-medium tabular-nums">
                    ručně schválená částka {formatMoney(terms.lateInterestApprovedMinor)}
                  </span>
                )}
              </dd>
            </div>
            <span className="text-fg-secondary text-xs">
              Zapsal(a) {terms.updatedByLabel ?? 'uživatel'} · {at(terms.updatedAt)}
            </span>
          </dl>
        )}
        <p className="text-fg-secondary text-xs">
          OntOS skonto ani úrok automaticky nepočítá ani neodečítá – eviduje sjednaný text nebo ručně schválenou částku.
        </p>
      </div>
      <Dialog
        actions={
          <>
            <Button onClick={() => setOpen(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button disabled={vm.busy} isLoading={vm.busy} onClick={() => void save()} variant="primary">
              Uložit
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Vyplňte, co bylo sjednáno. Prázdná pole se neuloží."
        onOpenChange={(details) => setOpen(details.open)}
        open={open}
        placement="center"
        size="md"
        title={`Skonto a úrok z prodlení · ${numberOf(invoice)}`}
      >
        <div className="flex flex-col gap-150">
          {error !== undefined && (
            <StatusText showIcon size="sm" status="error">
              {error}
            </StatusText>
          )}
          <FormInput
            id="terms-skonto-text"
            label="Podmínka skonta"
            onChange={(event) => setForm((current) => ({ ...current, skontoText: event.target.value }))}
            placeholder="např. 2 % při úhradě do 7 dnů od vystavení"
            size="sm"
            value={form.skontoText}
          />
          <FormInput
            id="terms-skonto-amount"
            inputMode="decimal"
            label="Ručně schválená částka skonta (Kč, nepovinné)"
            onChange={(event) => setForm((current) => ({ ...current, skontoAmount: event.target.value }))}
            size="sm"
            value={form.skontoAmount}
          />
          <FormInput
            id="terms-late-text"
            label="Sjednaný úrok z prodlení"
            onChange={(event) => setForm((current) => ({ ...current, lateText: event.target.value }))}
            placeholder="např. 0,05 % z dlužné částky za každý den prodlení dle čl. 7 smlouvy"
            size="sm"
            value={form.lateText}
          />
          <FormInput
            id="terms-late-amount"
            inputMode="decimal"
            label="Ručně schválená částka úroku (Kč, nepovinné)"
            onChange={(event) => setForm((current) => ({ ...current, lateAmount: event.target.value }))}
            size="sm"
            value={form.lateAmount}
          />
        </div>
      </Dialog>
    </SectionCard>
  );
};
