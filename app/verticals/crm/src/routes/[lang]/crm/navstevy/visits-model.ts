// AREA: visits — owned by the crm-visits lane. Pure presentation helpers shared by the visits and plan pages
// and the client card tab. Times are shown and typed in Prague time; the server stores ISO instants.
import { DateTime, Option } from 'effect';
import type { RecordsResponse } from '../../../../../shared/apis/records.ts';
import type { PlanItem, Visit, VisitKind } from '../../../../../shared/domain/visits.ts';

const pragueTimeZone = 'Europe/Prague';
export const pragueZone = DateTime.zoneMakeNamedUnsafe(pragueTimeZone);

export const visitKindMeta = {
  call: { icon: 'icon-[mdi--phone-outline]', label: 'Telefonát', tone: 'bg-info-light text-info' },
  email: { icon: 'icon-[mdi--email-outline]', label: 'E-mail', tone: 'bg-secondary-light text-fg-secondary' },
  video: { icon: 'icon-[mdi--video-outline]', label: 'Videohovor', tone: 'bg-warning-light text-warning' },
  visit: { icon: 'icon-[mdi--handshake-outline]', label: 'Osobní návštěva', tone: 'bg-success-light text-success' },
} satisfies Record<VisitKind, { readonly icon: string; readonly label: string; readonly tone: string }>;

const pad = (value: number) => String(value).padStart(2, '0');

const zoned = (iso: DateTime.Utc) => Option.map(DateTime.make(iso), (value) => DateTime.setZone(value, pragueZone));

/** ISO instant → { date: 'YYYY-MM-DD', time: 'HH:MM' } in Prague time (for form inputs). */
export const localInputs = (iso: DateTime.Utc) =>
  Option.match(zoned(iso), {
    onNone: () => ({ date: '', time: '' }),
    onSome: (value) => {
      const parts = DateTime.toParts(value);
      return {
        date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
        time: `${pad(parts.hour)}:${pad(parts.minute)}`,
      };
    },
  });

/** Prague-local date + time inputs → ISO instant, or undefined when incomplete. */
export const isoFromLocal = (date: string, time: string): string | undefined => {
  const dateMatch = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u.exec(date);
  const timeMatch = /^(?<hour>\d{2}):(?<minute>\d{2})$/u.exec(time === '' ? '00:00' : time);
  if (dateMatch === null || timeMatch === null) {
    return undefined;
  }
  return Option.getOrUndefined(
    Option.map(
      DateTime.makeZoned(
        {
          day: Number(dateMatch[3]),
          hour: Number(timeMatch[1]),
          minute: Number(timeMatch[2]),
          month: Number(dateMatch[2]),
          year: Number(dateMatch[1]),
        },
        { adjustForTimeZone: true, timeZone: pragueZone },
      ),
      (value) => DateTime.formatIso(DateTime.toUtc(value)),
    ),
  );
};

/** Prague calendar day of an ISO instant (YYYY-MM-DD). */
export const localDay = (iso: DateTime.Utc) => localInputs(iso).date;

/** Calendar day shifted by whole days (YYYY-MM-DD in, YYYY-MM-DD out). */
export const shiftDay = (day: string, days: number) =>
  Option.getOrElse(
    Option.map(DateTime.make(`${day}T12:00:00.000Z`), (value) => DateTime.formatIsoDate(DateTime.add(value, { days }))),
    () => day,
  );

/** Whole days from `fromDay` to `toDay` (both YYYY-MM-DD). */
export const daysBetween = (fromDay: string, toDay: string) => {
  const from = DateTime.make(`${fromDay}T12:00:00.000Z`);
  const to = DateTime.make(`${toDay}T12:00:00.000Z`);
  return Option.isSome(from) && Option.isSome(to)
    ? Math.round((DateTime.toEpochMillis(to.value) - DateTime.toEpochMillis(from.value)) / 86_400_000)
    : 0;
};

const weekdayFormat = new Intl.DateTimeFormat('cs-CZ', { timeZone: pragueTimeZone, weekday: 'long' });
const dayFormat = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  timeZone: pragueTimeZone,
  year: 'numeric',
});
const shortDayFormat = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric',
  month: 'numeric',
  timeZone: pragueTimeZone,
});
const timeFormat = new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: pragueTimeZone });
const monthFormat = new Intl.DateTimeFormat('cs-CZ', { month: 'long', timeZone: pragueTimeZone, year: 'numeric' });

const epoch = (iso: DateTime.Utc) => Option.getOrUndefined(Option.map(DateTime.make(iso), DateTime.toEpochMillis));
const dayEpoch = (day: string) =>
  Option.getOrUndefined(Option.map(DateTime.make(`${day}T12:00:00.000Z`), DateTime.toEpochMillis));

const fmt = (format: Intl.DateTimeFormat, ms: number | undefined) => (ms === undefined ? '—' : format.format(ms));

