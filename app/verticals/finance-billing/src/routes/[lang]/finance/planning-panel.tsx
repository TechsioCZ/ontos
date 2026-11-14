import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { financeBrowserRuntime } from '../../../runtime/browser.ts';
import { FinanceTableScroll } from './finance-table-scroll.tsx';
import {
  dialogCloseLabel,
  EmptyState,
  formatDate,
  formatDateTime,
  formatMoney,
  SectionCard,
  StatCard,
  StatRow,
} from '@app/admin-ui';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { StatusText } from '@techsio/ui-kit/atoms/status-text';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { Dialog } from '@techsio/ui-kit/molecules/dialog';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@app/admin-ui/select-template';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { BudgetLine, Invoice } from '../../../../shared/apis/records.ts';
import {
  addMonths,
  budgetActualMinor,
  budgetVariance,
  cashFlowForecast,
  invoiceActualMinor,
  monthOf,
} from '../../../../shared/domain/finance-planning.ts';
import { monthLabel } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { editBudgetDraft, newBudgetDraft } from './budget-draft.ts';
import type { BudgetDraft } from './budget-draft.ts';
import { objectSummary } from './object-fields.tsx';
import { BudgetEditor, OpeningBalanceEditor } from './planning-forms.tsx';
import { PlanItemsSection } from './plan-items-section.tsx';

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));
const wholeKc = (minor: number) => formatMoney(Math.round(minor / 100) * 100);
const axisFormat = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 3, notation: 'compact' });
const percentFormat = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 });
const axisKc = (value: number) => `${axisFormat.format(value)} Kč`;
const percent = (value: number) => `${value > 0 ? '+' : ''}${percentFormat.format(value * 100)} %`;

const actualFromInvoicesLabel = (budget: BudgetLine, invoices: readonly Invoice[]) =>
  `z faktur (${formatMoney(invoiceActualMinor(budget, invoices))})`;
const budgetRowLabel = (budget: BudgetLine, vm: FinanceViewModel) => {
  const summary = objectSummary(vm.objects, budget);
  const suffix = summary === undefined ? '' : ` · ${summary}`;
  return `${budget.category} (${budget.kind === 'COST' ? 'výdaj' : 'příjem'})${suffix}`;
};

