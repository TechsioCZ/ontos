// expect-count: 5
// Field bags hidden in class bodies, nested arrows, async generators, JSX components and a
// `TaggedError` factory must all still be walked.
import { Schema } from 'effect';

export class Contracts {
  // 1 a class static member
  static readonly row = Schema.Struct({ createdAt: Schema.String, id: Schema.String });

  build(): unknown {
    // 2 a nested arrow body inside a class method
    const make = () => () => Schema.Struct({ archivedAt: Schema.NullOr(Schema.String) });
    return make()();
  }
}

// 3 inside an async generator
export async function* stream(): AsyncGenerator<unknown> {
  yield Schema.Struct({ emittedAt: Schema.Trim });
}

// 4 inside a JSX component body
export function Panel() {
  const schema = Schema.Struct({ renderedAt: Schema.String });
  return <section data-schema={String(schema)}>ok</section>;
}

// 5 a curried `TaggedError` field bag
export const ContactFailure = Schema.TaggedError<Error>()('ContactFailure', {
  occurredAt: Schema.NonEmptyString,
  detail: Schema.String,
});
