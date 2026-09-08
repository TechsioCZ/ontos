// expect-count: 4
import { Schema } from 'effect';

// 1: shared identifier schema declared unbranded (every consumer inherits the problem).
const TenantIdSchema = Schema.String.check(Schema.isUUID());
// 2
export const ContactsIcoSchema = Schema.String.check(Schema.isPattern(/^\d{8}$/u));
// 3: name matches the schema-name pattern through an optionalKey wrapper.
export const stableEntrypointKeySchema = Schema.optionalKey(Schema.NonEmptyString);

// Consumers of an already-reported in-file schema are NOT reported again.
export const SessionSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  selectedTenantId: TenantIdSchema,
  ico: ContactsIcoSchema,
});

// 4: a local `const uuid` is not named like a schema, so the field itself is reported.
const uuid = Schema.String.check(Schema.isUUID());
export const CheckpointSchema = Schema.Struct({
  targetPrincipalId: uuid,
  reason: Schema.String,
});
