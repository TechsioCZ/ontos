import { SectionCard } from '@app/admin-ui';
import { Button } from '@techsio/ui-kit/atoms/button';
import { DateTime } from 'effect';
import { useState } from 'react';
import type { executeRecords as executeProperty } from '@app/siampark-property/clients/records';
import type { Effect } from 'effect';
import type { Occupancy, RecordsResponse } from '../../../../../shared/apis/records.ts';
import './occupancy-calendar.css';

type Properties = Effect.Success<ReturnType<typeof executeProperty>>;
const monthFormat = new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const todayInPrague = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
export const dayOccupancy = (records: readonly Occupancy[], unitId: string, day: string) =>
  records.find(
    (record) =>
      record.unitRef.resourceId === unitId &&
      (record.state === 'ACTIVE' || record.state === 'CONFIRMED') &&
      record.startDate <= day &&
      (record.endDate === null || day < record.endDate),
  );

/** Exact source intervals, not a second calendar store: cancellation releases every affected day immediately. */
export const OccupancyCalendar = ({
  language,
  properties,
  snapshot,
}: {
  readonly language: string;
  readonly properties: Properties;
  readonly snapshot: RecordsResponse;
}) => {
  const today = todayInPrague();
  const [month, setMonth] = useState(() => `${today.slice(0, 7)}-01`);
  const start = DateTime.makeUnsafe(`${month}T00:00:00Z`);
  const next = DateTime.add(start, { months: 1 });
  const days = Array.from(
    { length: Math.round((DateTime.toEpochMillis(next) - DateTime.toEpochMillis(start)) / 86_400_000) },
    (_, index) => DateTime.formatIsoDate(DateTime.add(start, { days: index })),
  );
  const shift = (months: number) => setMonth(DateTime.formatIsoDate(DateTime.add(start, { months })));
  return (
    <div className="sp-occupancy-calendar">
      <SectionCard
        actions={
          <div className="sp-calendar-controls">
            <Button
              aria-label="Předchozí měsíc obsazenosti"
              onClick={() => shift(-1)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              ←
            </Button>
            <strong>{monthFormat.format(DateTime.toEpochMillis(start))}</strong>
            <Button
              aria-label="Následující měsíc obsazenosti"
              onClick={() => shift(1)}
              size="sm"
              theme="outlined"
              variant="secondary"
            >
              →
            </Button>
            <Button
              onClick={() => setMonth(`${today.slice(0, 7)}-01`)}
              size="sm"
              theme="borderless"
              variant="secondary"
            >
              Dnes
            </Button>
          </div>
        }
        title="Kalendář obsazenosti jednotek"
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
                    <a href={`/${language}/siampark/properties?resourceId=${unit.unitRef.resourceId}`}>{unit.code}</a>
                  </th>
                  {days.map((day) => {
                    const lease = dayOccupancy(snapshot.occupancies, unit.unitRef.resourceId, day);
                    const unavailable = unit.lifecycleState !== 'ACTIVE';
                    const status = unavailable
                      ? 'Mimo provoz'
                      : lease?.state === 'ACTIVE'
                        ? 'Obsazeno'
                        : lease === undefined
                          ? 'Volno'
                          : 'Rezervováno';
                    const detail =
                      lease === undefined || unavailable
                        ? status
                        : `${status}: ${lease.startDate} – ${lease.endDate ?? 'na dobu neurčitou'}`;
                    return (
                      <td key={day}>
                        <a
                          aria-label={`${unit.code}, ${day}, ${detail}`}
                          className={
                            unavailable
                              ? ''
                              : lease?.state === 'ACTIVE'
                                ? 'sp-day-occupied'
                                : lease === undefined
                                  ? ''
                                  : 'sp-day-reserved'
                          }
                          href={
                            lease === undefined || unavailable
                              ? `/${language}/siampark/properties?resourceId=${unit.unitRef.resourceId}`
                              : `/${language}/siampark/occupancy?resourceId=${lease.occupancyRef.resourceId}`
                          }
                          title={`${unit.code} · ${day} · ${detail}`}
                        >
                          {unavailable ? '—' : lease?.state === 'ACTIVE' ? 'O' : lease === undefined ? '·' : 'R'}
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
