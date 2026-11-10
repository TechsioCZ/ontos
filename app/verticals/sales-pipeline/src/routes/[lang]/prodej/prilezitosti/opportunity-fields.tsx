// The fields of one opportunity, shared by the create panel and the edit panel, with their validation.
import { CalendarDateSchema } from '@app/shared-contracts';
import { formatNumber } from '@app/admin-ui';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import { OpportunityNoteSchema, OpportunityTitleSchema } from '../../../../../shared/model/opportunity.ts';
import { PartyIdSchema } from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { PipelineCommand } from './pipeline-api.ts';
import { PickerCombobox } from './pipeline-combobox.tsx';
import { LinesEditor } from './pipeline-line-editor.tsx';
import { MAX_LINE_QUANTITY, filterItemsByQuery, firstValue, isSafeOpportunityAmount } from './pipeline-model.ts';
import type { FormDraft } from './opportunity-draft.ts';
import type { CustomerOption, EmployeeOption, LoadState, ProductOption } from './pipeline-references.ts';

export const RESIZE_LABEL_KEY = 'sales-pipeline.sidePanel.resize';

export const SELECT_PLACEHOLDER = 'sales-pipeline.selectPlaceholder';

export const K = 'sales-pipeline.pages.records';
export const NONE = '__none__';
const isValidTitle = Schema.is(OpportunityTitleSchema);
export const isValidNote = Schema.is(OpportunityNoteSchema);

export type CreateCommand = Extract<PipelineCommand, { _tag: 'CreateOpportunity' }>;

export type Translate = ReturnType<typeof useModernI18n>['t'];

export const statusOf = (message: string | undefined) => (message === undefined ? 'default' : 'error');

/** ui-kit's Select label takes no size, so it is set here to match the FormInput and Combobox labels. */
export const formLabelProps = { className: 'text-label-md' } as const;

export interface FormErrors {
  readonly close: string | undefined;
  readonly customer: string | undefined;
  /** A line quantity field holds an invalid value; the line itself shows the message. */
  readonly lines: string | undefined;
  readonly note: string | undefined;
  readonly title: string | undefined;
}

export const formErrors = (draft: FormDraft, t: Translate): FormErrors => {
  let lines: string | undefined;
  if (
    draft.lines.some((entry) => entry.invalidAmount === true) ||
    !isSafeOpportunityAmount(draft.lines.map((entry) => entry.line))
  ) {
    lines = t(`${K}.create.errors.amountRange`);
  } else if (draft.lines.some((entry) => entry.invalidQuantity !== undefined)) {
    lines = t(`${K}.create.errors.quantityRange`, { max: formatNumber(MAX_LINE_QUANTITY) });
  }
  return {
    close: Option.isNone(Schema.decodeOption(CalendarDateSchema)(draft.closeText))
      ? t(`${K}.create.errors.dateRequired`)
      : undefined,
    customer:
      draft.customerId === null || Option.isNone(Schema.decodeOption(PartyIdSchema)(draft.customerId))
        ? t(`${K}.create.errors.customerRequired`)
        : undefined,
    lines,
    note: isValidNote(draft.note.trim()) ? undefined : t(`${K}.create.errors.noteTooLong`),
    title: isValidTitle(draft.title.trim()) ? undefined : t(`${K}.create.errors.titleRequired`),
  };
};

export const hasFormErrors = (errors: FormErrors) => Object.values(errors).some((error) => error !== undefined);

const customerLabel = (customer: CustomerOption, unknownName: string): string => {
  const name = customer.name ?? unknownName;
  return customer.companyId === null ? name : `${name} (IČO ${customer.companyId})`;
};

export interface OpportunityReferences {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: LoadState<readonly EmployeeOption[]>;
  readonly products: LoadState<readonly ProductOption[]>;
}

