import { Schema, SchemaGetter, DateTime, pipe } from "effect";
const mapping = {
  decode: SchemaGetter.transform(DateTime.makeUnsafe),
  encode: SchemaGetter.transform(DateTime.formatIso),
};
export const Event = Schema.Struct({
  createdAt: Schema.String.pipe(Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), mapping)),
  updatedAt: pipe(Schema.String, Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), mapping)),
});
// A real codec can validate its wire format before decoding; preserve that pipeline.
export const dateOnly = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)).pipe(Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), mapping));
export interface CursorSettings { cursorAfter: string; sortOn: string; displayTime: string; webhookUrlOn: string }
type Iso = string;
export namespace Local { type Iso = Date; export interface Row { createdAt: Iso } }
// Scope resolution must not borrow the outer string alias for a type parameter either.
export interface Generic<Iso> { createdAt: Iso }
