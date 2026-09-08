// expect-count: 3
import { pipe } from 'effect/Function';
import * as Schema from 'effect/Schema';

const described = <A,>(schema: A): A => schema;

// 1 — point-free `pipe` with no brand argument.
export const CustomerIdSchema = pipe(Schema.String, described);

// 2 — `pipe` nested two deep.
export const ActionIdSchema = pipe(pipe(Schema.NonEmptyString, described), described);

// 3 — field value built point-free.
export const RowSchema = Schema.Struct({
  contactId: pipe(Schema.String, described),
  label: Schema.String,
});
