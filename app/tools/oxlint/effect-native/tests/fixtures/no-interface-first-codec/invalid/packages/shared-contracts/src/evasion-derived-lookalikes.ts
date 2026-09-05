// expect-count: 3
import { Schema } from "effect";
const ContactSchema = Schema.Struct({ name: Schema.String });
type Contact = typeof ContactSchema.Type;
// An inner same-name interface is not the schema-derived outer alias.
export function shadow() {
  interface Contact { name: string }
  const schema: Schema.Codec<Contact> = Schema.Struct({ name: Schema.String });
  return schema;
}
// A hand-written property with `typeof` is not a derived type.
type Manual = { name: typeof sample };
const sample = "name";
export const manual: Schema.Codec<Manual> = Schema.Struct({ name: Schema.String });
// A generic elsewhere cannot make an unrelated interface a type parameter.
interface A { id: string }
function unused<A>(a: A) { return a; }
export const prior: Schema.Codec<A> = Schema.Struct({ id: Schema.String });
