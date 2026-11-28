// S15 plán budoucích investic: description, planned amount, date, priority; actual amount and difference.
// Stored in the `assets` agenda (AssetInvestmentCreate / AssetInvestmentUpdate); every change is in Historie změn.
import { SectionCard, StatCard, StatRow, formatMoney, formatNumber } from '@app/admin-ui';
import {
  ChoiceField,
  FormBuilder,
  FormReact,
  FormRoot,
  TextAreaField,
  TextField,
  useAtomValue,
} from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Option, Schema } from 'effect';
import type { TOptions } from 'i18next';
import { useState } from 'react';
import type { OpsCommand } from '../../../../../shared/agendas.ts';
import type {
  AssetsState,
  Investment,
  InvestmentPriority,
  InvestmentStatus,
} from '../../../../../shared/domain/assets.ts';
import {
  AssetIdSchema,
  investmentDifference,
  investmentPriorities,
  investmentStatuses,
  isActiveAsset,
} from '../../../../../shared/domain/assets.ts';
import { optionalField } from '../../../../../shared/domain/common.ts';
import { ChangeHistory } from '../../../../ui/change-history.tsx';
import { isoDateLabel, parseCzk } from './assets-model.ts';
import type { Translate } from './assets-model.ts';
import { ErrorLine, FormGrid, PanelForm, optional, textArea, textInput, useRequired } from './form-kit.tsx';
import type { AssetSubmit, PanelFormEdit } from './form-kit.tsx';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { useDraftBase } from '../../../../ui/draft-base.ts';
import { locationItems, owningPropertyId, usePropertyTree } from './property-tree.ts';

const NONE = 'none';
const PRIORITY_LABEL = 'investments.fields.priority';
const STATUS_LABEL = 'investments.fields.status';
const ALL = 'all';

const priorityVariants = { high: 'danger', low: 'neutral', medium: 'warning' } as const;
const priorityVariant = (priority: InvestmentPriority) => priorityVariants[priority];
const statusVariants = {
  approved: 'info',
  cancelled: 'neutral',
  done: 'success',
  in_progress: 'info',
  planned: 'neutral',
} as const;
const statusVariant = (status: InvestmentStatus) => statusVariants[status];

const differenceClass = (difference: number | undefined): string => {
  if (difference === undefined) {
    return '';
  }
  return difference > 0 ? 'text-danger' : 'text-success';
};

const amountInput = (minor: number | undefined) =>
  minor === undefined ? '' : (minor / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2, useGrouping: true });

const signedMoney = (minor: number) => `${minor > 0 ? '+' : ''}${formatMoney(minor)}`;

interface InvestmentFormProps {
  readonly investment?: Investment | undefined;
  readonly onSubmit: AssetSubmit;
  readonly state: AssetsState;
}

/** One investment's values; Uložit sends them through the panel's form save, so Enter sends nothing. */
const investmentForm = FormReact.make(
  FormBuilder.empty
    .addField('actual', Schema.String)
    .addField('actualDate', Schema.String)
    .addField('assetId', Schema.String)
    .addField('description', Schema.String)
    .addField('location', Schema.String)
    .addField('planned', Schema.String)
    .addField('plannedDate', Schema.String)
    .addField('priority', Schema.String)
    .addField('responsible', Schema.String)
    .addField('status', Schema.String)
    .addField('title', Schema.String),
  {
    fields: {
      actual: TextField,
      actualDate: TextField,
      assetId: ChoiceField,
      description: TextAreaField,
      location: ChoiceField,
      planned: TextField,
      plannedDate: TextField,
      priority: ChoiceField,
      responsible: TextField,
      status: ChoiceField,
      title: TextField,
    },
    onSubmit: () => Effect.void,
    runtime: browserAtomRuntime,
  },
);

/** A new investment: planned, of medium priority, with nothing filled in. */
const newInvestmentValues = {
  actual: '',
  actualDate: '',
  assetId: NONE,
  description: '',
  location: NONE,
  planned: '',
  plannedDate: '',
  priority: 'medium',
  responsible: '',
  status: 'planned',
  title: '',
};

