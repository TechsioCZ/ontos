import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SectionCard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DateTime } from 'effect';
import type { executeRecords as executeProperty } from '@app/property-portfolio/clients/records';
import type { Effect } from 'effect';
import type { Occupancy, RecordsResponse } from '../../../../shared/apis/records.ts';
import './occupancy-calendar.css';

type Properties = Effect.Success<ReturnType<typeof executeProperty>>;
const monthFormat = new Intl.DateTimeFormat('cs-CZ', { month: 'long', timeZone: 'UTC', year: 'numeric' });
const todayFormat = new Intl.DateTimeFormat('sv-SE', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'Europe/Prague',
  year: 'numeric',
});
const todayInPrague = () => todayFormat.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
export const dayOccupancy = (records: readonly Occupancy[], unitId: string, day: string) =>
  records.find(
    (record) =>
      record.unitRef.resourceId === unitId &&
      (record.state === 'ACTIVE' || record.state === 'CONFIRMED') &&
      record.startDate <= day &&
      (record.endDate === null || day < record.endDate),
  );

const dayPresentation = (lease: Occupancy | undefined, unavailable: boolean) => {
  if (unavailable) {
    return { className: '', mark: '—', status: 'Mimo provoz' };
  }
  if (lease?.state === 'ACTIVE') {
    return { className: 'sp-day-occupied', mark: 'O', status: 'Obsazeno' };
  }
  if (lease === undefined) {
    return { className: '', mark: '·', status: 'Volno' };
  }
  return { className: 'sp-day-reserved', mark: 'R', status: 'Rezervováno' };
};

/** Exact source intervals, not a second calendar store: cancellation releases every affected day immediately. */
export const OccupancyCalendar = ({
  language,
  monthValue,
  onMonthChange,
  properties,
  snapshot,
}: {
  readonly language: string;
  readonly monthValue: string;
  readonly onMonthChange: (month: string) => void;
  readonly properties: Properties;
  readonly snapshot: RecordsResponse;
}) => {
  const { t } = useModernI18n();
  const today = todayInPrague();
  const month = monthValue === '' ? `${today.slice(0, 7)}-01` : monthValue;
  const start = DateTime.makeUnsafe(`${month}T00:00:00Z`);
  const next = DateTime.add(start, { months: 1 });
  const days = Array.from(
    { length: Math.round((DateTime.toEpochMillis(next) - DateTime.toEpochMillis(start)) / 86_400_000) },
    (_, index) => DateTime.formatIsoDate(DateTime.add(start, { days: index })),
  );
  const shift = (months: number) => onMonthChange(DateTime.formatIsoDate(DateTime.add(start, { months })));
  return (
    <div className="sp-occupancy-calendar">
      <SectionCard
        actions={
          <div className="sp-calendar-controls">
            <Button
              aria-label={t('property-leasing.calendar.previousMonth')}
              onClick={() => shift(-1)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              ←
            </Button>
            <strong>{monthFormat.format(DateTime.toEpochMillis(start))}</strong>
            <Button
              aria-label={t('property-leasing.calendar.nextMonth')}
              onClick={() => shift(1)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              →
            </Button>
            <Button
              onClick={() => onMonthChange(`${today.slice(0, 7)}-01`)}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              Dnes
            </Button>
          </div>
        }
        title={t('property-leasing.calendar.title')}
      >
        <p className="sp-calendar-muted">
          Každý den odkazuje na zdrojový nájem nebo jednotku. Den konce pobytu je volný; koncepty a zrušené rezervace
          neblokují kapacitu.
        </p>
        <div className="sp-calendar-legend">
          <span>
            <b className="sp-day-occupied">O</b> Obsazeno
          </span>
          <span>
            <b className="sp-day-reserved">R</b> Rezervováno
          </span>
          <span>
            <b>·</b> Volno
          </span>
          <span>
            <b>—</b> Mimo provoz
          </span>
        </div>
        <div className="sp-calendar-scroll">
          <table>
            <caption>Obsazenost · {monthFormat.format(DateTime.toEpochMillis(start))}</caption>
            <thead>
              <tr>
                <th>Jednotka</th>
                {days.map((day) => (
                  <th aria-current={day === today ? 'date' : undefined} key={day} scope="col">
                    {Number(day.slice(8))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {properties.units.map((unit) => (
                <tr key={unit.unitRef.resourceId}>
                  <th scope="row">
                    <a href={`/${language}/nemovitosti?resourceId=${unit.unitRef.resourceId}`}>{unit.code}</a>
                  </th>
                  {days.map((day) => {
                    const lease = dayOccupancy(snapshot.occupancies, unit.unitRef.resourceId, day);
                    const unavailable = unit.lifecycleState !== 'ACTIVE';
                    const { className, mark, status } = dayPresentation(lease, unavailable);
                    const detail =
                      lease === undefined || unavailable
                        ? status
                        : `${status}: ${lease.startDate} – ${lease.endDate ?? 'na dobu neurčitou'}`;
                    return (
                      <td key={day}>
                        <a
                          aria-label={`${unit.code}, ${day}, ${detail}`}
                          className={className}
                          href={
                            lease === undefined || unavailable
                              ? `/${language}/nemovitosti?resourceId=${unit.unitRef.resourceId}`
                              : `/${language}/najmy?resourceId=${lease.occupancyRef.resourceId}`
                          }
                        >
                          {mark}
                        </a>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
};
