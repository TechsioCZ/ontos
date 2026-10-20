// @effect-diagnostics asyncFunction:off
// @effect-diagnostics newPromise:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
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
import { FormInput } from '@techsio/ui-kit/molecules/form-input';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate } from '@techsio/ui-kit/templates/select';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { BudgetLine } from '../../../../../shared/apis/records.ts';
import {
  addMonths,
  budgetActualMinor,
  budgetVariance,
  cashFlowMonths,
  invoiceActualMinor,
  monthOf,
} from '../../../../../shared/domain/finance-planning.ts';
import { minorToInput, monthLabel, outcomeMessage, parseAmountMinor, shortMonthLabel } from './finance-ui.tsx';
import type { FinanceViewModel } from './finance-ui.tsx';
import { BUDGET_CATEGORIES } from './incoming-invoice-dialog.tsx';

const at = (value: DateTime.Utc) => formatDateTime(DateTime.formatIso(value));
const wholeKc = (minor: number) => formatMoney(Math.round(minor / 100) * 100);
const axisKc = (value: number) =>
  `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 3, notation: 'compact' }).format(value)} Kč`;
const percent = (value: number) =>
  `${value > 0 ? '+' : ''}${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 1 }).format(value * 100)} %`;

interface BudgetDraft {
  readonly actual: string;
  readonly category: string;
  readonly explanation: string;
  readonly id: string | undefined;
  readonly kind: BudgetLine['kind'];
  readonly planned: string;
}

