// `Schema` and `Struct` here come from a different library, not from `effect`.
import { Schema, Struct } from '@sinclair/typebox';

export const RowSchema = Schema.Struct({
  tenantId: Schema.String,
  principalId: Schema.String.check(Schema.isUUID()),
});

export const OtherSchema = Struct({ moduleId: Schema.String });

export const TenantIdSchema = Schema.String;