const investmentValuesOf = (investment: Investment | undefined): typeof investmentForm.schema.Encoded =>
  investment === undefined
    ? newInvestmentValues
    : {
        actual: amountInput(investment.actualAmountMinor),
        actualDate: investment.actualDate ?? '',
        assetId: investment.assetId ?? NONE,
        description: investment.description ?? '',
        location: investment.location === undefined ? NONE : `${investment.location.kind}:${investment.location.id}`,
        planned: amountInput(investment.plannedAmountMinor),
        plannedDate: investment.plannedDate,
        priority: investment.priority,
        responsible: investment.responsible ?? '',
        status: investment.status,
        title: investment.title,
      };

type InvestmentValues = typeof investmentForm.schema.Encoded;

/** The picks of the form as the command takes them; an empty pick is the default one. */
const investmentChoicesOf = (values: InvestmentValues) => ({
  assetId: Option.getOrElse(
    Schema.decodeOption(AssetIdSchema)(values.assetId === '' ? NONE : values.assetId),
    (): typeof NONE => NONE,
  ),
  location: values.location === '' ? NONE : values.location,
  priority: investmentPriorities.find((entry) => entry === values.priority) ?? 'medium',
  status: investmentStatuses.find((entry) => entry === values.status) ?? 'planned',
});
type InvestmentChoices = ReturnType<typeof investmentChoicesOf>;

/** The typed amounts, or the message key of what is missing or wrong. */
const investmentAmountsOf = (
  { actual, planned, plannedDate, title }: InvestmentValues,
  status: InvestmentStatus,
): { readonly problem: string } | { readonly actualMinor: number | undefined; readonly plannedMinor: number } => {
  if (title.trim() === '' || plannedDate === '' || planned.trim() === '') {
    return { problem: 'form.required' };
  }
  const plannedMinor = parseCzk(planned);
  const actualMinor = parseCzk(actual);
  if (plannedMinor === null || plannedMinor === undefined || actualMinor === null) {
    return { problem: 'form.invalidAmount' };
  }
  if (status === 'done' && actualMinor === undefined) {
    return { problem: 'investments.form.actualRequired' };
  }
  return { actualMinor, plannedMinor };
};

/** The fields a create and an update of an investment both carry. */
const investmentFieldsOf = (
  { actualDate, description, plannedDate, responsible, title }: InvestmentValues,
  { assetId, priority, status }: InvestmentChoices,
  { actualMinor, plannedMinor }: { readonly actualMinor: number | undefined; readonly plannedMinor: number },
  place: { readonly picked: Investment['location']; readonly propertyId: Investment['propertyId'] },
) => ({
  plannedAmountMinor: plannedMinor,
  plannedDate,
  priority,
  status,
  title: title.trim(),
  ...optional('description', description),
  ...optional('responsible', responsible),
  ...optionalField('actualAmountMinor', actualMinor),
  ...optionalField('actualDate', actualDate === '' ? undefined : actualDate),
  ...optionalField('location', place.picked),
  ...optionalField('propertyId', place.propertyId),
  ...optionalField('assetId', assetId === NONE ? undefined : assetId),
});

