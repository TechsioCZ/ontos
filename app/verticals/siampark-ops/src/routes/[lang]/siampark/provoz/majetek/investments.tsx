// S15 plán budoucích investic: description, planned amount, date, priority; actual amount and difference.
// Stored in the `assets` agenda (AssetInvestmentCreate / AssetInvestmentUpdate); every change is in Historie změn.
import { SectionCard, StatCard, StatRow, formatMoney, formatNumber } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../../shared/agendas.ts';
import type {
  AssetsState,
  Investment,
  InvestmentPriority,
  InvestmentStatus,
} from '../../../../../../shared/domain/assets.ts';
import {
  investmentDifference,
  investmentPriorities,
  investmentStatuses,
  isActiveAsset,
} from '../../../../../../shared/domain/assets.ts';
import { ChangeHistory } from '../../../../../ui/change-history.tsx';
import { isoDateLabel, parseCzk } from './assets-model.ts';
import type { Translate } from './assets-model.ts';
import { AreaField, ErrorLine, FormGrid, PanelForm, SelectField, TextField, optional } from './form-kit.tsx';
import { locationItems, owningPropertyId, usePropertyTree } from './property-tree.ts';

const NONE = 'none';
const ALL = 'all';

const priorityVariant = (priority: InvestmentPriority) =>
  priority === 'high' ? ('danger' as const) : priority === 'medium' ? ('warning' as const) : ('outline' as const);
const statusVariant = (status: InvestmentStatus) =>
  status === 'done'
    ? ('success' as const)
    : status === 'in_progress' || status === 'approved'
      ? ('info' as const)
      : ('outline' as const);

const amountInput = (minor: number | undefined) =>
  minor === undefined ? '' : (minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, useGrouping: true });

const signedMoney = (minor: number) => `${minor > 0 ? '+' : ''}${formatMoney(minor)}`;

