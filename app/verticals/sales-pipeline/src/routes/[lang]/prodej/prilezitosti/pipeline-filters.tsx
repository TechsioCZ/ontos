import { formatPercent, StatCard, statusPresentation } from '@app/admin-ui';
import { readableName } from '@app/admin-ui/visible-text';
import type { OpportunityIndicators } from '../../../../../shared/apis/records.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import { TagIdSchema } from '@app/tagging/contracts/records';
import type { TagId } from '@app/tagging/contracts/records';
import { TagFilter } from '@app/tagging/components/tag-controls';
import {
  ChoiceField,
  ComboboxField,
  FormBuilder,
  FormReact,
  FormRoot,
  SwitchField,
  TextField,
  useAtomSet,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Effect, Option, Schema } from 'effect';
import type { ComponentProps, ReactNode } from 'react';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import {
  filterItemsByQuery,
  formatWholeKc,
  isOpportunityStage,
  opportunityCount,
  opportunityStages,
} from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { PickerFrame, usePicker } from './pipeline-combobox.tsx';
import type { CustomerOption, EmployeeOption, LoadState } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';
const ALL = '__all__';
/** ui-kit's Select label takes no size, so its text is sized here to match the small search and customer labels. */
const filterLabelClassName = 'text-label-sm';

type PartyId = typeof PartyIdSchema.Type;

/** Customer filter value from the Combobox. Anything that does not decode means no filter. */
export const customerFilterOf = (value: string | undefined): PartyId | '' =>
  value === undefined ? '' : Option.getOrElse(Schema.decodeOption(PartyIdSchema)(value), () => '' as const);

/** Owner filter value from the Select. `ALL` and anything that does not decode mean no filter. */
export const ownerFilterOf = (value: string | undefined): EmployeeId | '' =>
  value === undefined || value === ALL
    ? ''
    : Option.getOrElse(Schema.decodeOption(EmployeeIdSchema)(value), () => '' as const);

interface KpiProps {
  readonly hint?: string | undefined;
  readonly label: string;
  readonly value: string;
}

const Kpi = ({ hint, label, value }: KpiProps) =>
  hint === undefined ? <StatCard label={label} value={value} /> : <StatCard hint={hint} label={label} value={value} />;

/**
 * The KPI grid follows the width the page content really has, not the viewport: with the demo guide open the content
 * is about half the screen, and four columns there clip whole-crown amounts. One column on phones, two from 36rem,
 * four only from 64rem of content width.
 */
export const PipelineStatsGrid = ({ children }: { children: ReactNode }) => (
  <div className="@container">
    <div className="grid grid-cols-1 gap-200 @min-[36rem]:grid-cols-2 @min-[64rem]:grid-cols-4">{children}</div>
  </div>
);

export const PipelineStats = ({ indicators }: { indicators: OpportunityIndicators | undefined }) => {
  const { t } = useModernI18n();
  return (
    <PipelineStatsGrid>
      <Kpi
        hint={indicators === undefined ? undefined : opportunityCount(indicators.openCount)}
        label={t(`${K}.stats.open`)}
        value={indicators === undefined ? '—' : formatWholeKc(indicators.openValueMinor)}
      />
      <Kpi
        label={t(`${K}.stats.weighted`)}
        value={indicators === undefined ? '—' : formatWholeKc(indicators.weightedValueMinor)}
      />
      <Kpi
        hint={indicators === undefined ? undefined : opportunityCount(indicators.wonCount)}
        label={t(`${K}.stats.won`)}
        value={indicators === undefined ? '—' : formatWholeKc(indicators.wonValueMinor)}
      />
      <Kpi
        label={t(`${K}.stats.winRate`)}
        value={
          indicators === undefined
            ? '—'
            : Option.match(indicators.winRate, { onNone: () => '—', onSome: formatPercent })
        }
      />
    </PipelineStatsGrid>
  );
};

