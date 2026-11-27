// Consumption and costs per property/unit (ops-meters lane, S04 „tabulka vývoje spotřeby a nákladů“).
// Media and units of measure are never summed together; missing costs read „bez dat“, never 0.
import { SectionCard, formatMoney } from '@app/admin-ui';
import { FormBuilder, FormReact, FormRoot, TemplateChoiceField, useAtomValue } from '@app/core-runtime/ui/form';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { Table } from '@techsio/ui-kit/organisms/table';
import { Effect, Option, Schema } from 'effect';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { browserAtomRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import { meterMedia, monthlySeries } from '../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium } from '../../../../../shared/domain/meters.ts';
import { SITE, formatQuantity, metersAt, monthLabel, monthLongLabel, placeOptions } from './meters-view.ts';

const k = 'facility-operations.meters';

/** The place the consumption is shown for; it acts as it changes, so Enter sends nothing. */
const placeForm = FormReact.make(FormBuilder.empty.addField('place', Schema.String), {
  fields: { place: TemplateChoiceField },
  onSubmit: () => Effect.void,
  runtime: browserAtomRuntime,
});
const wholeSite = { place: SITE };
/** The picked place; no pick is the whole site. */
const pickedPlace = placeForm.getFieldAtoms(placeForm.fields.place).value.pipe(
  Atom.map((value) => {
    const place = Option.getOrElse(value, () => '');
    return place === '' ? SITE : place;
  }),
);

export const ConsumptionByPlace = ({
  canReadFinancial,
  language,
  meters,
}: {
  readonly canReadFinancial: boolean;
  readonly language: string;
  readonly meters: readonly Meter[];
}) => {
  const { t } = useModernI18n();
  const places = placeOptions(meters, t(`${k}.byUnit.allPlaces`));
  const place = useAtomValue(pickedPlace);
  const selected = metersAt(meters, place);
  const media = meterMedia.filter((medium) => selected.some((meter) => meter.medium === medium));
  const [chosenMedium, setChosenMedium] = useState<MeterMedium | undefined>();
  const medium = chosenMedium !== undefined && media.includes(chosenMedium) ? chosenMedium : media[0];
  const points = monthlySeries(selected.filter((meter) => meter.medium === medium));
  const units = [...new Set(points.map((point) => point.unit))];
  const [unit] = units;
  const series = points.filter((point) => point.unit === unit);
  const placeLabel = places.find((option) => option.value === place)?.label ?? '';
  const counted = selected.filter((meter) => meter.medium === medium).length;
  // The axis shows "zář 26"; the tooltip titles the column with the full month ("září 2026").
  const monthTitles = new Map(
    series.map((point) => [monthLabel(point.month, language), monthLongLabel(point.month, language)] as const),
  );

  return (
    <SectionCard
      actions={
        <div className="flex flex-wrap items-end gap-150">
          <FormRoot
            className="min-w-[16rem]"
            defaultValues={wholeSite}
            form={placeForm}
            translateMessage={(message) => t(message)}
          >
            <placeForm.place
              items={places.map((option) => ({ label: option.label, value: option.value }))}
              label={t(`${k}.byUnit.place`)}
              size="sm"
            />
          </FormRoot>
          <fieldset
            aria-label={t(`${k}.byUnit.medium`)}
            className="inline-flex rounded-button-sm border border-border-primary p-50"
          >
            {media.map((entry) => (
              <Button
                appearance={entry === medium ? 'solid' : 'ghost'}
                aria-pressed={entry === medium}
                key={entry}
                onClick={() => setChosenMedium(entry)}
                severity={entry === medium ? 'primary' : 'secondary'}
                size="sm"
              >
                {t(`${k}.medium.${entry}`)}
              </Button>
            ))}
          </fieldset>
        </div>
      }
      title={t(`${k}.byUnit.${canReadFinancial ? 'title' : 'operationalTitle'}`)}
    >
      <p className="text-fg-secondary text-sm">{t(`${k}.byUnit.description`)}</p>
      {medium === undefined || unit === undefined || series.length === 0 ? (
        <p className="rounded-md border border-border-primary border-dashed p-250 text-center text-fg-secondary text-sm">
          {t(`${k}.byUnit.empty`)}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-250 xl:grid-cols-[3fr_2fr]">
          <div className="min-w-0">
            <Chart
              ariaLabel={t(`${k}.byUnit.chartAria`, {
                medium: t(`${k}.medium.${medium}`),
                place: placeLabel,
                unit,
              })}
              data={series.map((point) => ({
                consumption: point.consumption,
                month: monthLabel(point.month, language),
                state: point.anomaly ? t(`${k}.detail.series.anomaly`) : t(`${k}.detail.series.normal`),
              }))}
              dataTableLabel={t('facility-operations.chartData.toggle')}
              formatCategory={(month) => monthTitles.get(String(month)) ?? String(month)}
              formatValue={(value) => formatQuantity(value, unit)}
              height={240}
              legend={series.some((point) => point.anomaly)}
              legendLabel={t('facility-operations.chartData.series')}
              locale={language}
              series="state"
              stacked
              type="bar"
              x="month"
              xLabel={t('facility-operations.chartData.category')}
              y="consumption"
              yLabel={t('facility-operations.chartData.value')}
            />
            <p className="pt-100 text-fg-secondary text-xs">{t(`${k}.byUnit.meters`, { count: counted })}</p>
          </div>
          <div className="overflow-x-auto">
            <Table appearance="line" size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{t(`${k}.byUnit.month`)}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t(`${k}.byUnit.consumption`)}</Table.ColumnHeader>
                  {canReadFinancial && <Table.ColumnHeader align="end">{t(`${k}.byUnit.cost`)}</Table.ColumnHeader>}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {series.toReversed().map((point) => (
                  <Table.Row key={point.month}>
                    <Table.Cell>
                      <div className="flex flex-wrap items-center gap-100">
                        <span className="capitalize">{monthLongLabel(point.month, language)}</span>
                        {point.anomaly && (
                          <Badge severity="danger" size="sm">
                            {t(`${k}.detail.series.anomaly`)}
                          </Badge>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatQuantity(point.consumption, point.unit)}
                    </Table.Cell>
                    {canReadFinancial && (
                      <Table.Cell align="end" className="tabular-nums">
                        <div className="flex flex-col items-end">
                          <span>
                            {point.costMinor === undefined
                              ? t('facility-operations.common.noData')
                              : formatMoney(point.costMinor)}
                          </span>
                          {point.costMinor !== undefined && point.periodsWithoutCost > 0 && (
                            <span className="text-fg-secondary text-xs">
                              {t(`${k}.byUnit.costPartial`, { count: point.periodsWithoutCost })}
                            </span>
                          )}
                        </div>
                      </Table.Cell>
                    )}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </div>
      )}
    </SectionCard>
  );
};
