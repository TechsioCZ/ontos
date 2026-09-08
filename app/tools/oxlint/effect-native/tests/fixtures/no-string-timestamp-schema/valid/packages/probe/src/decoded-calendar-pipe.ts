import { Schema, SchemaGetter, DateTime } from "effect";
// check is only a wire validation step; decodeTo makes the decoded value temporal.
export const calendar = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIsoDate),
  }),
);
