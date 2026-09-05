// expect-count: 3
import * as Effect from 'effect';
import { pipe } from 'effect';
import * as Sch from 'effect/Schema';

const refine = <A,>(schema: A): A => schema;

// 1 — root barrel namespace import: `Effect.Schema.Struct`.
export const ViewSchema = Effect.Schema.Struct({
  componentKey: Effect.Schema.String,
  label: Effect.Schema.String,
});

// 2 — submodule namespace import + computed member access.
export const RowSchema = Sch['Struct']({
  resourceId: Sch.String,
  count: Sch.Number,
});

// 3 — `pipe(...)` without a brand argument is still an unbranded string.
export const KeySchema = Sch.Struct({
  groupKey: pipe(Sch.String, refine),
});

export const View = (): unknown => <span>{String(ViewSchema)}</span>;