/** Simple accessible two-bar comparison per category (plan vs. actual), drawn in markup. */
const PlanActualBars = ({
  rows,
}: {
  readonly rows: readonly {
    readonly actual: number;
    readonly label: string;
    readonly over: boolean;
    readonly planned: number;
  }[];
}) => {
  const { t } = useModernI18n();
  const max = Math.max(1, ...rows.flatMap((row) => [row.actual, row.planned]));
  return (
    <ul aria-label={t('finance-billing.financeUi.planning.categoryComparison')} className="flex flex-col gap-150">
      {rows.map((row) => (
        <li className="grid grid-cols-1 items-center gap-100 text-sm md:grid-cols-[10rem_1fr]" key={row.label}>
          <span className="truncate">{row.label}</span>
          <span className="flex min-w-0 flex-col gap-50">
            <span className="grid items-center gap-100" style={{ gridTemplateColumns: 'minmax(0, 1fr) 10rem' }}>
              <span className="min-w-0">
                <span className="sr-only">{`Plán: ${formatMoney(row.planned)}`}</span>
                <span
                  className="block h-3 rounded-sm"
                  style={{
                    background: 'var(--color-fg-secondary)',
                    opacity: 0.35,
                    width: `${Math.max(0, (row.planned / max) * 100)}%`,
                  }}
                />
              </span>
              <span className="whitespace-nowrap text-fg-secondary text-xs tabular-nums">
                plán {wholeKc(row.planned)}
              </span>
            </span>
            <span className="grid items-center gap-100" style={{ gridTemplateColumns: 'minmax(0, 1fr) 10rem' }}>
              <span className="min-w-0">
                <span className="sr-only">{`Skutečnost: ${formatMoney(row.actual)}`}</span>
                <span
                  className="block h-3 rounded-sm"
                  style={{
                    background: row.over ? 'var(--color-danger)' : 'var(--color-success)',
                    width: `${Math.max(0, (row.actual / max) * 100)}%`,
                  }}
                />
              </span>
              <span className="whitespace-nowrap text-xs tabular-nums">skutečnost {wholeKc(row.actual)}</span>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
};

const usePlanningPanel = (vm: FinanceViewModel) => {
  const state = vm.snapshot?.state;
  const businessDate = vm.referenceDate === '' ? '2026-10-20' : vm.referenceDate;
  const currentMonth = monthOf(businessDate);
  const opening = state?.cashFlowOpening;
  const months = state === undefined ? [] : cashFlowForecast(state, businessDate);
  const [budgetMonth, setBudgetMonth] = useState(currentMonth);
  const [draft, setDraft] = useState<BudgetDraft>();
  const [deleteTarget, setDeleteTarget] = useState<BudgetLine>();
  const [openingOpen, setOpeningOpen] = useState(false);
  const invoices = state?.invoices ?? [];
  const [objectFilter, setObjectFilter] = useState('ALL');
  const budgets = (state?.budgets ?? []).filter(
    (budget) =>
      budget.period === budgetMonth &&
      (objectFilter === 'ALL' ||
        (objectFilter === 'COMPANY' && budget.propertyRef === undefined && budget.costCenter === undefined) ||
        (objectFilter.startsWith('property:') && budget.propertyRef?.resourceId === objectFilter.slice(9)) ||
        (objectFilter.startsWith('cc:') && budget.costCenter === objectFilter.slice(3))),
  );
  const objectFilterItems = [
    { label: 'Všechny objekty a střediska', value: 'ALL' },
    { label: 'Celá firma (bez objektu)', value: 'COMPANY' },
    ...vm.objects.properties.map((entry) => ({ label: entry.label, value: `property:${entry.ref.resourceId}` })),
    ...[
      ...new Set(
        (state?.budgets ?? []).flatMap((budget) => (budget.costCenter === undefined ? [] : [budget.costCenter])),
      ),
    ]
      .toSorted((left, right) => left.localeCompare(right, 'cs'))
      .map((center) => ({ label: `Středisko ${center}`, value: `cc:${center}` })),
  ];
  const budgetRows = budgets
    .map((budget) => ({ actual: budgetActualMinor(budget, invoices), budget }))
    .toSorted(
      (left, right) =>
        left.budget.kind.localeCompare(right.budget.kind) ||
        left.budget.category.localeCompare(right.budget.category, 'cs'),
    );
  const last = months.at(-1);
  const totals = { expected: 0, paid: 0 };
  for (const month of months) {
    totals.expected += month.expectedInMinor - month.expectedOutMinor;
    totals.paid += month.paidInMinor - month.paidOutMinor;
  }
  const budgetMonths = Array.from({ length: 7 }, (_, index) => addMonths(currentMonth, index - 3));

  // Series are chart-text keys (financeUi.planning.chart.*); CashFlowForecast translates them and the month ticks.
  const flowData = months.flatMap((month) => [
    { month: month.month, series: 'incomePaid', value: month.paidInMinor / 100 },
    { month: month.month, series: 'incomeExpected', value: (month.expectedInMinor + month.planInMinor) / 100 },
    { month: month.month, series: 'expensePaid', value: -month.paidOutMinor / 100 },
    { month: month.month, series: 'expenseExpected', value: -(month.expectedOutMinor + month.planOutMinor) / 100 },
  ]);
  const balanceData = months.flatMap((month) =>
    month.forecastBalanceMinor === undefined ? [] : [{ month: month.month, value: month.forecastBalanceMinor / 100 }],
  );

  return {
    balanceData,
    budgetMonth,
    budgetMonths,
    budgetRows,
    budgets,
    businessDate,
    currentMonth,
    deleteTarget,
    draft,
    flowData,
    invoices,
    last,
    months,
    objectFilter,
    objectFilterItems,
    opening,
    openingOpen,
    setBudgetMonth,
    setDeleteTarget,
    setDraft,
    setObjectFilter,
    setOpeningOpen,
    state,
    totals,
    vm,
  };
};

const chartKey = 'finance-billing.financeUi.planning.chart';
const monthFormats = (locale: string) => ({
  long: new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC', year: 'numeric' }),
  short: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
});
const csMonthFormats = monthFormats('cs-CZ');
const enMonthFormats = monthFormats('en-GB');
const monthFormatsFor = (language: string) => (language === 'en' ? enMonthFormats : csMonthFormats);
const monthEpochMillis = (month: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(`${month}-01T00:00:00Z`));
/** Expenses are drawn below zero; the tooltip names the series and shows whole crowns (as the table) without a minus sign. */
const tooltipKc = (value: number) => formatMoney(Math.round(Math.abs(value)) * 100);

const CashFlowForecast = (model: ReturnType<typeof usePlanningPanel>) => {
  const { language, t } = useModernI18n();
  const { balanceData, currentMonth, flowData, months, opening, setOpeningOpen, vm } = model;
  const formats = monthFormatsFor(language);
  const tick = (month: string) => `${formats.short.format(monthEpochMillis(month))} ${month.slice(2, 4)}`;
  const monthTitles = new Map(
    months.map((month) => [tick(month.month), formats.long.format(monthEpochMillis(month.month))]),
  );
  const monthTitle = (label: string | number | Date) => monthTitles.get(String(label)) ?? String(label);
  const flowRows = flowData.map((row) => ({
    label: tick(row.month),
    series: t(`${chartKey}.${row.series}`),
    value: row.value,
  }));
  const balanceRows = balanceData.map((row) => ({ label: tick(row.month), value: row.value }));
  return (
    <SectionCard
      actions={
        vm.canWrite ? (
          <Button
            icon="icon-[mdi--bank-check]"
            onClick={() => setOpeningOpen(true)}
            size="sm"
            theme="outlined"
            variant="secondary"
          >
            {opening === undefined ? 'Zadat počáteční stav' : 'Změnit počáteční stav'}
          </Button>
        ) : undefined
      }
      title={t('finance-billing.financeUi.planning.monthlyCashFlow')}
    >
      <StatusText showIcon size="sm" status="default">
        Odhad = ručně potvrzený počáteční stav + uhrazené a očekávané příjmy − výdaje. Nejde o bankovní zůstatek.
        Uhrazená faktura se v očekávaných už nepočítá; rozpočet se započítá jen v části, kterou ještě nepokryly doklady,
        a položky finančního plánu podle své pravděpodobnosti.
        {opening !== undefined &&
          ` Počáteční stav k ${formatDate(opening.openingDate)} potvrdil(a) ${opening.actorLabel ?? 'uživatel'} ${at(opening.confirmedAt)}.`}
      </StatusText>
      {months.length > 0 && (
        <div className="grid grid-cols-1 gap-250">
          <div className="flex flex-col gap-100">
            <span className="font-medium text-sm">{t(`${chartKey}.flowTitle`)}</span>
            <Chart
              ariaLabel={t(`${chartKey}.flowAria`)}
              data={flowRows}
              dataTableLabel={t('finance-billing.chartData.toggle')}
              formatCategory={monthTitle}
              formatTooltipValue={tooltipKc}
              formatValue={axisKc}
              height={260}
              legendLabel={t('finance-billing.chartData.series')}
              locale={language}
              series="series"
              stacked
              type="bar"
              x="label"
              xLabel={t('finance-billing.chartData.category')}
              y="value"
              yLabel={t('finance-billing.chartData.value')}
            />
          </div>
          <div className="flex flex-col gap-100">
            <span className="font-medium text-sm">
              {t(`${chartKey}.balanceTitle`)}{' '}
              <Badge size="sm" variant="warning">
                {t(`${chartKey}.estimateBadge`)}
              </Badge>
            </span>
            {balanceRows.length === 0 ? (
              <EmptyState
                description={t(`${chartKey}.openingHint`)}
                title={t('finance-billing.financeUi.planning.noOpeningBalance')}
              />
            ) : (
              <Chart
                ariaLabel={t(`${chartKey}.balanceAria`)}
                data={balanceRows}
                dataTableLabel={t('finance-billing.chartData.toggle')}
                formatCategory={monthTitle}
                formatTooltipValue={(value) => formatMoney(Math.round(value) * 100)}
                formatValue={axisKc}
                height={260}
                locale={language}
                points
                type="line"
                valueLabel={t(`${chartKey}.balanceTitle`)}
                x="label"
                xLabel={t('finance-billing.chartData.category')}
                y="value"
                yLabel={t(`${chartKey}.balanceTitle`)}
              />
            )}
          </div>
        </div>
      )}
      <FinanceTableScroll label={t('finance-billing.financeUi.planning.monthlyCashFlow')}>
        <Table size="sm" variant="line">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Měsíc</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Příjmy uhrazené</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Výdaje uhrazené</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Očekávané příjmy</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Očekávané výdaje</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Plán (rozpočet + fin. plán)</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Odhad zůstatku</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {months.map((month) => (
              <Table.Row key={month.month}>
                <Table.Cell className={month.month === currentMonth ? 'font-semibold' : ''}>
                  {monthLabel(month.month)}
                  {month.month === currentMonth && (
                    <Badge className="ml-100" size="sm" variant="primary">
                      tento měsíc
                    </Badge>
                  )}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {wholeKc(month.paidInMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums">
                  {wholeKc(month.paidOutMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums text-fg-secondary">
                  {wholeKc(month.expectedInMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums text-fg-secondary">
                  {wholeKc(month.expectedOutMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="tabular-nums text-fg-secondary">
                  {wholeKc(month.planInMinor - month.planOutMinor)}
                </Table.Cell>
                <Table.Cell align="end" className="font-medium tabular-nums">
                  {month.forecastBalanceMinor === undefined ? '—' : wholeKc(month.forecastBalanceMinor)}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </FinanceTableScroll>
    </SectionCard>
  );
};

const BudgetComparison = (model: ReturnType<typeof usePlanningPanel>) => {
  const { t } = useModernI18n();
  const {
    budgetMonth,
    budgetMonths,
    budgetRows,
    invoices,
    objectFilter,
    objectFilterItems,
    setBudgetMonth,
    setDeleteTarget,
    setDraft,
    setObjectFilter,
    vm,
  } = model;
  return (
    <SectionCard
      actions={
        <>
          <div className="w-56">
            <SelectTemplate
              aria-label={t('finance-billing.financeUi.planning.budgetObject')}
              items={objectFilterItems.map((entry) => ({
                displayValue: entry.label,
                label: entry.label,
                value: entry.value,
              }))}
              onValueChange={({ value }) => {
                const [next] = value;
                if (next !== undefined) {
                  setObjectFilter(next);
                }
              }}
              size="sm"
              value={[objectFilter]}
            />
          </div>
          <div className="w-44">
            <SelectTemplate
              aria-label={t('finance-billing.financeUi.planning.budgetMonth')}
              items={budgetMonths.map((month) => ({
                displayValue: monthLabel(month),
                label: monthLabel(month),
                value: month,
              }))}
              onValueChange={({ value }) => {
                const [next] = value;
                if (next !== undefined) {
                  setBudgetMonth(next);
                }
              }}
              size="sm"
              value={[budgetMonth]}
            />
          </div>
          {vm.canWrite && (
            <Button icon="icon-[mdi--plus]" onClick={() => setDraft(newBudgetDraft())} size="sm" variant="primary">
              Přidat položku
            </Button>
          )}
        </>
      }
      title={t('finance-billing.financeUi.planning.budgetComparison')}
    >
      <p className="text-fg-secondary text-sm">
        Rozpočet lze vést za celou firmu, za nemovitost či jednotku, nebo za středisko. Skutečnost = ručně zadaná
        částka, jinak součet potvrzených faktur dané kategorie v měsíci přiřazených ke stejnému objektu či středisku.
        Procentní odchylka se počítá jen u nenulového plánu.
      </p>
      {budgetRows.length === 0 ? (
        <EmptyState
          description={`Pro ${monthLabel(budgetMonth)} zatím není rozpočet.`}
          title={t('finance-billing.financeUi.planning.noBudget')}
        />
      ) : (
        <>
          <PlanActualBars
            rows={budgetRows.map(({ actual, budget }) => ({
              actual,
              label: budgetRowLabel(budget, vm),
              over: budget.kind === 'COST' ? actual > budget.plannedMinor : actual < budget.plannedMinor,
              planned: budget.plannedMinor,
            }))}
          />
          <FinanceTableScroll label={t('finance-billing.financeUi.planning.budgetComparison')}>
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Kategorie</Table.ColumnHeader>
                  <Table.ColumnHeader>Objekt / středisko</Table.ColumnHeader>
                  <Table.ColumnHeader>Typ</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Plán</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Skutečnost</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Rozdíl</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">Odchylka</Table.ColumnHeader>
                  <Table.ColumnHeader>Vysvětlení</Table.ColumnHeader>
                  <Table.ColumnHeader align="end" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {budgetRows.map(({ actual, budget }) => {
                  const variance = budgetVariance(budget.plannedMinor, actual);
                  const over = budget.kind === 'COST' ? variance.differenceMinor > 0 : variance.differenceMinor < 0;
                  return (
                    <Table.Row key={budget.id}>
                      <Table.Cell className="font-medium">{budget.category}</Table.Cell>
                      <Table.Cell className="max-w-56 text-sm">
                        {objectSummary(vm.objects, budget) ?? 'Celá firma'}
                      </Table.Cell>
                      <Table.Cell>
                        <Badge size="sm" variant={budget.kind === 'COST' ? 'warning' : 'success'}>
                          {budget.kind === 'COST' ? 'Výdaj' : 'Příjem'}
                        </Badge>
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {formatMoney(budget.plannedMinor)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        <span className="flex flex-col items-end">
                          {formatMoney(actual)}
                          <span className="text-fg-secondary text-xs">
                            {budget.actualManualMinor === undefined
                              ? actualFromInvoicesLabel(budget, invoices)
                              : 'zadáno ručně'}
                          </span>
                        </span>
                      </Table.Cell>
                      <Table.Cell
                        align="end"
                        className="tabular-nums"
                        style={over ? { color: 'var(--color-danger)' } : undefined}
                      >
                        {formatMoney(variance.differenceMinor)}
                      </Table.Cell>
                      <Table.Cell align="end" className="tabular-nums">
                        {variance.percent === undefined ? (
                          <span className="text-fg-secondary text-xs">nelze vyhodnotit</span>
                        ) : (
                          <Badge size="sm" variant={over ? 'danger' : 'success'}>
                            {percent(variance.percent)}
                          </Badge>
                        )}
                      </Table.Cell>
                      <Table.Cell className="max-w-56 text-sm">{budget.explanation ?? '—'}</Table.Cell>
                      <Table.Cell align="end">
                        {vm.canWrite && (
                          <span className="flex justify-end gap-50">
                            <Button
                              aria-label={t('finance-billing.financeUi.common.edit')}
                              icon="icon-[mdi--pencil-outline]"
                              onClick={() => setDraft(editBudgetDraft(budget))}
                              size="sm"
                              theme="borderless"
                              variant="secondary"
                            />
                            <Button
                              aria-label={t('finance-billing.financeUi.common.delete')}
                              icon="icon-[mdi--delete-outline]"
                              onClick={() => setDeleteTarget(budget)}
                              size="sm"
                              theme="borderless"
                              variant="secondary"
                            />
                          </span>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </FinanceTableScroll>
        </>
      )}
    </SectionCard>
  );
};

const BudgetDeletion = (model: ReturnType<typeof usePlanningPanel>) => {
  const { t } = useModernI18n();
  const { budgetMonth, deleteTarget, setDeleteTarget, vm } = model;
  return (
    <Dialog
      actions={
        <>
          <Button onClick={() => setDeleteTarget(undefined)} theme="outlined" variant="secondary">
            Zrušit
          </Button>
          <Button
            onClick={() => {
              if (deleteTarget !== undefined) {
                void financeBrowserRuntime.runPromise(
                  vm.execute({ _tag: 'DeleteBudgetLine', id: deleteTarget.id }, 'Položka rozpočtu smazána'),
                );
              }
              setDeleteTarget(undefined);
            }}
            variant="danger"
          >
            Smazat
          </Button>
        </>
      }
      closeLabel={dialogCloseLabel}
      customTrigger
      description={`Smazat rozpočet „${deleteTarget?.category ?? ''}“ pro ${monthLabel(budgetMonth)}?`}
      onOpenChange={(details) => {
        if (!details.open) {
          setDeleteTarget(undefined);
        }
      }}
      open={deleteTarget !== undefined}
      placement="center"
      role="alertdialog"
      size="sm"
      title={t('finance-billing.financeUi.planning.deleteBudgetItem')}
    />
  );
};

export const PlanningPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const { t } = useModernI18n();
  const model = usePlanningPanel(vm);
  const { budgetMonth, currentMonth, draft, last, opening, openingOpen, setDraft, setOpeningOpen, totals } = model;
  return (
    <div className="flex flex-col gap-250">
      <StatRow>
        <StatCard
          label={t('finance-billing.financeUi.planning.confirmedOpening')}
          value={opening === undefined ? 'nezadán' : wholeKc(opening.openingBalanceMinor)}
        />
        <StatCard label={t('finance-billing.financeUi.planning.netPaid')} value={wholeKc(totals.paid)} />
        <StatCard label={t('finance-billing.financeUi.planning.netExpected')} value={wholeKc(totals.expected)} />
        <StatCard
          label={`Odhad zůstatku – ${last === undefined ? '' : monthLabel(last.month)}`}
          value={
            last?.forecastBalanceMinor === undefined ? 'bez počátečního stavu' : wholeKc(last.forecastBalanceMinor)
          }
        />
      </StatRow>

      <CashFlowForecast {...model} />

      <PlanItemsSection vm={vm} />

      <BudgetComparison {...model} />

      {draft !== undefined && (
        <BudgetEditor budgetMonth={budgetMonth} initial={draft} onClose={() => setDraft(undefined)} vm={vm} />
      )}
      <BudgetDeletion {...model} />
      {openingOpen && <OpeningBalanceEditor month={currentMonth} onClose={() => setOpeningOpen(false)} vm={vm} />}
    </div>
  );
};
