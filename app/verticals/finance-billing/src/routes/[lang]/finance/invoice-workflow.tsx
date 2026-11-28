import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { useBlocker } from '@modern-js/plugin-tanstack/runtime';
import { financeBrowserAtomRuntime, financeBrowserRuntime } from '../../../runtime/browser.ts';
import {
  SaveBar,
  dialogCloseLabel,
  formatDateTime,
  formatMoney,
  SectionCard,
  UnsavedChangesDialog,
  saveLabelsFor,
  useRecordDraft,
  useUnsavedChangesGuard,
} from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Link } from '@techsio/ui-kit/atoms/link';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import {
  FlaggedTextField,
  FormBuilder,
  FormReact,
  FormRoot,
  useAtomSet,
  useAtomSubscribe,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { DateTime, Effect, Option, Schema } from 'effect';
import { useEffect, useRef, useState } from 'react';
import type { AccountingExport, Invoice } from '../../../../shared/apis/records.ts';
import { outcomeMessage } from './finance-ui.tsx';
import { PriorSettlementForm } from './prior-settlement-form.tsx';
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
import { financeSaveOutcome } from './price-list-draft.ts';
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
      <Badge className="self-start" severity={presentation.variant} size="sm">
        {presentation.label}
      </Badge>
      {lifecycle !== 'VOIDED' && (
        <ol className="flex flex-col gap-50 text-sm">
          {STEPS.map(([step, label]) => (
            <li className="flex items-start gap-100" key={step}>
              <span
                aria-hidden
                className={`mt-[5px] size-2.5 shrink-0 rounded-full border-2 ${reached(step) ? 'border-success bg-success' : 'border-fg-secondary bg-transparent'}`}
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
const usePriorSettlement = ({ invoice, vm }: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const isTarget =
    invoice.direction === 'OUTGOING' && (invoice.documentKind === 'FINAL' || invoice.documentKind === 'PARTIAL');
  const invoices = vm.snapshot?.state.invoices ?? [];
  const settlement = invoice.priorSettlement;
  const [open, setOpen] = useState(false);
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

  return { available, candidates, editable, invoice, open, setOpen, settlement, total, visible, vm };
};

export const PriorSettlementCard = (props: { readonly invoice: Invoice; readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const { available, candidates, editable, invoice, open, setOpen, settlement, total, visible, vm } =
    usePriorSettlement(props);
  if (!visible) {
    return null;
  }
  return (
    <SectionCard
      actions={
        editable ? (
          <Button
            appearance="outline"
            icon="icon-[mdi--link-variant-plus]"
            onClick={() => setOpen(true)}
            severity="secondary"
            size="sm"
          >
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
                  <Link
                    className="inline-flex items-center gap-50 font-medium"
                    href={`?resourceId=${encodeURIComponent(entry.invoiceResourceId)}`}
                    size="current"
                  >
                    {entry.number}
                  </Link>
                  <span className="tabular-nums">− {formatMoney(entry.amountMinor)}</span>
                </li>
              ))}
            </ul>
            <span>
              Zohledněno celkem <strong className="tabular-nums">{formatMoney(total)}</strong> · k úhradě po zohlednění{' '}
              <strong className="tabular-nums">{formatMoney(Math.max(0, invoice.totalMinor - total))}</strong>
            </span>
            <Badge className="self-start whitespace-normal" severity="success" size="sm">
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
      {open && (
        <PriorSettlementForm
          available={available}
          candidates={candidates}
          invoice={invoice}
          onClose={() => setOpen(false)}
          vm={vm}
        />
      )}
    </SectionCard>
  );
};

/** The help text of a field the terms rule marks invalid. */
const hintWhen = (invalid: boolean, message: string) => (invalid ? message : undefined);

/** The terms as typed; the record draft below owns the save, the form only shows and edits them. */
const paymentTermsForm = FormReact.make(
  FormBuilder.empty
    .addField('lateAmount', Schema.String)
    .addField('lateText', Schema.String)
    .addField('skontoAmount', Schema.String)
    .addField('skontoText', Schema.String),
  {
    fields: {
      lateAmount: FlaggedTextField,
      lateText: FlaggedTextField,
      skontoAmount: FlaggedTextField,
      skontoText: FlaggedTextField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

/** Exactly the same text in every field; the draft's own equality ignores surrounding spaces. */
const sameText = (left: PaymentTermsDraft, right: PaymentTermsDraft) =>
  left.lateAmount === right.lateAmount &&
  left.lateText === right.lateText &&
  left.skontoAmount === right.skontoAmount &&
  left.skontoText === right.skontoText;

/**
 * Keeps the form's values and the record draft the same: typing goes into the draft, and a draft the record replaced
 * (Zahodit změny, Načíst aktuální verzi, a newer server version) goes back into the form.
 */
const DraftValues = ({
  draft,
  onTyped,
}: {
  readonly draft: PaymentTermsDraft;
  readonly onTyped: (value: PaymentTermsDraft) => void;
}) => {
  const setValues = useAtomSet(paymentTermsForm.setValues);
  const shown = useRef(draft);
  // Reading the values links them to the form's state, so the subscription below hears every change.
  useAtomValue(paymentTermsForm.values);
  useAtomSubscribe(
    paymentTermsForm.values,
    (values) => {
      if (Option.isSome(values) && !sameText(values.value, shown.current)) {
        shown.current = values.value;
        onTyped(values.value);
      }
    },
    { immediate: false },
  );
  useEffect(() => {
    if (!sameText(draft, shown.current)) {
      shown.current = draft;
      setValues(draft);
    }
  }, [draft, setValues]);
  return null;
};
const AMOUNT_HINT = 'Zadejte číslo, např. 1 250 nebo 1 250,50.';
const CONDITION_HINT = 'Ke schválené částce uveďte i sjednanou podmínku textem.';

/**
 * S09: agreed skonto and late-payment interest as text or a hand-approved amount; OntOS never computes them.
 * Changes stay on screen until Uložit; leaving with unsaved changes asks first. The save is sent only while the ledger
 * still has the terms the draft started from; when someone else changed them, the dialog offers the current version.
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
  const { language, t } = useModernI18n();
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
          Effect.map(financeSaveOutcome),
        )
      : Effect.succeed<SaveOutcome>('conflict');
  const record = useRecordDraft<PaymentTermsDraft, never>({
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
  const settledOnServer = !record.pending && samePaymentTermsDraft(record.draft, server);
  useEffect(() => {
    if (settledOnServer) {
      base.current = server;
    }
  }, [base, server, settledOnServer]);
  const { draft } = record;
  const problems = paymentTermsProblems(draft);
  const blocker = useBlocker({ enableBeforeUnload: false, shouldBlockFn: () => record.dirty, withResolver: true });
  const guard = useUnsavedChangesGuard({ draft: record, navigation: blocker, onDiscard: record.discard });
  const close = () => {
    guard.request(onClose);
  };
  const labels = saveLabelsFor(language);
  const handleReloadLatest = record.reloadLatest;
  const handleSave = record.save;
  const handleTyped = record.setDraft;
  return (
    <>
      <Dialog
        actions={
          <>
            <Button appearance="outline" onClick={close} severity="secondary">
              Zavřít
            </Button>
            <SaveBar labels={labels} onReloadLatest={handleReloadLatest} onSave={handleSave} status={record.status} />
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
        <FormRoot className="flex flex-col gap-150" defaultValues={draft} form={paymentTermsForm} translateMessage={t}>
          <DraftValues draft={draft} onTyped={handleTyped} />
          {error !== undefined && (
            <StatusText showIcon size="sm" status="error">
              {error}
            </StatusText>
          )}
          <paymentTermsForm.skontoText
            helpText={hintWhen(problems.skontoText, CONDITION_HINT)}
            id="terms-skonto-text"
            invalid={problems.skontoText}
            label={t('finance-billing.financeUi.paymentTerms.discountCondition')}
            placeholder={t('finance-billing.financeUi.paymentTerms.discountExample')}
            size="sm"
          />
          <paymentTermsForm.skontoAmount
            helpText={hintWhen(problems.skontoAmount, AMOUNT_HINT)}
            id="terms-skonto-amount"
            inputMode="decimal"
            invalid={problems.skontoAmount}
            label={t('finance-billing.financeUi.paymentTerms.discountAmount')}
            size="sm"
          />
          <paymentTermsForm.lateText
            helpText={hintWhen(problems.lateText, CONDITION_HINT)}
            id="terms-late-text"
            invalid={problems.lateText}
            label={t('finance-billing.financeUi.paymentTerms.interestCondition')}
            placeholder={t('finance-billing.financeUi.paymentTerms.interestExample')}
            size="sm"
          />
          <paymentTermsForm.lateAmount
            helpText={hintWhen(problems.lateAmount, AMOUNT_HINT)}
            id="terms-late-amount"
            inputMode="decimal"
            invalid={problems.lateAmount}
            label={t('finance-billing.financeUi.paymentTerms.interestAmount')}
            size="sm"
          />
        </FormRoot>
      </Dialog>
      <UnsavedChangesDialog labels={labels} prompt={guard.prompt} />
    </>
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
            appearance="outline"
            icon="icon-[mdi--pencil-outline]"
            onClick={() => setOpen(true)}
            severity="secondary"
            size="sm"
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
