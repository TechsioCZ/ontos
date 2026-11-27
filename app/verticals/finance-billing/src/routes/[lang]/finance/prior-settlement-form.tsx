// The amounts of earlier advance or partial invoices a final or partial invoice takes into account (S07.R2). Typing
// changes only the draft; the shared Uložit sends it once, only while the invoice still has the settlement the draft
// started from (someone else's newer one is a conflict with "Načíst aktuální verzi"); leaving with input asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatDate, formatMoney } from '@app/admin-ui';
import { CheckboxField, EntryTextField, FormBuilder, FormReact, FormRoot, TextField } from '@app/core-runtime/ui/form';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Schema } from 'effect';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

const P = 'finance-billing.financeUi.settlement';

/**
 * The typed amount per earlier invoice (resource id; empty means not taken into account), the note, and the person's
 * check of the amounts, which every save requires and which is not part of what is saved. Uložit sends the draft
 * through the save bar, so the form only holds it.
 */
const settlementForm = FormReact.make(
  FormBuilder.empty
    .addField('amounts', Schema.Record(Schema.String, Schema.String))
    .addField('checked', Schema.Boolean)
    .addField('note', Schema.String),
  {
    fields: { amounts: EntryTextField, checked: CheckboxField, note: TextField },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

export interface SettlementDraft {
  /** The typed amount per earlier invoice (resource id); empty means not taken into account. */
  readonly amounts: Readonly<Record<string, string>>;
  readonly note: string;
}

/** The settlement the invoice has now, in the draft's shape. */
export const settlementDraftOf = (invoice: Invoice): SettlementDraft => ({
  amounts: Object.fromEntries(
    (invoice.priorSettlement?.entries ?? []).map((entry) => [entry.invoiceResourceId, minorToInput(entry.amountMinor)]),
  ),
  note: invoice.priorSettlement?.note ?? '',
});

/** The amounts a draft would save, by earlier invoice; an empty field saves nothing. */
const filledAmounts = (draft: SettlementDraft): ReadonlyMap<string, string> => {
  const filled = new Map<string, string>();
  for (const [id, raw] of Object.entries(draft.amounts)) {
    if (raw.trim() !== '') {
      filled.set(id, raw.trim());
    }
  }
  return filled;
};

/** Two drafts are the same when they would save the same amounts and note. */
const sameSettlement = (left: SettlementDraft, right: SettlementDraft) => {
  const leftAmounts = filledAmounts(left);
  const rightAmounts = filledAmounts(right);
  return (
    left.note.trim() === right.note.trim() &&
    leftAmounts.size === rightAmounts.size &&
    [...leftAmounts].every(([id, amount]) => rightAmounts.get(id) === amount)
  );
};

const entriesOf = (draft: SettlementDraft, candidates: readonly Invoice[]) =>
  candidates.flatMap((entry) => {
    const raw = (draft.amounts[entry.ref.resourceId] ?? '').trim();
    return raw === '' ? [] : [{ amountMinor: parseAmountMinor(raw) ?? -1, invoiceResourceId: entry.ref.resourceId }];
  });

const SettlementProblemSchema = Schema.Literals(['errorConfirm', 'errorOver', 'errorPositive', 'errorTotal']);
type SettlementProblem = typeof SettlementProblemSchema.Type;

export interface PriorSettlementFormProps {
  /** How much of an earlier invoice can still be taken into account. */
  readonly available: (entry: Invoice) => number;
  /** The earlier confirmed advance or partial invoices of the same customer. */
  readonly candidates: readonly Invoice[];
  readonly invoice: Invoice;
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}

export const PriorSettlementForm = ({ available, candidates, invoice, onClose, vm }: PriorSettlementFormProps) => {
  const { t } = useModernI18n();
  const initial = settlementDraftOf(invoice);
  const opened = { ...initial, checked: false };
  const values = useFormDraft(settlementForm, opened);
  const { checked, ...draft } = values.draft;
  const problemOf = (value: SettlementDraft): SettlementProblem | undefined => {
    const entries = entriesOf(value, candidates);
    if (entries.some((entry) => entry.amountMinor <= 0)) {
      return 'errorPositive';
    }
    const over = entries.some((entry) => {
      const source = candidates.find((item) => item.ref.resourceId === entry.invoiceResourceId);
      return source === undefined || entry.amountMinor > available(source);
    });
    if (over) {
      return 'errorOver';
    }
    if (entries.reduce((sum, entry) => sum + entry.amountMinor, 0) > invoice.totalMinor) {
      return 'errorTotal';
    }
    return checked ? undefined : 'errorConfirm';
  };
  const form = useFinanceFormSave({
    equals: sameSettlement,
    initial,
    isValid: (value) => problemOf(value) === undefined,
    onClose,
    // Going back to a version keeps whether the person checked the amounts.
    reset: (value) => values.reset({ ...value, checked }),
    send: (value) => {
      const entries = entriesOf(value, candidates);
      const command: FinanceCommandDraft<'SetPriorSettlement'> = {
        _tag: 'SetPriorSettlement',
        entries,
        invoiceRef: invoice.ref,
      };
      if (vm.actorLabel !== undefined) {
        command.actorLabel = vm.actorLabel;
      }
      if (value.note.trim() !== '') {
        command.note = value.note.trim();
      }
      return vm.execute(command, t(`${P}.${entries.length === 0 ? 'removedToast' : 'confirmedToast'}`));
    },
    server: () => {
      const current = (vm.snapshot?.state.invoices ?? []).find(
        (item) => item.ref.resourceId === invoice.ref.resourceId,
      );
      return current === undefined ? undefined : settlementDraftOf(current);
    },
    value: draft,
    vm,
  });
  const problem = form.record.status === 'invalid' ? problemOf(draft) : undefined;
  return (
    <FinanceFormDialog
      description={t(`${P}.formDescription`, {
        number: invoice.number ?? invoice.documentNumber,
        total: formatMoney(invoice.totalMinor),
      })}
      form={form}
      title={t(`${P}.title`)}
    >
      <FormRoot className="flex flex-col gap-150" defaultValues={opened} form={settlementForm} translateMessage={t}>
        {values.ready}
        {problem !== undefined && (
          <StatusText showIcon size="sm" status="warning">
            {t(`${P}.${problem}`)}
          </StatusText>
        )}
        {candidates.length === 0 ? (
          <p className="text-fg-secondary text-sm">{t(`${P}.noCandidate`)}</p>
        ) : (
          candidates.map((entry) => (
            <div
              className="grid grid-cols-1 items-end gap-100 sm:grid-cols-[minmax(0,1fr)_10rem]"
              key={entry.ref.resourceId}
            >
              <span className="flex min-w-0 flex-col text-sm">
                <span className="font-medium">
                  {t(`${P}.candidate`, {
                    date: formatDate(entry.issueDate),
                    kind: t(`${P}.${entry.documentKind === 'ADVANCE' ? 'kindAdvance' : 'kindPartial'}`),
                    number: entry.number ?? entry.documentNumber,
                  })}
                </span>
                <span className="text-fg-secondary text-xs">
                  {t(`${P}.candidateHint`, {
                    available: formatMoney(available(entry)),
                    paid: formatMoney(entry.paidMinor),
                    total: formatMoney(entry.totalMinor),
                  })}
                </span>
              </span>
              <settlementForm.amounts
                entry={entry.ref.resourceId}
                id={`prior-${entry.ref.resourceId}`}
                inputMode="decimal"
                label={t(`${P}.amount`)}
                size="sm"
              />
            </div>
          ))
        )}
        <settlementForm.note id="prior-note" label={t(`${P}.note`)} size="sm" />
        <settlementForm.checked id="prior-confirm" label={t(`${P}.confirm`)} />
      </FormRoot>
    </FinanceFormDialog>
  );
};
