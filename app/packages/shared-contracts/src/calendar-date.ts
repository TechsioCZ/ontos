import { DateTime, Option, Schema, SchemaTransformation } from 'effect';

/** Calendar dates are days, without a timezone or time of day. */
const calendarDateInput = Schema.String.check(
  Schema.makeFilter((value) => {
    if (value.length !== 10) {
      return false;
    }
    const parsed = DateTime.make(`${value}T00:00:00.000Z`);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value).slice(0, 10) === value;
  }),
);

/** Native temporal parsing with an exact date-only wire representation. */
export const CalendarDateSchema = calendarDateInput.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: (value) => DateTime.makeUnsafe(`${value}T00:00:00.000Z`),
      encode: (value) => DateTime.formatIso(value).slice(0, 10),
    }),
  ),
  Schema.decodeTo(
    calendarDateInput.pipe(Schema.brand('CalendarDate')),
    SchemaTransformation.transform({
      decode: (value) => DateTime.formatIso(value).slice(0, 10),
      encode: (value) => DateTime.makeUnsafe(`${value}T00:00:00.000Z`),
    }),
  ),
);

export const CalendarDateWireSchema = Schema.toEncoded(CalendarDateSchema);
