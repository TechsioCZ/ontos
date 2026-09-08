import { Schema } from "effect";

const ContactSchema = Schema.Struct({ name: Schema.String });
type Contact = typeof ContactSchema.Type;
type ContactAlias = Contact;
type Decoded = Schema.Schema.Type<typeof ContactSchema>;
export const contact: Schema.Codec<Contact> = ContactSchema;
export const alias: Schema.Codec<ContactAlias> = ContactSchema;
export const decoded: Schema.Codec<Decoded> = ContactSchema;

export function wrap<A>(inner: Schema.Codec<A>) {
  const wrapped: Schema.Codec<A> = inner;
  return wrapped;
}
export class Registry<A> {
  clone(inner: Schema.Codec<A>) {
    const copied: Schema.Codec<A> = inner;
    return copied;
  }
}
// Required annotations, not schema constructions competing with interfaces.
declare const externalSchema: Schema.Codec<{ readonly id: string }>;
let lazySchema: Schema.Codec<{ readonly id: string }>;
export { externalSchema, lazySchema };

// Derived aliases must resolve in their own lexical scope, including forward references.
export function local() {
  const value: Schema.Codec<Later> = ContactSchema;
  type Later = typeof ContactSchema.Type;
  return value;
}
