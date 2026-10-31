import { expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { CalendarDateSchema, CalendarDateWireSchema } from '../../src/calendar-date.ts';

it.effect('round-trips a calendar day without adding time or timezone to the wire', () =>
  Effect.gen(function* calendarDayRoundTrip() {
    const value = yield* Schema.decodeEffect(CalendarDateSchema)('2028-02-29');
    expect(value).toBe('2028-02-29');
    expect(yield* Schema.encodeEffect(CalendarDateSchema)(value)).toBe('2028-02-29');
    expect(yield* Schema.decodeEffect(CalendarDateWireSchema)('2028-02-29')).toBe('2028-02-29');
  }),
);

it.effect('rejects impossible dates, timestamps and noncanonical day forms', () =>
  Effect.gen(function* invalidCalendarDays() {
    for (const input of ['2026-02-29', '2026-02-31', '2026-13-01', '2026-2-01', '2026-10-05T00:00:00Z']) {
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(CalendarDateSchema)(input)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(CalendarDateWireSchema)(input)))).toBe(true);
    }
  }),
);