const InvestmentFields = ({
  edit,
  investment,
  onSubmit,
  state,
}: InvestmentFormProps & { readonly edit: PanelFormEdit | undefined }) => {
  const { t } = useModernI18n();
  const k = (key: string, options?: TOptions) => t(`facility-operations.assets.${key}`, options);
  const required = useRequired();
  const tree = usePropertyTree();
  const [error, setError] = useState<string | undefined>();

  const command = (values: InvestmentValues): OpsCommand | undefined => {
    const choices = investmentChoicesOf(values);
    const amounts = investmentAmountsOf(values, choices.status);
    if ('problem' in amounts) {
      setError(k(amounts.problem));
      return undefined;
    }
    setError(undefined);
    const picked =
      choices.location === NONE
        ? undefined
        : (locationItems(tree).find((item) => item.value === choices.location)?.ref ?? investment?.location);
    const propertyId =
      owningPropertyId(tree, picked) ?? (picked === investment?.location ? investment?.propertyId : undefined);
    const fields = investmentFieldsOf(values, choices, amounts, { picked, propertyId });
    return investment === undefined
      ? { _tag: 'AssetInvestmentCreate', ...fields }
      : { _tag: 'AssetInvestmentUpdate', investmentId: investment.id, ...fields };
  };

  const assets = state.assets.filter((asset) => isActiveAsset(asset) || asset.id === investment?.assetId);
  return (
    <PanelForm
      command={command}
      edit={edit}
      error={error}
      form={investmentForm}
      onSubmit={onSubmit}
      opened={investmentValuesOf(investment)}
    >
      <ErrorLine message={error} />
      <investmentForm.title {...textInput} {...required} id="investment-title" label={k('investments.fields.title')} />
      <investmentForm.description
        {...textArea}
        id="investment-description"
        label={k('investments.fields.description')}
      />
      <FormGrid>
        <investmentForm.planned
          {...textInput}
          {...required}
          id="investment-planned"
          inputMode="decimal"
          label={k('investments.fields.planned')}
          placeholder="250 000"
        />
        <investmentForm.plannedDate
          {...textInput}
          {...required}
          id="investment-planned-date"
          label={k('investments.fields.plannedDate')}
          type="date"
        />
      </FormGrid>
      <FormGrid>
        <investmentForm.priority
          items={investmentPriorities.map((entry) => ({ label: k(`investments.priority.${entry}`), value: entry }))}
          label={k(PRIORITY_LABEL)}
        />
        <investmentForm.status
          items={investmentStatuses.map((entry) => ({ label: k(`investments.status.${entry}`), value: entry }))}
          label={k(STATUS_LABEL)}
        />
      </FormGrid>
      <FormGrid>
        <investmentForm.actual
          {...textInput}
          helpText={k('investments.form.actualHelp')}
          id="investment-actual"
          inputMode="decimal"
          label={k('investments.fields.actual')}
        />
        <investmentForm.actualDate
          {...textInput}
          id="investment-actual-date"
          label={k('investments.fields.actualDate')}
          type="date"
        />
      </FormGrid>
      <investmentForm.location
        items={[
          { label: k('form.noLocation'), value: NONE },
          ...locationItems(tree).map((item) => ({ label: item.label, value: item.value })),
        ]}
        label={k('investments.fields.location')}
      />
      <investmentForm.assetId
        items={[
          { label: k('investments.form.noAsset'), value: NONE },
          ...assets.map((asset) => ({ label: `${asset.inventoryNumber} · ${asset.name}`, value: asset.id })),
        ]}
        label={k('investments.fields.asset')}
      />
      <investmentForm.responsible {...textInput} id="investment-responsible" label={k('fields.responsible')} />
      {investment !== undefined && <ChangeHistory entityId={investment.id} refreshKey={investment.updatedAt} />}
    </PanelForm>
  );
};

/**
 * Create or edit one investment plan item; Uložit sends it. An edit saves against the read its draft came from, so
 * someone else's newer change is refused as a conflict, and "Načíst aktuální verzi" opens the latest version.
 */
export const InvestmentForm = ({ investment, onSubmit, state }: InvestmentFormProps) => {
  const current =
    investment === undefined
      ? undefined
      : ((state.investments ?? []).find((entry) => entry.id === investment.id) ?? investment);
  const base = useDraftBase(current, onSubmit.run);
  const [opened, setOpened] = useState(current);
  const [generation, setGeneration] = useState(0);
  const edit =
    current === undefined
      ? undefined
      : {
          onReloadLatest: () => {
            base.rebase();
            setOpened(current);
            setGeneration((value) => value + 1);
          },
          run: base.run,
        };
  return <InvestmentFields edit={edit} investment={opened} key={generation} onSubmit={onSubmit} state={state} />;
};

