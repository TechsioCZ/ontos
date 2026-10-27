import { DateTime, Effect, Result, Schema, SchemaGetter } from 'effect';

const TimestampSchema = Schema.String.pipe(Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
  decode: SchemaGetter.transform((value) => {
    Effect.runSync(Effect.sync(() => globalThis.console.log(value)));
    return DateTime.makeUnsafe(value);
  }),
  encode: SchemaGetter.transform(DateTime.formatIso),
}));
export const makeDecodedEvidence = (value: string) => Result.getOrThrow(
  Schema.decodeUnknownResult(TimestampSchema)(value),
);
