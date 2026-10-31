import { DateTime, Result, Schema, SchemaGetter } from 'effect';

const TimestampSchema = Schema.String.pipe(Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
  decode: SchemaGetter.transform((_value: string) => () => 'executable'),
  encode: SchemaGetter.transform(DateTime.formatIso),
}));
export const makeDecodedEvidence = (value: string) => Result.getOrThrow(
  Schema.decodeUnknownResult(TimestampSchema)(value),
);
