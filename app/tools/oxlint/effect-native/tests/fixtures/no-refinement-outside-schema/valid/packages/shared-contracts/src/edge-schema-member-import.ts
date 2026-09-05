// False-positive probe: bare member imports of the narrowing functions themselves
// (`import { is, asserts } from "effect/Schema"`). The whole body is still a single delegating call to
// the owning Schema — the same shape the rule already blesses for `import { isString } from
// "effect/Predicate"` and for `Schema.is(S)(x)` — so there is no second validation authority here.
import { Schema } from 'effect';
import { asserts, is } from 'effect/Schema';

export const ContactSchema = Schema.Struct({ id: Schema.String });
export type Contact = typeof ContactSchema.Type;

export const isContact = (value: unknown): value is Contact => is(ContactSchema)(value);

export const assertContact = (value: unknown): asserts value is Contact => {
  asserts(ContactSchema)(value);
};