/** The tagging module's tag filter bound to one form field: the picked tag, or none. */
export const TagChoice: FormReact.FieldComponent<
  TagId | null,
  { readonly kind: ComponentProps<typeof TagFilter>['kind']; readonly label?: string }
> = ({ field, props }) => {
  const onChange = (tagId: TagId | null) => {
    field.onChange(tagId);
    field.onBlur();
  };
  return props.label === undefined ? (
    <TagFilter kind={props.kind} onChange={onChange} value={field.value} />
  ) : (
    <TagFilter kind={props.kind} label={props.label} onChange={onChange} value={field.value} />
  );
};

/** The search and filters above the table: they narrow what the table shows and are never submitted. */
const pipelineFilterForm = FormReact.make(
  FormBuilder.empty
    .addField('customer', Schema.String)
    .addField('owner', Schema.String)
    .addField('search', Schema.String)
    .addField('stage', Schema.String)
    .addField('tag', Schema.OptionFromNullOr(Schema.toType(TagIdSchema)))
    .addField('unassignedOnly', Schema.Boolean),
  {
    fields: {
      customer: ComboboxField,
      owner: ChoiceField,
      search: TextField,
      stage: ChoiceField,
      tag: TagChoice,
      unassignedOnly: SwitchField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** The search and filters as the form holds them. */
export interface PipelineFilterValues {
  readonly customer: string;
  readonly owner: string;
  readonly search: string;
  readonly stage: string;
  readonly tag: TagId | null;
  readonly unassignedOnly: boolean;
}

const customerField = pipelineFilterForm.getFieldAtoms(pipelineFilterForm.fields.customer);

/** No filter at all, or only the customer a link opened the list with. */
const openingFilters = (customer: PartyId | ''): PipelineFilterValues => ({
  customer,
  owner: ALL,
  search: '',
  stage: ALL,
  tag: null,
  unassignedOnly: false,
});

/** The filters as the list applies them. Stage, owner and customer go to the server; the rest narrow the rows. */
/** The filters as the list applies them. */
export interface PipelineViewFilters {
  readonly customerFilter: PartyId | '';
  readonly ownerFilter: EmployeeId | '';
  readonly search: string;
  readonly stageFilter: OpportunityStage | '';
  readonly tagFilter: TagId | null;
  readonly unassignedOnly: boolean;
}

const viewFiltersOf = (values: PipelineFilterValues): PipelineViewFilters => ({
  customerFilter: customerFilterOf(values.customer),
  ownerFilter: ownerFilterOf(values.owner),
  search: values.search,
  stageFilter: isOpportunityStage(values.stage) ? values.stage : '',
  tagFilter: values.tag,
  unassignedOnly: values.unassignedOnly,
});

/**
 * The filters the list applies, from the filter form: until the form is on screen, the list opens with the customer
 * of the link. `clear` drops every filter.
 */
/** The filters of the list, and how to drop them all. */
export interface PipelineFilterState {
  readonly clear: () => void;
  readonly values: PipelineFilterValues;
  readonly view: PipelineViewFilters;
}

export const usePipelineFilters = (initialPartyId: PartyId | undefined): PipelineFilterState => {
  const values = Option.getOrElse(useAtomValue(pipelineFilterForm.values), () => openingFilters(initialPartyId ?? ''));
  const setValues = useAtomSet(pipelineFilterForm.setValues);
  return { clear: () => setValues(openingFilters('')), values, view: viewFiltersOf(values) };
};

interface PipelineFiltersProps {
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: readonly EmployeeOption[];
  /** The filters the list applies now; the form starts from them each time it is shown. */
  readonly filters: PipelineFilterValues;
}

/**
 * A customer's label: its name, else its IČO. A stored name that is an opaque ID is never shown; a customer with no
 * readable label is left out of the list.
 */
const customerLabel = (item: CustomerOption, unknownCustomer: string): string | undefined => {
  const name = item.name === null ? unknownCustomer : readableName(item.name);
  if (name === undefined) {
    return item.companyId === null ? undefined : `IČO ${item.companyId}`;
  }
  return item.companyId === null ? name : `${name} (IČO ${item.companyId})`;
};

const CustomerFilter = ({ customers }: { readonly customers: LoadState<readonly CustomerOption[]> }) => {
  const { t } = useModernI18n();
  const customer = Option.getOrElse(useAtomValue(customerField.value), () => '');
  const setCustomer = useAtomSet(customerField.setValue);
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((item) => {
          const label = customerLabel(item, unknownCustomer);
          return (item.archived && item.id !== customer) || label === undefined
            ? []
            : [{ id: item.id, label, value: item.id }];
        })
      : [];
  const picker = usePicker({
    items: customerItems,
    // Deleting the typed text clears the filter. Combobox does not report that as a change, so it happens here.
    onTextChange: (text) => {
      if (text === '') {
        setCustomer('');
      }
    },
    value: customer,
  });
  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownCustomerItems = filterItemsByQuery(
    customerItems,
    picker.text,
    customerItems.find((item) => item.value === customer)?.label,
  );
  return (
    <PickerFrame picker={picker}>
      <pipelineFilterForm.customer
        {...picker.props}
        filterBehavior="external"
        items={shownCustomerItems}
        label={t(`${K}.filters.customer`)}
        loading={customers.status === 'loading'}
        loadingMessage={t('sales-pipeline.loading')}
        noResultsMessage={t(`${K}.create.noCustomerMatch`)}
        placeholder={t(`${K}.filters.allCustomers`)}
        size="sm"
      />
    </PickerFrame>
  );
};

/** Search and filters above the table. Stage, owner and customer go to the server; search, tag and assignment narrow the rows. */
export const PipelineFilters = ({ customers, employees, filters }: PipelineFiltersProps) => {
  const { t } = useModernI18n();
  const stageItems = [
    { label: t(`${K}.filters.allStages`), value: ALL },
    ...opportunityStages.map((candidate) => ({
      label: statusPresentation('opportunity', candidate).label,
      value: candidate,
    })),
  ];
  const ownerItems = [
    { label: t(`${K}.filters.allOwners`), value: ALL },
    ...employees.flatMap((employee) => {
      const label = readableName(employee.fullName);
      return label === undefined ? [] : [{ label, value: employee.id }];
    }),
  ];

  return (
    <FormRoot
      className="flex flex-wrap items-end gap-150"
      defaultValues={filters}
      form={pipelineFilterForm}
      translateMessage={(message) => t(message, { defaultValue: message })}
    >
      <div className="w-64 min-w-0">
        <pipelineFilterForm.search
          id="pipeline-search"
          label={t(`${K}.filters.searchLabel`)}
          placeholder={t(`${K}.filters.search`)}
          size="sm"
        />
      </div>
      {/* ui-kit's Combobox always sets its label to text-label-md, whatever its size, so the filter labels are set here. */}
      <div className="w-48 [&_label]:text-label-sm">
        <CustomerFilter customers={customers} />
      </div>
      <div className="w-48">
        <pipelineFilterForm.stage
          items={stageItems}
          label={<span className={filterLabelClassName}>{t(`${K}.filters.stage`)}</span>}
          placeholder={t('sales-pipeline.selectPlaceholder')}
        />
      </div>
      <div className="w-48">
        <pipelineFilterForm.owner
          items={ownerItems}
          label={<span className={filterLabelClassName}>{t(`${K}.filters.owner`)}</span>}
          placeholder={t('sales-pipeline.selectPlaceholder')}
        />
      </div>
      <div className="[&_label]:text-label-sm">
        <pipelineFilterForm.tag kind="opportunity" label={t(`${K}.filters.tag`)} />
      </div>
      <div className="pb-100">
        <pipelineFilterForm.unassignedOnly>{t(`${K}.filters.unassignedOnly`)}</pipelineFilterForm.unassignedOnly>
      </div>
    </FormRoot>
  );
};
