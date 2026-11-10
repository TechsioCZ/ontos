import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import {
  SaveBar,
  dialogCloseLabel,
  formatDate,
  formatDateTime,
  formatMoney,
  SectionCard,
  useRecordDraft,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { DateTime, Effect, Option } from 'effect';
import { useEffect, useReducer, useRef, useState } from 'react';
import type { AccountingExport, Invoice } from '../../../../shared/apis/records.ts';
import { minorToInput, outcomeMessage, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';
import { invoiceLifecycle, latestHandover, LIFECYCLE_PRESENTATION } from './invoice-view.ts';
import {
  paymentTermsCommandOf,
  paymentTermsDraftOf,
  paymentTermsProblems,
  paymentTermsUnchangedSince,
  samePaymentTermsDraft,
} from './payment-terms-draft.ts';
import type { PaymentTermsDraft } from './payment-terms-draft.ts';
import { financeAutosaveOutcome } from './price-list-draft.ts';
import type { CommandOutcome } from './use-finance-records.ts';

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

const handoverDetail = (handover: AccountingExport) => {
  const time = handover.handedOverAt === undefined ? '' : ` · ${at(handover.handedOverAt)}`;
  const confirmation = handover.status === 'CONFIRMED_BY_ACCOUNTANT' ? ' · potvrdila účetní' : '';
  return `${handover.batchNumber}${time}${confirmation}`;
};

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
  const detail = {
    APPROVED:
      invoice.approvedAt === undefined
        ? undefined
        : `${invoice.approvedByLabel ?? 'uživatel'} · ${at(invoice.approvedAt)}`,
    DRAFT: at(invoice.createdAt),
    HANDED_OVER: handover === undefined ? undefined : handoverDetail(handover),
    PREPARED:
      invoice.preparedAt === undefined
        ? undefined
        : `${invoice.preparedByLabel ?? 'uživatel'} · ${at(invoice.preparedAt)}`,
  } satisfies Record<Step, string | undefined>;
  const presentation = LIFECYCLE_PRESENTATION[lifecycle];
  const pendingPackage = handover?.status === 'PREPARED' ? handover.batchNumber : undefined;
  return (
    <div className="flex flex-col gap-150" data-finance-lifecycle={lifecycle}>
      <Badge className="self-start" size="sm" variant={presentation.variant}>
        {presentation.label}
      </Badge>
      {lifecycle !== 'VOIDED' && (
        <ol className="flex flex-col gap-50 text-sm">
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
interface SettlementDraft {
  readonly amounts: Readonly<Record<string, string>>;
  readonly confirmed: boolean;
  readonly note: string;
  readonly open: boolean;
}
interface SettlementPatch extends Partial<SettlementDraft> {
  readonly amountId?: string;
  readonly amountValue?: string;
}
const reduceSettlement = (current: SettlementDraft, action: SettlementPatch): SettlementDraft => {
  const { amountId, amountValue, ...patch } = action;
  if (amountId !== undefined && amountValue !== undefined) {
    return { ...current, ...patch, amounts: { ...current.amounts, [amountId]: amountValue } };
  }
  return { ...current, ...patch };
};
const emptySettlementDraft: SettlementDraft = { amounts: {}, confirmed: false, note: '', open: false };

const priorSettlementSaveProgram = Effect.fn('Finance.save')(function* priorSettlementSaveProgram(
  context: Pick<
    ReturnType<typeof usePriorSettlement>,
    'amounts' | 'available' | 'candidates' | 'confirmed' | 'invoice' | 'note' | 'setError' | 'setOpen' | 'vm'
  >,
) {
  const { amounts, available, candidates, confirmed, invoice, note, setError, setOpen, vm } = context;
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
  const setPriorSettlementCommand: FinanceCommandDraft<'SetPriorSettlement'> = {
    _tag: 'SetPriorSettlement',
    entries,
    invoiceRef: invoice.ref,
  };
  if (vm.actorLabel !== undefined) {
    setPriorSettlementCommand.actorLabel = vm.actorLabel;
  }
  if (note.trim() !== '') {
    setPriorSettlementCommand.note = note.trim();
  }
  const outcome = yield* vm.execute(
    setPriorSettlementCommand,
    entries.length === 0 ? 'Zohlednění předchozích dokladů odebráno' : 'Zohlednění předchozích dokladů potvrzeno',
  );
  if (outcome.ok) {
    setOpen(false);
  } else {
    setError(outcomeMessage(vm, outcome));
  }
});

const usePriorSettlement = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const isTarget =
    invoice.direction === 'OUTGOING' && (invoice.documentKind === 'FINAL' || invoice.documentKind === 'PARTIAL');
  const invoices = vm.snapshot?.state.invoices ?? [];
  const settlement = invoice.priorSettlement;
  const [draft, updateDraft] = useReducer(reduceSettlement, emptySettlementDraft);
  const { amounts, confirmed, note, open } = draft;
  const setOpen = (nextOpen: boolean) => updateDraft({ open: nextOpen });
  const setAmounts = (nextAmounts: SettlementDraft['amounts']) => updateDraft({ amounts: nextAmounts });
  const setNote = (nextNote: string) => updateDraft({ note: nextNote });
  const setConfirmed = (nextConfirmed: boolean) => updateDraft({ confirmed: nextConfirmed });
  const [error, setError] = useState<string>();
  const visible = isTarget || settlement !== undefined;
  const usedElsewhere = (id: string) => {
    let total = 0;
    for (const entry of invoices) {
      if (entry.ref.resourceId === invoice.ref.resourceId || entry.businessState === 'VOIDED') {
        continue;
      }
      for (const settlementEntry of entry.priorSettlement?.entries ?? []) {
        if (settlementEntry.invoiceResourceId === id) {
          total += settlementEntry.amountMinor;
        }
      }
    }
    return total;
  };

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
  const save = (): void => {
    void financeBrowserRuntime.runPromise(
      priorSettlementSaveProgram({ amounts, available, candidates, confirmed, invoice, note, setError, setOpen, vm }),
    );
  };
  return {
    amounts,
    available,
    candidates,
    confirmed,
    draft,
    editable,
    error,
    invoice,
    invoices,
    isTarget,
    note,
    open,
    save,
    setAmounts,
    setConfirmed,
    setError,
    setNote,
    setOpen,
    settlement,
    start,
    total,
    updateDraft,
    usedElsewhere,
    visible,
    vm,
  };
};

export const PriorSettlementCard = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const {
    amounts,
    available,
    candidates,
    confirmed,
    editable,
    error,
    invoice,
    note,
    open,
    save,
    setConfirmed,
    setNote,
    setOpen,
    settlement,
    start,
    total,
    updateDraft,
    visible,
    vm,
  } = usePriorSettlement(props);
  if (!visible) {
    return null;
  }
  return (
    <SectionCard
      actions={
        editable ? (
          <Button icon="icon-[mdi--link-variant-plus]" onClick={start} size="sm" theme="outlined" variant="secondary">
            {settlement === undefined ? 'Zohlednit předchozí doklady' : 'Upravit'}
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.settlement.previousDocuments')}
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
                <li className="flex flex-wrap items-center justify-between gap-100 py-50" key={entry.invoiceResourceId}>
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
              Zohledněno celkem <strong className="tabular-nums">{formatMoney(total)}</strong> · k úhradě po zohlednění{' '}
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
            <Button
              disabled={vm.busy}
              isLoading={vm.busy}
              onClick={() => {
                save();
              }}
              variant="primary"
            >
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
        title={t('finance-billing.financeUi.settlement.title')}
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
                  inputMode="decimal"
                  label={t('finance-billing.financeUi.settlement.amount')}
                  onChange={(event) => updateDraft({ amountId: entry.ref.resourceId, amountValue: event.target.value })}
                  placeholder="0"
                  size="sm"
                  value={amounts[entry.ref.resourceId] ?? ''}
                />
              </div>
            ))
          )}
          <FormInput
            id="prior-note"
            label={t('finance-billing.financeUi.settlement.note')}
            onChange={(event) => setNote(event.target.value)}
            size="sm"
            value={note}
          />
          <FormCheckbox
            checked={confirmed}
            id="prior-confirm"
            label={t('finance-billing.financeUi.settlement.confirm')}
            onCheckedChange={setConfirmed}
            size="sm"
          />
        </div>
      </Dialog>
    </SectionCard>
  );
};

/** Error props for a field, spread so `validateStatus` is absent (not undefined) when the field is valid. */
const invalidField = (invalid: boolean, message: string) =>
  invalid ? { helpText: message, validateStatus: 'error' as const } : {};
const AMOUNT_HINT = 'Zadejte číslo, např. 1 250 nebo 1 250,50.';
const CONDITION_HINT = 'Ke schválené částce uveďte i sjednanou podmínku textem.';

/**
 * S09: agreed skonto and late-payment interest as text or a hand-approved amount; OntOS never computes them.
 * Changes save themselves (debounced, on blur and on Zavřít) only while the ledger still has the terms the draft
 * started from; when someone else changed them, the dialog offers the current version.
 */
const PaymentTermsDialog = ({
  invoice,
  onClose,
  vm,
}: {
  readonly invoice: Invoice;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const { t } = useModernI18n();
  const [error, setError] = useState<string>();
  const server = paymentTermsDraftOf(invoice);
  /** The version of the terms the draft builds on: what the dialog opened with, last saved or reloaded. */
  const base = useRef(server);
  const settle = (value: PaymentTermsDraft, outcome: CommandOutcome) => {
    if (outcome.ok) {
      base.current = value;
      setError(undefined);
      return;
    }
    if (outcome.feedback === 'conflict') {
      setError(undefined);
      return;
    }
    setError(
      outcome.reason?.includes('payment_terms_invalid') === true
        ? 'Schválené skonto nesmí být vyšší než částka faktury a ke každé částce patří i text podmínky.'
        : outcomeMessage(vm, outcome),
    );
  };
  const send = (value: PaymentTermsDraft, command: FinanceCommandDraft<'SetPaymentTerms'>) =>
    paymentTermsUnchangedSince(invoice.ref.resourceId, base.current)(vm.snapshot?.state.invoices ?? [])
      ? vm.execute(command).pipe(
          Effect.tap((outcome) => Effect.sync(() => settle(value, outcome))),
          Effect.map(financeAutosaveOutcome),
        )
      : Effect.succeed<SaveOutcome>('conflict');
  const autosave = useRecordDraft<PaymentTermsDraft, never>({
    equals: samePaymentTermsDraft,
    isValid: (value) => Option.isSome(paymentTermsCommandOf(invoice, value, vm.actorLabel)),
    runtime: financeBrowserRuntime,
    save: (value) =>
      Option.match(paymentTermsCommandOf(invoice, value, vm.actorLabel), {
        onNone: () => Effect.succeed<SaveOutcome>('failed'),
        onSome: (command) => send(value, command),
      }),
    server,
  });
  const settledOnServer = !autosave.pending && samePaymentTermsDraft(autosave.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const { draft } = autosave;
  const problems = paymentTermsProblems(draft);
  const change = (field: keyof PaymentTermsDraft) => (value: string) =>
    autosave.setDraft((current) => ({ ...current, [field]: value }));
  const close = () => {
    onClose();
  };
  const handleSave = autosave.save;
  const handleReloadLatest = autosave.reloadLatest;
  return (
    <Dialog
      actions={
        <>
          <SaveBar onReloadLatest={handleReloadLatest} onSave={handleSave} status={autosave.status} />
          <Button onClick={close} theme="outlined" variant="secondary">
            Zavřít
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description="Vyplňte, co bylo sjednáno. Prázdná pole se neuloží."
      onOpenChange={(details) => {
        if (!details.open) {
          close();
        }
      }}
      open
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
          label={t('finance-billing.financeUi.paymentTerms.discountCondition')}
          onChange={(event) => change('skontoText')(event.target.value)}
          placeholder={t('finance-billing.financeUi.paymentTerms.discountExample')}
          size="sm"
          value={draft.skontoText}
          {...invalidField(problems.skontoText, CONDITION_HINT)}
        />
        <FormInput
          id="terms-skonto-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.paymentTerms.discountAmount')}
          onChange={(event) => change('skontoAmount')(event.target.value)}
          size="sm"
          value={draft.skontoAmount}
          {...invalidField(problems.skontoAmount, AMOUNT_HINT)}
        />
        <FormInput
          id="terms-late-text"
          label={t('finance-billing.financeUi.paymentTerms.interestCondition')}
          onChange={(event) => change('lateText')(event.target.value)}
          placeholder={t('finance-billing.financeUi.paymentTerms.interestExample')}
          size="sm"
          value={draft.lateText}
          {...invalidField(problems.lateText, CONDITION_HINT)}
        />
        <FormInput
          id="terms-late-amount"
          inputMode="decimal"
          label={t('finance-billing.financeUi.paymentTerms.interestAmount')}
          onChange={(event) => change('lateAmount')(event.target.value)}
          size="sm"
          value={draft.lateAmount}
          {...invalidField(problems.lateAmount, AMOUNT_HINT)}
        />
      </div>
    </Dialog>
  );
};

export const PaymentTermsCard = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { invoice, vm } = props;
  const terms = invoice.paymentTerms;
  const editable = vm.canWrite && invoice.businessState !== 'VOIDED';
  const [open, setOpen] = useState(false);
  return (
    <SectionCard
      actions={
        editable ? (
          <Button
            icon="icon-[mdi--pencil-outline]"
            onClick={() => setOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {terms === undefined ? 'Doplnit' : 'Upravit'}
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.paymentTerms.title')}
    >
      <div className="flex flex-col gap-150 text-sm" data-finance-payment-terms="">
        {terms === undefined ? (
          <p className="text-fg-secondary">U dokladu není evidováno skonto ani sjednaný úrok z prodlení.</p>
        ) : (
          <dl className="flex flex-col gap-100">
            <div className="flex flex-col gap-50">
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
            <div className="flex flex-col gap-50">
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
      {open && <PaymentTermsDialog invoice={invoice} onClose={() => setOpen(false)} vm={vm} />}
    </SectionCard>
  );
};
