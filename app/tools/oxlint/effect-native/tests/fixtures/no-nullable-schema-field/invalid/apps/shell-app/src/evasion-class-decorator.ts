// expect-count: 5
import { Schema } from 'effect';

export class ContactDto extends Schema.Class<ContactDto>('ContactDto')({
  archivedAt: Schema.NullOr(Schema.String),
}) {}

export const cursor = Schema.UndefinedOr(Schema.String) satisfies object;

export async function* rows() {
  yield Schema.NullOr(Schema.Finite);
}

export const factory = {
  build: () => Schema.NullishOr(Schema.String)!,
};

function register(_schema: unknown) {
  return (target: unknown) => target as never;
}

@register(Schema.NullOr(Schema.String))
export class Row {}
