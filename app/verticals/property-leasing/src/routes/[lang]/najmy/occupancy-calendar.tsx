import { useModernI18n } from '@modern-js/plugin-i18n/runtime';
import { SectionCard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { Link } from '@techsio/ui-kit/atoms/link';
import { DateTime } from 'effect';
import type { executeRecords as executeProperty } from '@app/property-portfolio/clients/records';
import type { Effect } from 'effect';
import type { Occupancy, RecordsResponse } from '../../../../shared/apis/records.ts';

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

/*
 * States read from tint + letter (O/R/·/—); no strokes, so a month of occupied days stays a calm band. Occupied is the
 * surface under a 22 % secondary-text tint; reserved is a 16 % secondary-text hatch.
 */
const occupiedDayClass = 'bg-surface bg-linear-to-r from-fg-secondary/22 to-fg-secondary/22 font-bold text-fg-primary';
const reservedDayClass =
  'bg-[repeating-linear-gradient(135deg,var(--tw-gradient-from)_0_3px,transparent_3px_6px)] from-fg-secondary/16 font-semibold text-fg-primary';
const freeDayClass = 'text-fg-secondary';
const legendMarkClass = 'inline-grid h-6 w-6 place-items-center rounded-sm';
const unitHeaderClass = 'sticky left-0 z-1 min-w-17 bg-surface px-0.5 py-1.5 text-left font-medium';
const dayCellClass =
  'grid min-h-7.5 min-w-6.5 place-items-center rounded-sm no-underline hover:outline-1 hover:outline-fg-secondary';

const dayPresentation = (lease: Occupancy | undefined, unavailable: boolean) => {
  if (unavailable) {
    return { className: freeDayClass, mark: '—', status: 'Mimo provoz' };
  }
  if (lease?.state === 'ACTIVE') {
    return { className: occupiedDayClass, mark: 'O', status: 'Obsazeno' };
  }
  if (lease === undefined) {
    return { className: freeDayClass, mark: '·', status: 'Volno' };
  }
  return { className: reservedDayClass, mark: 'R', status: 'Rezervováno' };
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
    <div className="min-w-0">
      <SectionCard
        actions={
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Button
              appearance="outline"
              aria-label={t('property-leasing.calendar.previousMonth')}
              onClick={() => shift(-1)}
              severity="secondary"
              size="sm"
            >
              ←
            </Button>
            <strong className="min-w-25 text-center capitalize">
              {monthFormat.format(DateTime.toEpochMillis(start))}
            </strong>
            <Button
              appearance="outline"
              aria-label={t('property-leasing.calendar.nextMonth')}
              onClick={() => shift(1)}
              severity="secondary"
              size="sm"
            >
              →
            </Button>
            <Button
              appearance="ghost"
              onClick={() => onMonthChange(`${today.slice(0, 7)}-01`)}
              severity="secondary"
              size="sm"
            >
              Dnes
            </Button>
          </div>
        }
        title={t('property-leasing.calendar.title')}
      >
        <p className="text-[12px] leading-[1.7] text-fg-secondary">
          Každý den odkazuje na zdrojový nájem nebo jednotku. Den konce pobytu je volný; koncepty a zrušené rezervace
          neblokují kapacitu.
        </p>
        <div className="flex flex-wrap gap-4 text-[12px]">
          <span className="flex items-center gap-1.5">
            <b className={`${legendMarkClass} ${occupiedDayClass}`}>O</b> Obsazeno
          </span>
          <span className="flex items-center gap-1.5">
            <b className={`${legendMarkClass} ${reservedDayClass}`}>R</b> Rezervováno
          </span>
          <span className="flex items-center gap-1.5">
            <b className={legendMarkClass}>·</b> Volno
          </span>
          <span className="flex items-center gap-1.5">
            <b className={legendMarkClass}>—</b> Mimo provoz
          </span>
        </div>
        <div className="max-w-full overflow-x-auto pb-2">
          <table className="w-full min-w-[1020px] border-separate border-spacing-0.5 text-[12px] tabular-nums">
            <caption className="pb-3 text-left text-[12px] text-fg-secondary">
              Obsazenost · {monthFormat.format(DateTime.toEpochMillis(start))}
            </caption>
            <thead>
              <tr>
                <th className={unitHeaderClass}>Jednotka</th>
                {days.map((day) => (
                  <th
                    aria-current={day === today ? 'date' : undefined}
                    className={
                      day === today
                        ? 'px-0.5 py-1.5 font-bold underline underline-offset-4'
                        : 'px-0.5 py-1.5 font-medium'
                    }
                    key={day}
                    scope="col"
                  >
                    {Number(day.slice(8))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {properties.units.map((unit) => (
                <tr key={unit.unitRef.resourceId}>
                  <th className={unitHeaderClass} scope="row">
                    <Link
                      className="text-inherit no-underline"
                      href={`/${language}/nemovitosti?resourceId=${unit.unitRef.resourceId}`}
                      size="current"
                    >
                      {unit.code}
                    </Link>
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
                        <Link
                          aria-label={`${unit.code}, ${day}, ${detail}`}
                          className={`${dayCellClass} ${className}`}
                          href={
                            lease === undefined || unavailable
                              ? `/${language}/nemovitosti?resourceId=${unit.unitRef.resourceId}`
                              : `/${language}/najmy?resourceId=${lease.occupancyRef.resourceId}`
                          }
                          size="current"
                        >
                          {mark}
                        </Link>
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
