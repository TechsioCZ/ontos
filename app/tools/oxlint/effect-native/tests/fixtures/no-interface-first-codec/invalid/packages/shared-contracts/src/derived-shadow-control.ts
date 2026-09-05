// expect-count: 3
import { Schema } from "effect";
const Source = Schema.Struct({ name: Schema.String });
type Contact = typeof Source.Type;
export function shadow() {
  interface Contact { name: string }
  const contact: Schema.Codec<Contact> = Source;
  return contact;
}
type Mixed = { readonly name: typeof Source.Type.name; readonly extra: string };
export const mixed: Schema.Codec<Mixed> = Schema.Struct({ name: Schema.String, extra: Schema.String });
export function unrelated<A>(input: A) { return input; }
interface A { readonly name: string }
export const prior: Schema.Codec<A> = Source;
