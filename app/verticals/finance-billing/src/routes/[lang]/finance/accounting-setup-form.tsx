// The accounting registry and issuer identity, edited inline and saved only on the shared Uložit.
import { UnsavedChangesDialog } from '@app/admin-ui';
import { FormBuilder, FormReact, FormRoot, TextField } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Effect, Schema } from 'effect';
import type { AccountingSetup } from '../../../../shared/apis/records.ts';
import { financeBrowserAtomRuntime } from '../../../runtime/browser.ts';
import { FinanceSaveActions, useFinanceFormSave } from './finance-form-save.tsx';
import { useFormDraft } from './finance-form-draft.tsx';
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

/**
 * Every field as its input text, the date included; an empty field is not sent. Uložit sends the draft through the
 * save bar, so the form only holds it.
 */
const setupForm = FormReact.make(
  FormBuilder.empty
    .addField('accountant', Schema.String)
    .addField('approvalDate', Schema.String)
    .addField('issuerCity', Schema.String)
    .addField('issuerIco', Schema.String)
    .addField('issuerStreet', Schema.String)
    .addField('issuerVatId', Schema.String)
    .addField('issuerZip', Schema.String)
    .addField('product', Schema.String)
    .addField('productVersion', Schema.String)
    .addField('transferFormat', Schema.String),
  {
    fields: {
      accountant: TextField,
      approvalDate: TextField,
      issuerCity: TextField,
      issuerIco: TextField,
      issuerStreet: TextField,
      issuerVatId: TextField,
      issuerZip: TextField,
      product: TextField,
      productVersion: TextField,
      transferFormat: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: financeBrowserAtomRuntime,
  },
);

/** The setup as the form shows it. */
const setupDraftOf = (setup: AccountingSetup): SetupDraft => ({
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
type SetupDraft = typeof setupForm.schema.Encoded;

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
  const { t } = useModernI18n();
  const server = () => setupDraftOf(vm.snapshot?.state.accountingSetup ?? {});
  const initial = server();
  const { draft, ready, reset } = useFormDraft(setupForm, initial);
  const form = useFinanceFormSave({
    initial,
    isValid: (value) => setupProblem(value) === undefined,
    onClose,
    reset,
    send: (value) => vm.execute(setupCommandOf(value, vm.actorLabel), 'Nastavení účetního napojení uloženo'),
    server,
    value: draft,
    vm,
  });
  const problem = form.record.status === 'invalid' ? setupProblem(draft) : undefined;
  return (
    <FormRoot
      className="grid grid-cols-1 gap-200 md:grid-cols-2"
      defaultValues={initial}
      form={setupForm}
      translateMessage={t}
    >
      {ready}
      {ALL_FIELDS.map(([key, label]) => {
        const Control = setupForm[key];
        return (
          <Control
            id={`setup-${key}`}
            key={key}
            label={label}
            size="sm"
            type={key === 'approvalDate' ? 'date' : 'text'}
          />
        );
      })}
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
    </FormRoot>
  );
};
