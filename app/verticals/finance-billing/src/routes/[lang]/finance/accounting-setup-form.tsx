// The accounting registry and issuer identity, edited inline and saved only on the shared Uložit.
import { UnsavedChangesDialog } from '@app/admin-ui';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { useState } from 'react';
import type { AccountingSetup } from '../../../../shared/apis/records.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import type { FinanceCommandDraft, FinanceViewModel } from './finance-ui.tsx';

export const SETUP_FIELDS = [
  ['product', 'Účetní systém'],
  ['productVersion', 'Verze systému'],
  ['accountant', 'Odpovědná účetní'],
  ['transferFormat', 'Schválený přenosový formát'],
  ['approvalDate', 'Datum schválení'],
] as const;
export type SetupKey = (typeof SETUP_FIELDS)[number][0];

/** Identity of the selected company as an accounting unit; written to POHODA XML (dataPack ico, myIdentity). */
export const ISSUER_FIELDS = [
  ['issuerIco', 'IČO účetní jednotky'],
  ['issuerVatId', 'DIČ účetní jednotky'],
  ['issuerStreet', 'Ulice a číslo popisné'],
  ['issuerCity', 'Obec'],
  ['issuerZip', 'PSČ'],
] as const;
const ALL_FIELDS = [...SETUP_FIELDS, ...ISSUER_FIELDS] as const;

/** Every field as the form shows it, the date as its input text; an empty field is not sent. */
const setupDraftOf = (setup: AccountingSetup) => ({
  accountant: setup.accountant ?? '',
  approvalDate: setup.approvalDate ?? '',
  issuerCity: setup.issuerCity ?? '',
  issuerIco: setup.issuerIco ?? '',
  issuerStreet: setup.issuerStreet ?? '',
  issuerVatId: setup.issuerVatId ?? '',
  issuerZip: setup.issuerZip ?? '',
  product: setup.product ?? '',
  productVersion: setup.productVersion ?? '',
  transferFormat: setup.transferFormat ?? '',
});
type SetupDraft = ReturnType<typeof setupDraftOf>;

const clean = (value: string) => (value.trim() === '' ? undefined : value.trim());

/** Why the identity cannot be saved yet, or undefined when it can. */
const setupProblem = (draft: SetupDraft): string | undefined => {
  const ico = clean(draft.issuerIco);
  const vatId = clean(draft.issuerVatId);
  if (ico !== undefined && !/^\d{8}$/u.test(ico)) {
    return 'IČO musí mít přesně 8 číslic.';
  }
  if (vatId !== undefined && !/^CZ\d{8,10}$/u.test(vatId)) {
    return 'DIČ musí mít tvar CZ a 8–10 číslic, např. CZ12345678.';
  }
  return undefined;
};

const setupCommandOf = (draft: SetupDraft, actorLabel: string | undefined) => {
  const command: FinanceCommandDraft<'UpdateAccountingSetup'> = {
    _tag: 'UpdateAccountingSetup',
    ...Object.fromEntries(
      ALL_FIELDS.flatMap(([key]) => {
        const value = clean(draft[key]);
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
  if (actorLabel !== undefined) {
    command.actorLabel = actorLabel;
  }
  return command;
};

/** Saved only over the setup it opened with: someone else's newer setup is shown as a conflict, never overwritten. */
export const AccountingSetupForm = ({
  onClose,
  vm,
}: {
  readonly onClose: () => void;
  readonly vm: FinanceViewModel;
}) => {
  const server = () => setupDraftOf(vm.snapshot?.state.accountingSetup ?? {});
  const initial = server();
  const [draft, setDraft] = useState(initial);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => setupProblem(value) === undefined,
    onClose,
    reset: setDraft,
    send: (value) => vm.execute(setupCommandOf(value, vm.actorLabel), 'Nastavení účetního napojení uloženo'),
    server,
    value: draft,
    vm,
  });
  const problem = form.record.status === 'invalid' ? setupProblem(draft) : undefined;
  return (
    <div className="grid grid-cols-1 gap-200 md:grid-cols-2">
      {ALL_FIELDS.map(([key, label]) => (
        <FormInput
          id={`setup-${key}`}
          key={key}
          label={label}
          onChange={(event) => {
            const { value } = event.target;
            setDraft((current) => ({ ...current, [key]: value }));
          }}
          size="sm"
          type={key === 'approvalDate' ? 'date' : 'text'}
          value={draft[key]}
        />
      ))}
      {problem !== undefined && (
        <div className="md:col-span-2">
          <StatusText showIcon size="sm" status="error">
            {problem}
          </StatusText>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-100 md:col-span-2">
        <FinanceSaveActions form={form} size="sm" />
      </div>
      <UnsavedChangesDialog labels={form.labels} prompt={form.guard.prompt} />
    </div>
  );
};
