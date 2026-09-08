import { DateTime, Option, Schema, SchemaGetter } from 'effect';

export const CanonicalUtcTimestampJsonSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    const canonicalInput =
      value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
    return Option.isSome(parsed) &&
      DateTime.formatIso(parsed.value) === canonicalInput
      ? undefined
      : 'invalid UTC calendar timestamp';
  })
).pipe(
  Schema.decode({
    decode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
    encode: SchemaGetter.dateTimeUtcFromInput<string>().map(DateTime.formatIso),
  })
);
