// Consumption and costs per property/unit (ops-meters lane, S04 „tabulka vývoje spotřeby a nákladů“).
// Media and units of measure are never summed together; missing costs read „bez dat“, never 0.
import { SectionCard, formatMoney } from '@app/admin-ui';
import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { Badge } from '@techsio/ui-kit/atoms/badge';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Chart } from '@techsio/ui-kit/molecules/chart';
import { Table } from '@techsio/ui-kit/organisms/table';
import { SelectTemplate as Select } from '@techsio/ui-kit/templates/select';
import { useState } from 'react';
import { meterMedia, monthlySeries } from '../../../../../../shared/domain/meters.ts';
import type { Meter, MeterMedium } from '../../../../../../shared/domain/meters.ts';
import { SITE, formatQuantity, metersAt, monthLabel, monthLongLabel, placeOptions } from './meters-view.ts';

const k = 'siampark-ops.meters';

export const ConsumptionByPlace = ({
  language,
  meters,
}: {
  readonly language: string;
  readonly meters: readonly Meter[];
}) => {
  const { t } = useModernI18n();
  const places = placeOptions(meters, t(`${k}.byUnit.allPlaces`));
  const [place, setPlace] = useState(SITE);
  const selected = metersAt(meters, place);
  const media = meterMedia.filter((medium) => selected.some((meter) => meter.medium === medium));
  const [chosenMedium, setMedium] = useState<MeterMedium | undefined>(undefined);
  const medium = chosenMedium !== undefined && media.includes(chosenMedium) ? chosenMedium : media[0];
  const points = monthlySeries(selected.filter((meter) => meter.medium === medium));
  const units = [...new Set(points.map((point) => point.unit))];
  const unit = units[0];
  const series = points.filter((point) => point.unit === unit);
  const placeLabel = places.find((option) => option.value === place)?.label ?? '';
  const counted = selected.filter((meter) => meter.medium === medium).length;

  return (
    <SectionCard
      actions={
        <div className="flex flex-wrap items-end gap-150">
          <div className="min-w-[16rem]">
            <Select
              items={places.map((option) => ({ displayValue: option.label, label: option.label, value: option.value }))}
              label={t(`${k}.byUnit.place`)}
              name="consumption-place"
              onValueChange={({ value }) => setPlace(value[0] ?? SITE)}
              size="sm"
              value={[place]}
            />
          </div>
          <fieldset aria-label={t(`${k}.byUnit.medium`)} className="inline-flex rounded-button-sm border border-border-primary p-50">
            {media.map((entry) => (
              <Button
                aria-pressed={entry === medium}
                key={entry}
                onClick={() => setMedium(entry)}
                size="sm"
                theme={entry === medium ? 'solid' : 'borderless'}
                variant={entry === medium ? 'primary' : 'secondary'}
              >
                {t(`${k}.medium.${entry}`)}
              </Button>
            ))}
          </fieldset>
        </div>
      }
      title={t(`${k}.byUnit.title`)}
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
              formatValue={(value) => formatQuantity(value, unit)}
              height={240}
              legend={series.some((point) => point.anomaly)}
              series="state"
              stacked
              type="bar"
              x="month"
              y="consumption"
            />
            <p className="pt-100 text-fg-secondary text-xs">{t(`${k}.byUnit.meters`, { count: counted })}</p>
          </div>
          <div className="overflow-x-auto">
            <Table size="sm" variant="line">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>{t(`${k}.byUnit.month`)}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t(`${k}.byUnit.consumption`)}</Table.ColumnHeader>
                  <Table.ColumnHeader align="end">{t(`${k}.byUnit.cost`)}</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {[...series].reverse().map((point) => (
                  <Table.Row key={point.month}>
                    <Table.Cell>
                      <div className="flex flex-wrap items-center gap-100">
                        <span className="capitalize">{monthLongLabel(point.month, language)}</span>
                        {point.anomaly && (
                          <Badge size="sm" variant="danger">
                            {t(`${k}.detail.series.anomaly`)}
                          </Badge>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      {formatQuantity(point.consumption, point.unit)}
                    </Table.Cell>
                    <Table.Cell align="end" className="tabular-nums">
                      <div className="flex flex-col items-end">
                        <span>
                          {point.costMinor === undefined ? t('siampark-ops.common.noData') : formatMoney(point.costMinor)}
                        </span>
                        {point.costMinor !== undefined && point.periodsWithoutCost > 0 && (
                          <span className="text-fg-secondary text-xs">
                            {t(`${k}.byUnit.costPartial`, { count: point.periodsWithoutCost })}
                          </span>
                        )}
                      </div>
                    </Table.Cell>
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
