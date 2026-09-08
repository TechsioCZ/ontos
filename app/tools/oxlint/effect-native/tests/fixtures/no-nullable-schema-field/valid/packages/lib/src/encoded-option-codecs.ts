import { Schema, SchemaGetter, Option, pipe } from "effect";
import { NullOr as Nullable, decodeTo as into, Option as OptionSchema } from "effect/Schema";

const mapping = {
  decode: SchemaGetter.transform(Option.fromNullishOr),
  encode: SchemaGetter.transform(Option.getOrNull),
};
// Null is an encoded-side representation; the model already decodes to Option.
export const direct = Schema.NullOr(Schema.String).pipe(Schema.decodeTo(Schema.Option(Schema.String), mapping));
export const annotated = Schema.NullOr(Schema.String).annotate({ title: "wire" }).pipe(Schema.decodeTo(Schema.OptionFromNullOr(Schema.String)));
export const named = Nullable(Schema.String).pipe(into(OptionSchema(Schema.String), mapping));
export const curried = into(OptionSchema(Schema.String), mapping)(Nullable(Schema.String));
export const functional = pipe(Schema.NullOr(Schema.String), Schema.decodeTo(Schema.Option(Schema.String), mapping));
export const inverse = Schema.Option(Schema.String).pipe(Schema.encodeTo(Schema.NullOr(Schema.String), mapping));
const encoded = Schema.NullOr(Schema.String);
export const shared = encoded.pipe(Schema.decodeTo(Schema.Option(Schema.String), mapping));
// optional may be encoded as an omitted key rather than null: this is deliberately codec-owned.
export const optional = Schema.optional(Schema.NullOr(Schema.String)).pipe(Schema.decodeTo(Schema.OptionFromOptionalNullOr(Schema.String)));
