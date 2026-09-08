import { Schema } from "effect";
const Document = Schema.Struct({ name: Schema.String });
export const outer = Schema.decodeUnknownEffect(Document);
export function local() {
  const Document = Schema.Struct({ payload: Schema.Json });
  return Schema.decodeUnknownEffect(Document);
}
export function foreign(Schema: { decodeUnknownEffect(s: unknown): unknown; Json: unknown }) {
  return Schema.decodeUnknownEffect(Schema.Json);
}
export const hoisted = { payload: Schema.Record(Schema.String, Schema.Json) };
export const envelope = Schema.Struct(hoisted);
