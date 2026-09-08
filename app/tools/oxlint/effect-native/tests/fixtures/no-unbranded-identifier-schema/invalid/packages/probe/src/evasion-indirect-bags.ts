// expect-count: 6
import { HttpApiSchema, Schema } from 'effect';

// 1 — a plain object const handed straight to `Schema.Struct` (name does not end in `Fields`).
const shape = { tenantId: Schema.String, label: Schema.String };
export const RowSchema = Schema.Struct(shape);

// 2 — shorthand property whose value resolves to an in-file string leaf.
const contactId = Schema.String;
export const ContactSchema = Schema.Struct({ contactId, name: Schema.String });

// 3 — nested transparent wrappers; a plural collection of identifiers counts too.
export const TagsSchema = Schema.Struct({
  ownerId: Schema.mutable(Schema.NullOr(Schema.String)),
  memberIds: Schema.Array(Schema.String),
  count: Schema.Number,
});

// 4 — a `satisfies`-wrapped field bag passed to a TaggedError.
const errorShape = { invocationId: Schema.String, detail: Schema.String } satisfies Record<string, unknown>;
export class InvocationFailed extends Schema.TaggedError<InvocationFailed>()(
  'InvocationFailed',
  errorShape,
  HttpApiSchema.annotations({ status: 500 }),
) {}

// 5 — default-exported contract.
export default Schema.Struct({ customerId: Schema.NonEmptyString });
