import { Schema } from 'effect';

// Mutually referential consts must not make the rule recurse for ever.
const first: unknown = second;
const second: unknown = first;

export const RowSchema = Schema.Struct({
  tenantId: first,
  principalId: second,
  attemptId: Schema.Number,
});

// A self-referential suspend is not a string leaf.
export const TreeSchema = Schema.Struct({
  nodeId: Schema.suspend(() => TreeSchema),
});
