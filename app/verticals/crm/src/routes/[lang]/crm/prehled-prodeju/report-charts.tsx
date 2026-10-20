// Charts of the sales report (crm-reports lane): order counts per month by status meaning, and the value per month
// in ONE chosen currency (currencies are never mixed in a chart).
import { EmptyState, SectionCard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { useState } from 'react';
import type { SalesReport } from '../../../../../shared/domain/reports.ts';
import { statusMeaningLabels, statusMeanings } from '../../../../../shared/domain/reports.ts';
import { formatDecimalMoney, totalIn } from './report-format.ts';

const shortMonth = (label: string) => {
  const [name = '', year = ''] = label.split(' ');
  return `${name.slice(0, 3)} ${year.slice(2)}`;
};

interface CountDatum {
  readonly count: number;
  readonly month: string;
  readonly status: string;
}

interface ValueDatum {
  readonly month: string;
  readonly value: number;
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

  const presentMeanings = statusMeanings.filter((meaning) => report.rows.some((row) => row.meaning === meaning));
  const counts = new Map<string, number>();
  for (const row of report.rows) {
    const key = `${row.month}|${row.meaning}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countData: CountDatum[] = report.byMonth.flatMap((month) =>
    presentMeanings.map((meaning) => ({
      count: counts.get(`${month.key}|${meaning}`) ?? 0,
      month: shortMonth(month.label),
      status: statusMeaningLabels[meaning],
    })),
  );
  const valueData: ValueDatum[] =
    currency === undefined
      ? []
      : report.byMonth.map((month) => ({
          month: shortMonth(month.label),
          value: Number(totalIn(month.totals, currency)?.amount ?? '0'),
        }));
  const firstMonth = report.byMonth[0]?.label ?? '';
  const lastMonth = report.byMonth.at(-1)?.label ?? '';

  return (
    <div className="grid min-w-0 grid-cols-1 gap-250 xl:grid-cols-2">
      <SectionCard title="Počet objednávek po měsících">
        <p className="text-fg-secondary text-sm">Barva = význam stavu podle schváleného mapování. Měna nehraje roli.</p>
        <Chart
          ariaDescription={`Sloupcový graf počtu započtených objednávek od ${firstMonth} do ${lastMonth}, rozdělený podle významu stavu. Přesná čísla jsou v tabulce Souhrn.`}
          ariaLabel="Počet objednávek po měsících podle stavu"
          data={countData}
          formatValue={(value) => String(Math.round(value))}
          height={260}
          series="status"
          stacked
          type="bar"
          x="month"
          y="count"
        />
      </SectionCard>
      <SectionCard
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
        title={currency === undefined ? 'Hodnota objednávek' : `Hodnota objednávek v ${currency}`}
      >
        {currency === undefined ? (
          <EmptyState description="Zdroj u započtených objednávek neposkytl částku a měnu." title="Bez dat" />
        ) : (
          <>
            <p className="text-fg-secondary text-sm">
              Součet importovaných částek jen v {currency}
              {report.currencies.length > 1 ? '; ostatní měny přepněte vpravo nahoře, nikdy se nesčítají' : ''}.
            </p>
            <Chart
              ariaDescription={`Sloupcový graf hodnoty započtených objednávek v ${currency} od ${firstMonth} do ${lastMonth}.`}
              ariaLabel={`Hodnota objednávek v ${currency} po měsících`}
              data={valueData}
              formatValue={(value) => formatDecimalMoney(String(Math.round(value)), currency)}
              height={260}
              type="bar"
              x="month"
              y="value"
            />
          </>
        )}
      </SectionCard>
    </div>
  );
};