const newDraft = (): BudgetDraft => ({
  actual: '',
  category: 'Energie',
  explanation: '',
  id: undefined,
  kind: 'COST',
  planned: '',
});

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
  const max = Math.max(1, ...rows.flatMap((row) => [row.actual, row.planned]));
  return (
    <ul aria-label="Plán a skutečnost podle kategorií" className="flex flex-col gap-150">
      {rows.map((row) => (
        <li className="grid grid-cols-1 items-center gap-100 text-sm md:grid-cols-[10rem_1fr]" key={row.label}>
          <span className="truncate">{row.label}</span>
          <span className="flex min-w-0 flex-col gap-50">
            <span className="grid items-center gap-100" style={{ gridTemplateColumns: 'minmax(0, 1fr) 10rem' }}>
              <span className="min-w-0" title={`Plán: ${formatMoney(row.planned)}`}>
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
              <span className="min-w-0" title={`Skutečnost: ${formatMoney(row.actual)}`}>
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

/** S09: monthly cash-flow with a confirmed opening balance, and user-editable budgets with plan vs. actual. */
export const PlanningPanel = ({ vm }: { readonly vm: FinanceViewModel }) => {
  const state = vm.snapshot?.state;
  const businessDate = vm.referenceDate === '' ? '2026-10-20' : vm.referenceDate;
  const currentMonth = monthOf(businessDate);
  const opening = state?.cashFlowOpening;
  const fromMonth = opening === undefined ? addMonths(currentMonth, -1) : monthOf(opening.openingDate);
  const months = state === undefined ? [] : cashFlowMonths(state, { businessDate, fromMonth, months: Math.max(6, 0) });
  const [budgetMonth, setBudgetMonth] = useState(currentMonth);
  const [draft, setDraft] = useState<BudgetDraft>();
  const [deleteTarget, setDeleteTarget] = useState<BudgetLine>();
  const [error, setError] = useState<string>();
  const [openingOpen, setOpeningOpen] = useState(false);
  const [openingAmount, setOpeningAmount] = useState('');
  const [openingDate, setOpeningDate] = useState(`${currentMonth}-01`);
  const invoices = state?.invoices ?? [];
  const budgets = (state?.budgets ?? []).filter((budget) => budget.period === budgetMonth);
  const budgetRows = budgets
    .map((budget) => ({ actual: budgetActualMinor(budget, invoices), budget }))
    .sort(
      (left, right) =>
        left.budget.kind.localeCompare(right.budget.kind) ||
        left.budget.category.localeCompare(right.budget.category, 'cs'),
    );
  const last = months.at(-1);
  const totals = months.reduce(
    (sum, month) => ({
      expected: sum.expected + month.expectedInMinor - month.expectedOutMinor,
      paid: sum.paid + month.paidInMinor - month.paidOutMinor,
    }),
    { expected: 0, paid: 0 },
  );
  const budgetMonths = Array.from({ length: 7 }, (_, index) => addMonths(currentMonth, index - 3));

  const flowData = months.flatMap((month) => [
    { label: shortMonthLabel(month.month), series: 'Příjmy uhrazené', value: month.paidInMinor / 100 },
    {
      label: shortMonthLabel(month.month),
      series: 'Příjmy očekávané a plán',
      value: (month.expectedInMinor + month.planInMinor) / 100,
    },
    { label: shortMonthLabel(month.month), series: 'Výdaje uhrazené', value: -month.paidOutMinor / 100 },
    {
      label: shortMonthLabel(month.month),
      series: 'Výdaje očekávané a plán',
      value: -(month.expectedOutMinor + month.planOutMinor) / 100,
    },
  ]);
  const balanceData = months.flatMap((month) =>
    month.forecastBalanceMinor === undefined
      ? []
      : [{ label: shortMonthLabel(month.month), value: month.forecastBalanceMinor / 100 }],
  );

  const saveBudget = async () => {
    if (draft === undefined) {
      return;
    }
    const planned = parseAmountMinor(draft.planned === '' ? '0' : draft.planned);
    const actual = draft.actual.trim() === '' ? undefined : parseAmountMinor(draft.actual);
    if (planned === undefined || (draft.actual.trim() !== '' && actual === undefined) || draft.category.trim() === '') {
      setError('Zkontrolujte kategorii a částky (např. 25 000 nebo 25 000,50).');
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'UpsertBudgetLine',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        ...(actual === undefined ? {} : { actualManualMinor: actual }),
        category: draft.category.trim(),
        ...(draft.explanation.trim() === '' ? {} : { explanation: draft.explanation.trim() }),
        ...(draft.id === undefined ? {} : { id: draft.id }),
        kind: draft.kind,
        period: budgetMonth,
        plannedMinor: planned,
      },
      'Rozpočet uložen',
    );
    if (outcome.ok) {
      setDraft(undefined);
      setError(undefined);
    } else {
      setError(outcomeMessage(vm, outcome));
    }
  };

  const saveOpening = async () => {
    const normalized = openingAmount.trim().startsWith('-') ? openingAmount.trim().slice(1) : openingAmount;
    const amount = parseAmountMinor(normalized);
    if (amount === undefined || openingDate === '') {
      setError('Zadejte počáteční stav a datum.');
      return;
    }
    const outcome = await vm.execute(
      {
        _tag: 'SetOpeningBalance',
        ...(vm.actorLabel === undefined ? {} : { actorLabel: vm.actorLabel }),
        openingBalanceMinor: openingAmount.trim().startsWith('-') ? -amount : amount,
        openingDate,
      },
      'Počáteční stav potvrzen',
    );
    if (outcome.ok) {
      setOpeningOpen(false);
      setError(undefined);
    } else {
      setError(outcomeMessage(vm, outcome));
    }
  };

  return (
    <div className="flex flex-col gap-250">
      {error !== undefined && (
        <StatusText showIcon size="sm" status="error">
          {error}
        </StatusText>
      )}
      <StatRow>
        <StatCard
          label="Počáteční stav (ručně potvrzený)"
          value={opening === undefined ? 'nezadán' : wholeKc(opening.openingBalanceMinor)}
        />
        <StatCard label="Uhrazeno v období (netto)" value={wholeKc(totals.paid)} />
        <StatCard label="Očekávané doklady (netto)" value={wholeKc(totals.expected)} />
        <StatCard
          label={`Odhad zůstatku – ${last === undefined ? '' : monthLabel(last.month)}`}
          value={
            last?.forecastBalanceMinor === undefined ? 'bez počátečního stavu' : wholeKc(last.forecastBalanceMinor)
          }
        />
      </StatRow>

      <SectionCard
        actions={
          vm.canWrite ? (
            <Button
              icon="icon-[mdi--bank-check]"
              onClick={() => {
                setOpeningAmount(minorToInput(opening?.openingBalanceMinor));
                setOpeningDate(opening?.openingDate ?? `${currentMonth}-01`);
                setOpeningOpen(true);
              }}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              {opening === undefined ? 'Zadat počáteční stav' : 'Změnit počáteční stav'}
            </Button>
          ) : undefined
        }
        title="Cash-flow po měsících"
      >
        <StatusText showIcon size="sm" status="default">
          Odhad = ručně potvrzený počáteční stav + uhrazené a očekávané příjmy − výdaje. Nejde o bankovní zůstatek.
          Uhrazená faktura se v očekávaných už nepočítá; plán se započítá jen v části, kterou ještě nepokryly doklady.
          {opening !== undefined &&
            ` Počáteční stav k ${formatDate(opening.openingDate)} potvrdil(a) ${opening.actorLabel ?? 'uživatel'} ${at(opening.confirmedAt)}.`}
        </StatusText>
        {months.length > 0 && (
          <div className="grid grid-cols-1 gap-250">
            <div className="flex flex-col gap-100">
              <span className="font-medium text-sm">Příjmy a výdaje</span>
              <Chart
                ariaLabel="Měsíční příjmy a výdaje: uhrazené, očekávané a plánované"
                data={flowData}
                formatValue={axisKc}
                height={260}
                series="series"
                stacked
                type="bar"
                x="label"
                y="value"
              />
            </div>
            <div className="flex flex-col gap-100">
              <span className="font-medium text-sm">
                Odhad zůstatku{' '}
                <Badge size="sm" variant="warning">
                  odhad
                </Badge>
              </span>
              {balanceData.length === 0 ? (
                <EmptyState description="Zadejte ručně potvrzený počáteční stav." title="Bez počátečního stavu" />
              ) : (
                <Chart
                  ariaLabel="Odhad zůstatku po měsících"
                  data={balanceData}
                  formatValue={axisKc}
                  height={260}
                  points
                  type="line"
                  x="label"
                  y="value"
                />
              )}
            </div>
          </div>
        )}
        <Table size="sm" variant="line">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Měsíc</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Příjmy uhrazené</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Výdaje uhrazené</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Očekávané příjmy</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Očekávané výdaje</Table.ColumnHeader>
              <Table.ColumnHeader align="end">Plán (nepokrytý)</Table.ColumnHeader>
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
      </SectionCard>

      <SectionCard
        actions={
          <>
            <div className="w-44">
              <SelectTemplate
                aria-label="Měsíc rozpočtu"
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
              <Button icon="icon-[mdi--plus]" onClick={() => setDraft(newDraft())} size="sm" variant="primary">
                Přidat položku
              </Button>
            )}
          </>
        }
        title="Rozpočet – plán a skutečnost"
      >
        <p className="text-fg-secondary text-sm">
          Skutečnost = ručně zadaná částka, jinak součet potvrzených faktur dané kategorie v měsíci. Procentní odchylka
          se počítá jen u nenulového plánu.
        </p>
        {budgetRows.length === 0 ? (
          <EmptyState description={`Pro ${monthLabel(budgetMonth)} zatím není rozpočet.`} title="Bez rozpočtu" />
        ) : (
          <>
            <PlanActualBars
              rows={budgetRows.map(({ actual, budget }) => ({
                actual,
                label: `${budget.category} (${budget.kind === 'COST' ? 'výdaj' : 'příjem'})`,
                over: budget.kind === 'COST' ? actual > budget.plannedMinor : actual < budget.plannedMinor,
                planned: budget.plannedMinor,
              }))}
            />
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Kategorie</Table.ColumnHeader>
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
                              ? `z faktur (${formatMoney(invoiceActualMinor(budget, invoices))})`
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
                              aria-label="Upravit"
                              icon="icon-[mdi--pencil-outline]"
                              onClick={() =>
                                setDraft({
                                  actual: minorToInput(budget.actualManualMinor),
                                  category: budget.category,
                                  explanation: budget.explanation ?? '',
                                  id: budget.id,
                                  kind: budget.kind,
                                  planned: minorToInput(budget.plannedMinor),
                                })
                              }
                              size="sm"
                              theme="borderless"
                              variant="secondary"
                            />
                            <Button
                              aria-label="Smazat"
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
          </>
        )}
      </SectionCard>

      <Dialog
        actions={
          <>
            <Button onClick={() => setDraft(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={vm.busy} onClick={() => void saveBudget()} variant="primary">
              Uložit
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description={`Rozpočet pro ${monthLabel(budgetMonth)}`}
        onOpenChange={(details) => {
          if (!details.open) {
            setDraft(undefined);
          }
        }}
        open={draft !== undefined}
        placement="center"
        size="md"
        title={draft?.id === undefined ? 'Nová rozpočtová položka' : 'Upravit rozpočet'}
      >
        {draft !== undefined && (
          <div className="flex flex-col gap-150">
            <div className="grid grid-cols-2 gap-150">
              <SelectTemplate
                items={[
                  { displayValue: 'Výdaj', label: 'Výdaj', value: 'COST' },
                  { displayValue: 'Příjem', label: 'Příjem', value: 'REVENUE' },
                ]}
                label="Typ"
                labelProps={{ className: 'font-label text-label-md' }}
                onValueChange={({ value }) => {
                  const [next] = value;
                  if (next === 'COST' || next === 'REVENUE') {
                    setDraft({ ...draft, kind: next });
                  }
                }}
                size="sm"
                value={[draft.kind]}
              />
              <SelectTemplate
                items={BUDGET_CATEGORIES.map((category) => ({
                  displayValue: category,
                  label: category,
                  value: category,
                }))}
                label="Kategorie"
                labelProps={{ className: 'font-label text-label-md' }}
                onValueChange={({ value }) => {
                  const [next] = value;
                  if (next !== undefined) {
                    setDraft({ ...draft, category: next });
                  }
                }}
                size="sm"
                value={[draft.category]}
              />
            </div>
            <FormInput
              id="budget-planned"
              inputMode="decimal"
              label="Plán (Kč)"
              onChange={(event) => setDraft({ ...draft, planned: event.target.value })}
              size="sm"
              value={draft.planned}
            />
            <FormInput
              helpText="Prázdné = skutečnost se spočítá z potvrzených faktur kategorie."
              id="budget-actual"
              inputMode="decimal"
              label="Skutečnost zadaná ručně (Kč, nepovinné)"
              onChange={(event) => setDraft({ ...draft, actual: event.target.value })}
              size="sm"
              value={draft.actual}
            />
            <FormInput
              id="budget-explanation"
              label="Vysvětlení odchylky"
              onChange={(event) => setDraft({ ...draft, explanation: event.target.value })}
              size="sm"
              value={draft.explanation}
            />
          </div>
        )}
      </Dialog>
      <Dialog
        actions={
          <>
            <Button onClick={() => setDeleteTarget(undefined)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button
              onClick={() => {
                if (deleteTarget !== undefined) {
                  void vm.execute({ _tag: 'DeleteBudgetLine', id: deleteTarget.id }, 'Položka rozpočtu smazána');
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
        title="Smazat položku rozpočtu"
      />
      <Dialog
        actions={
          <>
            <Button onClick={() => setOpeningOpen(false)} theme="outlined" variant="secondary">
              Zrušit
            </Button>
            <Button isLoading={vm.busy} onClick={() => void saveOpening()} variant="primary">
              Potvrzuji počáteční stav
            </Button>
          </>
        }
        closeLabel={dialogCloseLabel}
        customTrigger
        description="Zadejte stav prostředků ke dni, od kterého se počítá odhad. Uloží se s vaším jménem jako ručně potvrzený."
        onOpenChange={(details) => setOpeningOpen(details.open)}
        open={openingOpen}
        placement="center"
        size="sm"
        title="Počáteční stav pro cash-flow"
      >
        <div className="flex flex-col gap-150">
          <FormInput
            id="opening-amount"
            inputMode="decimal"
            label="Počáteční stav (Kč)"
            onChange={(event) => setOpeningAmount(event.target.value)}
            size="sm"
            value={openingAmount}
          />
          <FormInput
            id="opening-date"
            label="Ke dni"
            onChange={(event) => setOpeningDate(event.target.value)}
            size="sm"
            type="date"
            value={openingDate}
          />
        </div>
      </Dialog>
    </div>
  );
};