/** `20. 10. 2026 9:30` */
export const formatVisitTime = (iso: DateTime.Utc) => `${fmt(dayFormat, epoch(iso))} ${fmt(timeFormat, epoch(iso))}`;
export const formatVisitDay = (iso: DateTime.Utc) => fmt(dayFormat, epoch(iso));
export const formatClock = (iso: DateTime.Utc) => fmt(timeFormat, epoch(iso));
/** `20. 10. 2026` for a calendar day. */
export const formatDay = (day: string) => fmt(dayFormat, dayEpoch(day));
export const formatShortDay = (day: string) => fmt(shortDayFormat, dayEpoch(day));
export const formatWeekday = (day: string) => fmt(weekdayFormat, dayEpoch(day));
/** `říjen 2026` — month heading of the timeline. */
export const formatMonth = (iso: DateTime.Utc) => fmt(monthFormat, epoch(iso));

/** "dnes", "včera", "před 5 dny", "za 3 dny" relative to the server's today. */
export const relativeDay = (day: string, today: string) => {
  const diff = daysBetween(today, day);
  if (diff === 0) {
    return 'dnes';
  }
  if (diff === -1) {
    return 'včera';
  }
  if (diff === 1) {
    return 'zítra';
  }
  if (diff < 0) {
    return `před ${-diff} dny`;
  }
  return diff < 5 ? `za ${diff} dny` : `za ${diff} dní`;
};

/** Author of a record: the salesperson linked to the principal, "Vy", or the lead / admin. */
export const principalLabel = (records: RecordsResponse, principalId: string) => {
  const person = records.state.salespeople.find((entry) => entry.principalId === principalId);
  if (person !== undefined) {
    return principalId === records.viewer.principalId ? `${person.name} (vy)` : person.name;
  }
  return principalId === records.viewer.principalId ? 'Vy' : 'Vedení obchodu';
};

export const salespersonLabel = (records: RecordsResponse, id: string | undefined) =>
  id === undefined
    ? 'Bez obchodníka'
    : (records.state.salespeople.find((person) => person.id === id)?.name ?? 'Neznámý obchodník');

export const clientLabel = (records: RecordsResponse, id: string) =>
  records.state.clients.items.find((client) => client.id === id)?.name ?? 'Neznámý klient';

/** Clients the viewer may write (the server checks again). */
export const writableClients = (records: RecordsResponse) =>
  records.state.clients.items.filter(
    (client) =>
      client.status === 'active' &&
      (records.viewer.writeAll ||
        (records.viewer.writeAssigned &&
          records.viewer.salespersonId !== undefined &&
          client.ownerSalespersonId === records.viewer.salespersonId)),
  );

export const canWriteVisits = (records: RecordsResponse) => records.viewer.writeAll || records.viewer.writeAssigned;

export const sortVisitsDesc = (visits: readonly Visit[]) =>
  visits.toSorted((left, right) => DateTime.Order(right.occurredAt, left.occurredAt));

export const sortPlanAsc = (plan: readonly PlanItem[]) =>
  plan.toSorted(
    (left, right) => left.dueDate.localeCompare(right.dueDate) || DateTime.Order(left.createdAt, right.createdAt),
  );

/** Visits grouped by Prague month, newest month first. */
export const groupByMonth = (visits: readonly Visit[]) => {
  const groups: { key: string; label: string; visits: Visit[] }[] = [];
  for (const visit of sortVisitsDesc(visits)) {
    const key = localDay(visit.occurredAt).slice(0, 7);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.visits.push(visit);
    } else {
      groups.push({ key, label: formatMonth(visit.occurredAt), visits: [visit] });
    }
  }
  return groups;
};

/** Search haystack of a visit (client, result, note, next step, author). */
export const visitSearchText = (records: RecordsResponse, visit: Visit) =>
  [
    clientLabel(records, visit.clientId),
    visit.result,
    visit.note,
    visit.nextStep,
    salespersonLabel(records, visit.salespersonId),
    visitKindMeta[visit.kind].label,
  ]
    .filter((value) => value !== undefined)
    .join(' ');

/** Server reasons are Czech for domain errors; generic HTTP problem titles arrive in English, so translate them. */
export const czechError = (message: string | undefined, fallback: string) => {
  if (message === undefined || message === '') {
    return fallback;
  }
  if (/[áčďéěíňóřšťúůýž]/iu.test(message)) {
    return message;
  }
  const lower = message.toLowerCase();
  if (lower.includes('not found')) {
    return 'Klient neexistuje nebo k němu nemáte přístup.';
  }
  if (lower.includes('forbidden') || lower.includes('denied') || lower.includes('permission')) {
    return 'K této operaci nemáte oprávnění.';
  }
  if (lower.includes('conflict') || lower.includes('revision')) {
    return 'Data se mezitím změnila. Zkuste to prosím znovu.';
  }
  return fallback;
};
