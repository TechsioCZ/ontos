// The amounts of earlier advance or partial invoices a final or partial invoice takes into account (S07.R2). Typing
// changes only the draft; the shared Uložit sends it once, only while the invoice still has the settlement the draft
// started from (someone else's newer one is a conflict with "Načíst aktuální verzi"); leaving with input asks first.
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { formatDate, formatMoney } from '@app/admin-ui';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormCheckbox } from '@techsio/ui-kit/molecules/form-checkbox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Schema } from 'effect';
import { useState } from 'react';
import type { Invoice } from '../../../../shared/apis/records.ts';
import { FinanceFormDialog, useFinanceFormSave } from './finance-form-save.tsx';
import { minorToInput, parseAmountMinor } from './finance-ui.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

const P = 'finance-billing.financeUi.settlement';

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
  const [draft, setDraft] = useState(initial);
  /** The person checked the amounts; required for every save, not part of what is saved. */
  const [checked, setChecked] = useState(false);
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
    reset: setDraft,
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
      <div className="flex flex-col gap-150">
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
              <FormInput
                id={`prior-${entry.ref.resourceId}`}
                inputMode="decimal"
                label={t(`${P}.amount`)}
                onChange={(event) => {
                  const { value } = event.target;
                  setDraft((current) => ({
                    ...current,
                    amounts: { ...current.amounts, [entry.ref.resourceId]: value },
                  }));
                }}
                size="sm"
                value={draft.amounts[entry.ref.resourceId] ?? ''}
              />
            </div>
          ))
        )}
        <FormInput
          id="prior-note"
          label={t(`${P}.note`)}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, note: value }));
          }}
          size="sm"
          value={draft.note}
        />
        <FormCheckbox
          checked={checked}
          id="prior-confirm"
          label={t(`${P}.confirm`)}
          onCheckedChange={setChecked}
          size="sm"
        />
      </div>
    </FinanceFormDialog>
  );
};