export const InvestmentForm = ({
  formId,
  investment,
  onSubmit,
  state,
}: {
  readonly formId: string;
  readonly investment?: Investment;
  readonly onSubmit: (command: OpsCommand) => void;
  readonly state: AssetsState;
}) => {
  const { t } = useModernI18n();
  const k = (key: string, options?: Record<string, unknown>) => t(`siampark-ops.assets.${key}`, options);
  const tree = usePropertyTree();
  const [title, setTitle] = useState(investment?.title ?? '');
  const [description, setDescription] = useState(investment?.description ?? '');
  const [planned, setPlanned] = useState(amountInput(investment?.plannedAmountMinor));
  const [plannedDate, setPlannedDate] = useState(investment?.plannedDate ?? '');
  const [priority, setPriority] = useState<InvestmentPriority>(investment?.priority ?? 'medium');
  const [status, setStatus] = useState<InvestmentStatus>(investment?.status ?? 'planned');
  const [actual, setActual] = useState(amountInput(investment?.actualAmountMinor));
  const [actualDate, setActualDate] = useState(investment?.actualDate ?? '');
  const [responsible, setResponsible] = useState(investment?.responsible ?? '');
  const [location, setLocation] = useState(
    investment?.location === undefined ? NONE : `${investment.location.kind}:${investment.location.id}`,
  );
  const [assetId, setAssetId] = useState(investment?.assetId ?? NONE);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = () => {
    if (title.trim() === '' || plannedDate === '' || planned.trim() === '') {
      setError(k('form.required'));
      return;
    }
    const plannedMinor = parseCzk(planned);
    const actualMinor = parseCzk(actual);
    if (plannedMinor === null || plannedMinor === undefined || actualMinor === null) {
      setError(k('form.invalidAmount'));
      return;
    }
    if (status === 'done' && actualMinor === undefined) {
      setError(k('investments.form.actualRequired'));
      return;
    }
    setError(undefined);
    const picked =
      location === NONE ? undefined : (locationItems(tree).find((item) => item.value === location)?.ref ?? investment?.location);
    const propertyId =
      owningPropertyId(tree, picked) ?? (picked === investment?.location ? investment?.propertyId : undefined);
    const fields = {
      plannedAmountMinor: plannedMinor,
      plannedDate,
      priority,
      status,
      title: title.trim(),
      ...optional('description', description),
      ...optional('responsible', responsible),
      ...(actualMinor === undefined ? {} : { actualAmountMinor: actualMinor }),
      ...(actualDate === '' ? {} : { actualDate }),
      ...(picked === undefined ? {} : { location: picked }),
      ...(propertyId === undefined ? {} : { propertyId }),
      ...(assetId === NONE ? {} : { assetId: assetId as Investment['assetId'] & string }),
    };
    onSubmit(
      investment === undefined
        ? { _tag: 'AssetInvestmentCreate', ...fields }
        : { _tag: 'AssetInvestmentUpdate', investmentId: investment.id, ...fields },
    );
  };

  const assets = state.assets.filter((asset) => isActiveAsset(asset) || asset.id === investment?.assetId);
  return (
    <PanelForm id={formId} onSubmit={submit}>
      <ErrorLine message={error} />
      <TextField id="investment-title" label={k('investments.fields.title')} onChange={setTitle} required value={title} />
      <AreaField
        id="investment-description"
        label={k('investments.fields.description')}
        onChange={setDescription}
        value={description}
      />
      <FormGrid>
        <TextField
          id="investment-planned"
          inputMode="decimal"
          label={k('investments.fields.planned')}
          onChange={setPlanned}
          placeholder="250 000"
          required
          value={planned}
        />
        <TextField
          id="investment-planned-date"
          label={k('investments.fields.plannedDate')}
          onChange={setPlannedDate}
          required
          type="date"
          value={plannedDate}
        />
      </FormGrid>
      <FormGrid>
        <SelectField
          label={k('investments.fields.priority')}
          name="investment-priority"
          onChange={(value) => setPriority(investmentPriorities.find((entry) => entry === value) ?? 'medium')}
          options={investmentPriorities.map((entry) => ({ label: k(`investments.priority.${entry}`), value: entry }))}
          value={priority}
        />
        <SelectField
          label={k('investments.fields.status')}
          name="investment-status"
          onChange={(value) => setStatus(investmentStatuses.find((entry) => entry === value) ?? 'planned')}
          options={investmentStatuses.map((entry) => ({ label: k(`investments.status.${entry}`), value: entry }))}
          value={status}
        />
      </FormGrid>
      <FormGrid>
        <TextField
          helpText={k('investments.form.actualHelp')}
          id="investment-actual"
          inputMode="decimal"
          label={k('investments.fields.actual')}
          onChange={setActual}
          value={actual}
        />
        <TextField
          id="investment-actual-date"
          label={k('investments.fields.actualDate')}
          onChange={setActualDate}
          type="date"
          value={actualDate}
        />
      </FormGrid>
      <SelectField
        label={k('investments.fields.location')}
        name="investment-location"
        onChange={(value) => setLocation(value === '' ? NONE : value)}
        options={[
          { label: k('form.noLocation'), value: NONE },
          ...locationItems(tree).map((item) => ({ label: item.label, value: item.value })),
        ]}
        value={location}
      />
      <SelectField
        label={k('investments.fields.asset')}
        name="investment-asset"
        onChange={(value) => setAssetId(value === '' ? NONE : value)}
        options={[
          { label: k('investments.form.noAsset'), value: NONE },
          ...assets.map((asset) => ({ label: `${asset.inventoryNumber} · ${asset.name}`, value: asset.id })),
        ]}
        value={assetId}
      />
      <TextField
        id="investment-responsible"
        label={k('fields.responsible')}
        onChange={setResponsible}
        value={responsible}
      />
      {investment !== undefined && <ChangeHistory entityId={investment.id} refreshKey={investment.updatedAt} />}
    </PanelForm>
  );
};

