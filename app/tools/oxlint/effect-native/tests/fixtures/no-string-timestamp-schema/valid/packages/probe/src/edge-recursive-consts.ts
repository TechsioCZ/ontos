import { Schema } from 'effect';

// Mutually referential and self-referential declarations must terminate, not hang or report.
const first: unknown = second;
const second: unknown = first;

export const RowSchema = Schema.Struct({
  createdAt: first as never,
  updatedAt: second as never,
});

const selfPattern: RegExp = selfPattern;
export const OddSchema = Schema.String.check(Schema.isPattern(selfPattern));

// Deeply parenthesised / cast chains must not blow the unwrap guard either.
export const DeepSchema = Schema.Struct({
  settledAt: ((((Schema.DateTimeUtc as unknown) as never) as unknown) as never),
});
