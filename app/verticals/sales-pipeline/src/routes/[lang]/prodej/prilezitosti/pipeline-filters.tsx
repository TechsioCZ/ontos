import { formatPercent, StatCard, StatRow, statusPresentation } from '@app/admin-ui';
import type { OpportunityIndicators } from '../../../../../shared/apis/records.ts';
import {
  EmployeeIdSchema,
  PartyIdSchema,
} from '../../../../../shared/outbox/sales-pipeline-opportunity-stage-changed-v1.ts';
import type { TagId } from '@app/tagging/contracts/records';
import { TagFilter } from '@app/tagging/components/tag-controls';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { Option, Schema } from 'effect';
import { useState } from 'react';
import {
  filterItemsByQuery,
  firstValue,
  formatWholeKc,
  isOpportunityStage,
  opportunityCount,
  opportunityStages,
} from './pipeline-model.ts';
import type { EmployeeId, OpportunityStage } from './pipeline-model.ts';
import type { CustomerOption, EmployeeOption, LoadState } from './pipeline-references.ts';

const K = 'sales-pipeline.pages.records';
const ALL = '__all__';

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

export const PipelineStats = ({ indicators }: { indicators: OpportunityIndicators | undefined }) => {
  const { t } = useModernI18n();
  return (
    <StatRow>
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
    </StatRow>
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
    ...employees.map((employee) => ({ label: employee.fullName, value: employee.id })),
  ];
  const unknownCustomer = t(`${K}.create.unknownCustomer`);
  const [customerQuery, setCustomerQuery] = useState('');
  const customerItems =
    customers.status === 'ready'
      ? customers.items.flatMap((item) =>
          item.archived && item.id !== customer
            ? []
            : [
                {
                  id: item.id,
                  label:
                    item.companyId === null
                      ? (item.name ?? unknownCustomer)
                      : `${item.name ?? unknownCustomer} (IČO ${item.companyId})`,
                  value: item.id,
                },
              ],
        )
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
      <div className="w-48">
        <Combobox
          clearable
          filterBehavior="external"
          items={shownCustomerItems}
          label={t(`${K}.filters.customer`)}
          loading={customers.status === 'loading'}
          loadingMessage={t('sales-pipeline.loading')}
          name="customer"
          noResultsMessage={t(`${K}.create.noCustomerMatch`)}
          onChange={(values) => onCustomer(customerFilterOf(firstValue(values)))}
          onInputValueChange={setCustomerQuery}
          placeholder={t(`${K}.filters.allCustomers`)}
          size="sm"
          value={customer === '' ? [] : [customer]}
        />
      </div>
      <div className="w-48">
        <SelectTemplate
          items={stageItems}
          label={t(`${K}.filters.stage`)}
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
          name="owner"
          onValueChange={({ value: [next] }) => onOwner(ownerFilterOf(next))}
          placeholder={t('sales-pipeline.selectPlaceholder')}
          size="sm"
          value={[owner === '' ? ALL : owner]}
        />
      </div>
      <div className="w-48">
        <TagFilter kind="opportunity" onChange={onTag} value={tag} />
      </div>
      <div className="pb-100">
        <Switch checked={unassignedOnly} onCheckedChange={onUnassignedOnly}>
          {t(`${K}.filters.unassignedOnly`)}
        </Switch>
      </div>
    </div>
  );
};
