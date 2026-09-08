// expect-count: 2
// `effect/Schema` exports every combinator by name, so the `Schema.` prefix is optional.
import { NullishOr, NullOr, String as Str, Struct } from 'effect/Schema';

export const ContactSchema = Struct({
  archivedAt: NullOr(Str),
  deletedAt: NullishOr(Str),
});
