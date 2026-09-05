// expect-count: 2
import { String as SchemaString, Struct } from 'effect/Schema';

// 1 — the field-bag constructor is imported directly, never accessed as `Schema.Struct`.
export const RowSchema = Struct({
  tenantId: SchemaString,
  label: SchemaString,
});

// 2 — shared identifier schema built from the directly-imported leaf.
export const PrincipalIdSchema = SchemaString.annotate({ identifier: 'PrincipalId' });
