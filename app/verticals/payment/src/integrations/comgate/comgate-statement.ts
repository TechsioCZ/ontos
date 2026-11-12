import { DateTime, Option } from 'effect';

/**
 * Europe/Prague calendar arithmetic of the Comgate settlement statements (#1156, plan D-P2). Comgate
 * interprets the `transferList` date and every statement date in the Europe/Prague zone (CET/CEST,
 * https://apidoc.comgate.cz/en/api/rest/ transferList and singleTransfer). Calendar days are counted on
 * UTC-midnight values of the Prague date, so a DST change never shifts a day.
 */

const PRAGUE_TIME_ZONE = 'Europe/Prague';

/** The newest date a lookup reads is yesterday in Prague: a transfer becomes readable the next morning. */
const DAYS_UNTIL_READABLE = 1;

/**
 * At most this many statement dates per lookup: the dispatch date and the 23 days after it. Enough for
 * the documented 14 working days a queued refund may wait for funds, plus the next-morning statement.
 */
export const COMGATE_STATEMENT_MAX_DATES = 24;

const LOCAL_TIME_PATTERN =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2}) (?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})$/u;

/** The Prague calendar date of an instant, as UTC midnight of that date. */
const pragueDateOf = (instant: DateTime.Utc): Option.Option<DateTime.Utc> =>
  Option.flatMap(DateTime.makeZoned(instant, { timeZone: PRAGUE_TIME_ZONE }), (zoned) => {
    const { day, month, year } = DateTime.toParts(zoned);
    return DateTime.make({ day, hour: 0, millisecond: 0, minute: 0, month, second: 0, year }).pipe(
      Option.map(DateTime.toUtc),
    );
  });

/**
 * The Prague dates (`YYYY-MM-DD`) whose transfers a refund lookup reads: from the Prague date of the
 * dispatch to the earlier of yesterday in Prague and the dispatch date + 23 days. Empty while the
 * dispatch date's statement cannot exist yet. `None` only when the Prague zone cannot be resolved.
 */
export const comgateStatementDates = (
  dispatchedAt: DateTime.Utc,
  now: DateTime.Utc,
): Option.Option<readonly string[]> =>
  Option.all([pragueDateOf(dispatchedAt), pragueDateOf(now)]).pipe(
    Option.map(([first, today]) => {
      const yesterday = DateTime.subtract(today, { days: DAYS_UNTIL_READABLE });
      const bound = DateTime.add(first, { days: COMGATE_STATEMENT_MAX_DATES - 1 });
      const last = DateTime.min(yesterday, bound);
      const dates: string[] = [];
      for (
        let date = first;
        DateTime.isLessThanOrEqualTo(date, last) && dates.length < COMGATE_STATEMENT_MAX_DATES;
        date = DateTime.add(date, { days: 1 })
      ) {
        dates.push(DateTime.formatIsoDateUtc(date));
      }
      return dates;
    }),
  );

/** A Prague wall-clock reading of a statement row, already split into its calendar fields. */
export interface ComgatePragueWallClock {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly month: number;
  readonly second: number;
  readonly year: number;
}

/**
 * The calendar fields of a statement time `YYYY-MM-DD HH:mm:ss`. `None` when the text is not that
 * shape or names no real calendar time (month 13, 30 February, 24:00): such a row is unreadable.
 */
export const parseComgatePragueWallClock = (text: string): Option.Option<ComgatePragueWallClock> => {
  const groups = LOCAL_TIME_PATTERN.exec(text)?.groups;
  if (groups === undefined) {
    return Option.none();
  }
  const fields: ComgatePragueWallClock = {
    day: Number(groups['day']),
    hour: Number(groups['hour']),
    minute: Number(groups['minute']),
    month: Number(groups['month']),
    second: Number(groups['second']),
    year: Number(groups['year']),
  };
  return DateTime.make({ ...fields, millisecond: 0 }).pipe(
    Option.filter((asUtc) => {
      const parts = DateTime.toPartsUtc(asUtc);
      return (
        parts.year === fields.year &&
        parts.month === fields.month &&
        parts.day === fields.day &&
        parts.hour === fields.hour &&
        parts.minute === fields.minute &&
        parts.second === fields.second
      );
    }),
    Option.as(fields),
  );
};

/**
 * The instant of a Prague wall-clock time. `None` for a time that does not exist or occurs twice
 * around a DST change: OntOS then states no provider instant rather than guessing one.
 */
export const pragueWallClockToUtc = (wallClock: ComgatePragueWallClock): Option.Option<DateTime.Utc> =>
  DateTime.makeZoned(
    { ...wallClock, millisecond: 0 },
    { adjustForTimeZone: true, disambiguation: 'reject', timeZone: PRAGUE_TIME_ZONE },
  ).pipe(Option.map(DateTime.toUtc));