/** The filters over the investment plan; they act as they change, so Enter sends nothing. */
const investmentFilterForm = FormReact.make(
  FormBuilder.empty.addField('priority', Schema.String).addField('status', Schema.String),
  { fields: { priority: ChoiceField, status: ChoiceField }, onSubmit: () => Effect.void, runtime: browserAtomRuntime },
);
const noInvestmentFilters = { priority: ALL, status: ALL };

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
  const { t } = useModernI18n();
  const filters = Option.getOrElse(useAtomValue(investmentFilterForm.values), () => noInvestmentFilters);
  const statusFilter = filters.status === '' ? ALL : filters.status;
  const priorityFilter = filters.priority === '' ? ALL : filters.priority;
  const all = (state.investments ?? []).filter(
    (investment) => propertyFilter === ALL || investment.propertyId === propertyFilter,
  );
  const rows = all
    .filter(
      (investment) =>
        (statusFilter === ALL ||
          (statusFilter === 'open'
            ? investment.status !== 'done' && investment.status !== 'cancelled'
            : investment.status === statusFilter)) &&
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
  const overdue = live.filter((investment) => investment.status !== 'done' && investment.plannedDate < today).length;

  return (
    <div className="flex flex-col gap-200">
      <div className="flex flex-wrap items-start justify-between gap-150">
        <p className="max-w-[48rem] text-fg-secondary text-sm">{k('investments.intro')}</p>
        {canWrite && (
          <Button onClick={onNew} severity="primary" size="sm">
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
      <FormRoot
        className="flex flex-wrap items-end gap-150"
        defaultValues={noInvestmentFilters}
        form={investmentFilterForm}
        translateMessage={(message) => t(message)}
      >
        <div className="w-48">
          <investmentFilterForm.status
            items={[
              { label: k('filters.allStatuses'), value: ALL },
              { label: k('investments.filters.open'), value: 'open' },
              ...investmentStatuses.map((entry) => ({ label: k(`investments.status.${entry}`), value: entry })),
            ]}
            label={k(STATUS_LABEL)}
          />
        </div>
        <div className="w-56">
          <investmentFilterForm.priority
            items={[
              { label: k('investments.filters.allPriorities'), value: ALL },
              ...investmentPriorities.map((entry) => ({ label: k(`investments.priority.${entry}`), value: entry })),
            ]}
            label={k(PRIORITY_LABEL)}
          />
        </div>
      </FormRoot>
      <SectionCard flush>
        {rows.length === 0 ? (
          <p className="p-250 text-fg-secondary text-sm">{k('investments.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{k('investments.fields.title')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k(PRIORITY_LABEL)}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k('investments.fields.plannedDate')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.planned')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.actual')}</Table.ColumnHeader>
                  <Table.ColumnHeader className="text-right">{k('investments.fields.difference')}</Table.ColumnHeader>
                  <Table.ColumnHeader>{k(STATUS_LABEL)}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((investment) => {
                  const difference = investmentDifference(investment);
                  return (
                    <Table.Row
                      className="cursor-pointer hover:bg-fill-hover"
                      key={investment.id}
                      onClick={() => onEdit(investment)}
                    >
                      <Table.Cell>
                        <span className="flex min-w-56 flex-col">
                          <span className="font-medium">{investment.title}</span>
                          <span className="text-fg-secondary text-xs">
                            {investment.location?.label.replace(/ \([^)]*\)$/u, '') ?? k('notProvided')}
                          </span>
                        </span>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge severity={priorityVariant(investment.priority)} size="sm">
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
                        className={`whitespace-nowrap text-right font-medium tabular-nums ${differenceClass(
                          difference,
                        )}`}
                      >
                        {difference === undefined ? '—' : signedMoney(difference)}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge severity={statusVariant(investment.status)} size="sm">
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
      <p className="text-fg-secondary text-xs">
        {k('investments.footnote', { replace: { count: formatNumber(rows.length) } })}
      </p>
    </div>
  );
};