/** The fields of one opportunity, shared by the create panel and the autosaving edit panel. */
export const OpportunityFields = ({
  customers,
  draft,
  employees,
  isEdit,
  onChange,
  products,
  showErrors,
}: OpportunityReferences & {
  readonly draft: FormDraft;
  readonly isEdit: boolean;
  readonly onChange: (patch: Partial<FormDraft>) => void;
  /** Inline field errors show after the first create attempt and always while editing. */
  readonly showErrors: boolean;
}) => {
  const { t } = useModernI18n();
  const [customerQuery, setCustomerQuery] = useState('');
  const errors = formErrors(draft, t);
  const visible = (message: string | undefined) => (showErrors ? message : undefined);
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const unknownOwner = t(`${K}.unknownOwner`);

  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((customer) =>
          customer.archived && customer.id !== draft.customerId
            ? []
            : [{ id: customer.id, label: customerLabel(customer, unknownCustomer), value: customer.id }],
        )
      : [];

  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownCustomerItems = filterItemsByQuery(
    customerItems,
    customerQuery,
    customerItems.find((item) => item.value === draft.customerId)?.label,
  );

  const ownerItems = [
    { label: t(`${K}.owner.none`), value: NONE },
    ...(employees.status === 'ready'
      ? employees.items.flatMap((employee) =>
          employee.active || employee.id === draft.ownerId
            ? [{ label: employee.fullName || unknownOwner, value: employee.id }]
            : [],
        )
      : []),
  ];

  return (
    <>
      <PickerCombobox
        error={customers.status === 'error' ? t(`${K}.create.customersFailed`) : undefined}
        filterBehavior="external"
        helpText={visible(errors.customer) ?? ''}
        items={shownCustomerItems}
        label={t(`${K}.create.fields.customer`)}
        loading={customers.status === 'loading'}
        loadingMessage={t('sales-pipeline.loading')}
        name="partyId"
        noResultsMessage={t(`${K}.create.noCustomerMatch`)}
        onChange={(values) => {
          const next = firstValue(values);
          onChange({ customerId: next === undefined || next === '' ? null : next });
        }}
        onInputValueChange={setCustomerQuery}
        placeholder={t(`${K}.create.customerPlaceholder`)}
        required
        validateStatus={statusOf(visible(errors.customer))}
        value={draft.customerId === null ? [] : [draft.customerId]}
      />
      <FormInput
        autoComplete="off"
        helpText={visible(errors.title)}
        id="opportunity-title"
        label={t(`${K}.create.fields.title`)}
        name="title"
        onChange={(event) => onChange({ title: event.target.value })}
        required
        validateStatus={statusOf(visible(errors.title))}
        value={draft.title}
      />
      {/* A Select, like the Obchodník filter, so a click anywhere on the field opens the list. */}
      <div className="flex flex-col gap-50">
        <SelectTemplate
          disabled={isEdit}
          items={ownerItems}
          label={t(`${K}.create.fields.assignee`)}
          labelProps={formLabelProps}
          name="ownerEmployeeId"
          onValueChange={({ value: [next] }) => {
            onChange({ ownerId: next === undefined || next === NONE ? null : next });
          }}
          placeholder={t(SELECT_PLACEHOLDER)}
          size="md"
          value={[draft.ownerId ?? NONE]}
        />
        {isEdit && <p className="text-fg-secondary text-xs">{t(`${K}.create.ownerEditHint`)}</p>}
      </div>
      <FormInput
        helpText={visible(errors.close)}
        id="opportunity-close-date"
        label={t(`${K}.create.fields.expectedClose`)}
        name="expectedCloseDate"
        onChange={(event) => onChange({ closeText: event.target.value })}
        required
        type="date"
        validateStatus={statusOf(visible(errors.close))}
        value={draft.closeText}
      />
      <FormTextarea
        autoComplete="off"
        helpText={visible(errors.note)}
        id="opportunity-note"
        label={t(`${K}.create.fields.note`)}
        name="note"
        onChange={(event) => onChange({ note: event.target.value })}
        rows={3}
        validateStatus={statusOf(visible(errors.note))}
        value={draft.note}
      />
      <LinesEditor lines={draft.lines} onChange={(lines) => onChange({ lines })} products={products} />
    </>
  );
};

/** The scrolling form inside a panel. The small inline padding keeps focus rings from being clipped by its edge. */
export const formClassName = '-mx-100 flex min-h-0 flex-1 flex-col gap-200 overflow-y-auto px-100 py-200';
