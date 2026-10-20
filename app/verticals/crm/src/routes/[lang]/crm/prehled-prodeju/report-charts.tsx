// One series per chart: counts or one currency, never mixed currencies or filter-dependent series colors.
import { EmptyState, SectionCard, formatNumber } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { Component, useState } from 'react';
import type { ReactNode } from 'react';
import type { SalesReport } from '../../../../../shared/domain/reports.ts';
import { statusMeaningLabels, statusMeanings } from '../../../../../shared/domain/reports.ts';
import { formatDecimalMoney, totalIn } from './report-format.ts';

const shortMonths = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const shortMonth = (key: string) => `${shortMonths[Number(key.slice(5, 7)) - 1] ?? key.slice(5, 7)} ${key.slice(2, 4)}`;

class ChartBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p className="text-fg-secondary text-sm">Graf se nepodařilo vykreslit; čísla najdete v datové tabulce níže.</p>
    ) : (
      this.props.children
    );
  }
}

export const ReportCharts = ({ report }: { readonly report: SalesReport }) => {
  const [chosenCurrency, setCurrency] = useState<string | undefined>(undefined);
  const currency =
    chosenCurrency !== undefined && report.currencies.includes(chosenCurrency) ? chosenCurrency : report.currencies[0];
  if (report.count === 0) {
    return (
      <SectionCard title="Vývoj po měsících">
        <EmptyState description="Pro zvolené filtry neexistuje žádná započtená objednávka." title="Bez dat" />
      </SectionCard>
    );
  }
  const meanings = statusMeanings.filter((meaning) => report.rows.some((row) => row.meaning === meaning));
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const key = `${row.month}|${row.meaning}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countData = report.byMonth.map((month) => ({ count: month.count, month: shortMonth(month.key) }));
  const valueData =
    currency === undefined
      ? []
      : report.byMonth.flatMap((month) => {
          const total = totalIn(month.totals, currency);
          // A month with orders but no supplied amount in this currency is missing data, not a zero value.
          return total === undefined && month.count > 0
            ? []
            : [{ month: shortMonth(month.key), value: Number(total?.amount ?? '0') }];
        });
  const firstMonth = report.byMonth[0]?.label ?? '';
  const lastMonth = report.byMonth.at(-1)?.label ?? '';
  return (
    <section className="flex min-w-0 flex-col gap-150" aria-label="Vývoj objednávek a dostupná data grafů">
      <div className="grid min-w-0 grid-cols-1 gap-250 xl:grid-cols-2">
        <SectionCard title="Počet objednávek po měsících">
          <p className="text-fg-secondary text-sm">
            Spárované objednávky bez duplicit. Podrobné rozdělení podle stavů je v datové tabulce a souhrnu.
          </p>
          <ChartBoundary>
            <Chart
              ariaDescription={`Počet objednávek od ${firstMonth} do ${lastMonth}. Přesná čísla včetně stavů jsou v datové tabulce pod grafy.`}
              ariaLabel="Počet objednávek po měsících"
              data={countData}
              formatValue={(value) => String(Math.round(value))}
              height={260}
              type="bar"
              x="month"
              y="count"
            />
          </ChartBoundary>
        </SectionCard>
        <SectionCard
          title={currency === undefined ? 'Hodnota objednávek' : `Hodnota objednávek v ${currency}`}
          actions={
            report.currencies.length > 1 ? (
              <fieldset
                aria-label="Měna grafu"
                className="inline-flex rounded-button-sm border border-border-primary p-50"
              >
                {report.currencies.map((entry) => (
                  <Button
                    aria-pressed={entry === currency}
                    key={entry}
                    onClick={() => setCurrency(entry)}
                    size="sm"
                    theme={entry === currency ? 'solid' : 'borderless'}
                    variant={entry === currency ? 'primary' : 'secondary'}
                  >
                    {entry}
                  </Button>
                ))}
              </fieldset>
            ) : undefined
          }
        >
          {currency === undefined ? (
            <EmptyState description="Zdroj u započtených objednávek neposkytl částku a měnu." title="Bez dat" />
          ) : (
            <>
              <p className="text-fg-secondary text-sm">
                Součet importovaných částek jen v {currency}; ostatní měny se nikdy nepřičítají. Nejde o tržbu. Měsíce
                bez poskytnuté částky v této měně se nevykreslují.
              </p>
              <ChartBoundary>
                <Chart
                  ariaDescription={`Hodnota objednávek v ${currency} od ${firstMonth} do ${lastMonth}. Přesné částky jsou v datové tabulce pod grafy.`}
                  ariaLabel={`Hodnota objednávek v ${currency} po měsících`}
                  data={valueData}
                  formatValue={(value) => formatDecimalMoney(String(value), currency)}
                  height={260}
                  type="bar"
                  x="month"
                  y="value"
                />
              </ChartBoundary>
            </>
          )}
        </SectionCard>
      </div>
      <details className="rounded-lg border border-border-primary bg-surface p-200">
        <summary className="cursor-pointer font-medium text-sm">
          Zobrazit datovou tabulku grafů (měsíce, stavy, měny)
        </summary>
        <div className="overflow-x-auto pt-150">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Přesná měsíční data obou grafů, stavy podle demo mapování</caption>
            <thead>
              <tr className="border-border-primary border-b text-left">
                <th className="py-100 pr-200" scope="col">
                  Měsíc
                </th>
                <th className="py-100 pr-200" scope="col">
                  Objednávky
                </th>
                {meanings.map((meaning) => (
                  <th className="py-100 pr-200" key={meaning} scope="col">
                    {statusMeaningLabels[meaning]}
                  </th>
                ))}
                {report.currencies.map((entry) => (
                  <th className="py-100 pr-200" key={entry} scope="col">
                    Hodnota {entry}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.byMonth.map((month) => (
                <tr className="border-border-primary border-b" key={month.key}>
                  <th className="py-100 pr-200 text-left font-normal" scope="row">
                    {month.label}
                  </th>
                  <td className="py-100 pr-200 tabular-nums">{formatNumber(month.count)}</td>
                  {meanings.map((meaning) => (
                    <td className="py-100 pr-200 tabular-nums" key={meaning}>
                      {formatNumber(counts.get(`${month.key}|${meaning}`) ?? 0)}
                    </td>
                  ))}
                  {report.currencies.map((entry) => {
                    const total = totalIn(month.totals, entry);
                    return (
                      <td className="py-100 pr-200 tabular-nums" key={entry}>
                        {total === undefined ? '—' : formatDecimalMoney(total.amount, entry)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
};