export const InvestmentPlan = ({
  canWrite,
  k,
  onEdit,
  onNew,
  propertyFilter,
  state,
  today,
}: {
  readonly canWrite: boolean;
  readonly k: Translate;
  readonly onEdit: (investment: Investment) => void;
  readonly onNew: () => void;
  readonly propertyFilter: string;
  readonly state: AssetsState;
  readonly today: string;
}) => {
  const [statusFilter, setStatusFilter] = useState(ALL);
  const [priorityFilter, setPriorityFilter] = useState(ALL);
  const all = (state.investments ?? []).filter(
    (investment) => propertyFilter === ALL || investment.propertyId === propertyFilter,
  );
  const rows = all
    .filter(
      (investment) =>
        (statusFilter === ALL ||
          (statusFilter === 'open' ? investment.status !== 'done' && investment.status !== 'cancelled' : investment.status === statusFilter)) &&
        (priorityFilter === ALL || investment.priority === priorityFilter),
    )
    .toSorted((left, right) => left.plannedDate.localeCompare(right.plannedDate));
  const live = rows.filter((investment) => investment.status !== 'cancelled');
  const plannedTotal = live.reduce((sum, investment) => sum + investment.plannedAmountMinor, 0);
  const withActual = live.filter((investment) => investment.actualAmountMinor !== undefined);
  const actualTotal = withActual.reduce((sum, investment) => sum + (investment.actualAmountMinor ?? 0), 0);
  const plannedOfActual = withActual.reduce((sum, investment) => sum + investment.plannedAmountMinor, 0);
  const thisYear = today.slice(0, 4);
  const yearPlanned = live
    .filter((investment) => investment.plannedDate.startsWith(thisYear))
    .reduce((sum, investment) => sum + investment.plannedAmountMinor, 0);
  const overdue = live.filter(
    (investment) => investment.status !== 'done' && investment.plannedDate < today,
  ).length;
  const filterItems = (items: readonly { label: string; value: string }[]) => items;

  return (
    <div className="flex flex-col gap-200">
      <div className="flex flex-wrap items-start justify-between gap-150">
        <p className="max-w-[48rem] text-fg-secondary text-sm">{k('investments.intro')}</p>
        {canWrite && (
          <Button onClick={onNew} size="sm" variant="primary">
            {k('investments.new')}
          </Button>
        )}
      </div>
      <StatRow>
        <StatCard
          hint={k('investments.stats.count', { count: live.length })}
          label={k('investments.stats.planned')}
          value={formatMoney(plannedTotal)}
        />
        <StatCard
          hint={k('investments.stats.yearHint', { year: thisYear })}
          label={k('investments.stats.year')}
          value={formatMoney(yearPlanned)}
        />
        <StatCard
          hint={k('investments.stats.actualHint', { count: withActual.length, planned: formatMoney(plannedOfActual) })}
          label={k('investments.stats.actual')}
          value={formatMoney(actualTotal)}
        />
        <StatCard
          hint={k('investments.stats.overdueHint', { count: overdue })}
          label={k('investments.stats.difference')}
          value={withActual.length === 0 ? k('notProvided') : signedMoney(actualTotal - plannedOfActual)}
        />
      </StatRow>
      <div className="flex flex-wrap items-end gap-150">
        <div className="w-[12rem]">
          <SelectField
            label={k('investments.fields.status')}
            name="investment-status-filter"
            onChange={(value) => setStatusFilter(value === '' ? ALL : value)}
            options={filterItems([
              { label: k('filters.allStatuses'), value: ALL },
              { label: k('investments.filters.open'), value: 'open' },
              ...investmentStatuses.map((entry) => ({ label: k(`investments.status.${entry}`), value: entry })),
            ])}
            value={statusFilter}
          />
        </div>
        <div className="w-[14rem]">
          <SelectField
            label={k('investments.fields.priority')}
            name="investment-priority-filter"
            onChange={(value) => setPriorityFilter(value === '' ? ALL : value)}
            options={[
              { label: k('investments.filters.allPriorities'), value: ALL },
              ...investmentPriorities.map((entry) => ({ label: k(`investments.priority.${entry}`), value: entry })),
            ]}
            value={priorityFilter}
          />
        </div>
      </div>
      <SectionCard flush>
        {rows.length === 0 ? (
          <p className="p-250 text-fg-secondary text-sm">{k('investments.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k('investments.fields.title')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('investments.fields.priority')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('investments.fields.plannedDate')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.planned')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.actual')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.difference')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('investments.fields.status')}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((investment) => {
                  const difference = investmentDifference(investment);
                  return (
                    <Table.Row
                      className="cursor-pointer hover:bg-surface-hover"
                      key={investment.id}
                      onClick={() => onEdit(investment)}
                    >
                      <Table.Cell>
                        <span className="flex min-w-[14rem] flex-col">
                          <span className="font-medium">{investment.title}</span>
                          <span className="text-fg-secondary text-xs">
                            {investment.location?.label.replace(/ \([^)]*\)$/, '') ?? k('notProvided')}
                          </span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge size="sm" variant={priorityVariant(investment.priority)}>
                          {k(`investments.priority.${investment.priority}`)}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {isoDateLabel(investment.plannedDate)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {formatMoney(investment.plannedAmountMinor)}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-right tabular-nums">
                        {investment.actualAmountMinor === undefined ? '—' : formatMoney(investment.actualAmountMinor)}
                      </Table.Cell>
                      <Table.Cell
                        className={`whitespace-nowrap text-right font-medium tabular-nums ${
                          difference === undefined ? '' : difference > 0 ? 'text-danger' : 'text-success'
                        }`}
                      >
                        {difference === undefined ? '—' : signedMoney(difference)}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge size="sm" variant={statusVariant(investment.status)}>
                          {k(`investments.status.${investment.status}`)}
                        </Badge>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </div>
        )}
      </SectionCard>
      <p className="text-fg-secondary text-xs">{k('investments.footnote', { count: formatNumber(rows.length) })}</p>
    </div>
  );
};
