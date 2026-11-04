import { formatPercent, StatCard, statusPresentation } from '@app/admin-ui';
import { readableName } from '@app/admin-ui/visible-text';
import type { OpportunityIndicators } from '../../../../../shared/apis/records.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { TagId } from '@app/tagging/contracts/records';
import { TagFilter } from '@app/tagging/components/tag-controls';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  filterItemsByQuery,
  firstValue,
  formatWholeKc,
  isOpportunityStage,
  opportunityCount,
  opportunityStages,
} from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import { PickerCombobox } from './pipeline-combobox.tsx';
import type { CustomerOption, EmployeeOption, LoadState } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';
const ALL = '__all__';
/** ui-kit's Select label takes no size, so it is set here to match the small search and customer labels. */
const filterLabelProps = { className: 'text-label-sm' } as const;

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

interface PipelineFiltersProps {
  readonly customer: PartyId | '';
  readonly customers: LoadState<readonly CustomerOption[]>;
  readonly employees: readonly EmployeeOption[];
  readonly onCustomer: (customer: PartyId | '') => void;
  readonly onOwner: (owner: EmployeeId | '') => void;
  readonly onSearch: (search: string) => void;
  readonly onStage: (stage: OpportunityStage | '') => void;
  readonly onTag: (tag: TagId | null) => void;
  readonly onUnassignedOnly: (unassigned: boolean) => void;
  readonly owner: EmployeeId | '';
  readonly search: string;
  readonly stage: OpportunityStage | '';
  readonly tag: TagId | null;
  readonly unassignedOnly: boolean;
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

/** Search and filters above the table. Stage, owner and customer go to the server; search, tag and assignment narrow the rows. */
export const PipelineFilters = ({
  customer,
  customers,
  employees,
  onCustomer,
  onOwner,
  onSearch,
  onStage,
  onTag,
  onUnassignedOnly,
  owner,
  search,
  stage,
  tag,
  unassignedOnly,
}: PipelineFiltersProps) => {
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
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const [customerQuery, setCustomerQuery] = useState('');
  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((item) => {
          const label = customerLabel(item, unknownCustomer);
          return (item.archived && item.id !== customer) || label === undefined
            ? []
            : [{ id: item.id, label, value: item.id }];
        })
      : [];
  // The list filters on the typed text here, not inside Combobox, so it always follows the input.
  const shownCustomerItems = filterItemsByQuery(
    customerItems,
    customerQuery,
    customerItems.find((item) => item.value === customer)?.label,
  );

  return (
    <div className="flex flex-wrap items-end gap-150">
      <div className="w-64 min-w-0">
        <FormInput
          id="pipeline-search"
          label={t(`${K}.filters.searchLabel`)}
          name="search"
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t(`${K}.filters.search`)}
          size="sm"
          value={search}
        />
      </div>
      {/* ui-kit's Combobox always sets its label to text-label-md, whatever its size, so the filter labels are set here. */}
      <div className="w-48 [&_label]:text-label-sm">
        <PickerCombobox
          filterBehavior="external"
          items={shownCustomerItems}
          label={t(`${K}.filters.customer`)}
          loading={customers.status === 'loading'}
          loadingMessage={t('sales-pipeline.loading')}
          name="customer"
          noResultsMessage={t(`${K}.create.noCustomerMatch`)}
          onChange={(values) => onCustomer(customerFilterOf(firstValue(values)))}
          // Deleting the typed text clears the filter. Combobox does not fire onChange for it, so it happens here.
          onInputValueChange={(text) => {
            setCustomerQuery(text);
            if (text === '') {
              onCustomer('');
            }
          }}
          placeholder={t(`${K}.filters.allCustomers`)}
          size="sm"
          value={customer === '' ? [] : [customer]}
        />
      </div>
      <div className="w-48">
        <SelectTemplate
          items={stageItems}
          label={t(`${K}.filters.stage`)}
          labelProps={filterLabelProps}
          name="stage"
          onValueChange={({ value: [next] }) => {
            onStage(isOpportunityStage(next) ? next : '');
          }}
          placeholder={t('sales-pipeline.selectPlaceholder')}
          size="sm"
          value={[stage === '' ? ALL : stage]}
        />
      </div>
      <div className="w-48">
        <SelectTemplate
          items={ownerItems}
          label={t(`${K}.filters.owner`)}
          labelProps={filterLabelProps}
          name="owner"
          onValueChange={({ value: [next] }) => onOwner(ownerFilterOf(next))}
          placeholder={t('sales-pipeline.selectPlaceholder')}
          size="sm"
          value={[owner === '' ? ALL : owner]}
        />
      </div>
      <div className="[&_label]:text-label-sm">
        <TagFilter kind="opportunity" label={t(`${K}.filters.tag`)} onChange={onTag} value={tag} />
      </div>
      <div className="pb-100">
        <Switch checked={unassignedOnly} onCheckedChange={onUnassignedOnly}>
          {t(`${K}.filters.unassignedOnly`)}
        </Switch>
      </div>
    </div>
  );
};
