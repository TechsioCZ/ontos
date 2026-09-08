// expect-count: 7
import { pipe, Schema } from 'effect';

const archivedAt = Schema?.NullOr(Schema.String);
const deletedAt = (Schema.NullOr as (value: unknown) => unknown)(Schema.String);
const annotated = Schema.NullOr(Schema.String).annotations({ title: 'x' });
const cursor = pipe(Schema.String, Schema.UndefinedOr);
const legacy = Schema.String.pipe(Schema.NullOr);
const make = () => Schema.NullishOr(Schema.Finite);

class Row {
  static readonly nickname = Schema.NullOr(Schema.String);
}

export function Page() {
  return <pre>{JSON.stringify([archivedAt, deletedAt, annotated, cursor, legacy, make, Row])}</pre>;
}
