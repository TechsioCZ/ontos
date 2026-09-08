// expect-count: 4
import * as Effect from 'effect';
import * as Schema from 'effect/Schema';

// The namespace is destructured, so no `Schema.` prefix is ever written.
const { Struct, String: Str, optional } = Schema;
const { Record: SchemaRecord } = Effect.Schema;

// 1 + 2 — destructured constructor, destructured leaf, destructured wrapper.
export const RowSchema = Struct({
  tenantId: Str,
  legalEntityId: optional(Str),
  label: Str,
});

// 3 — destructured `Schema.Record` still defines a field bag.
export const LookupSchema = SchemaRecord({ moduleKey: Str, value: Str });

// 4 — shared identifier schema built from the destructured leaf.
export const DeploymentIdSchema = Str.check(Schema.isUUID());
