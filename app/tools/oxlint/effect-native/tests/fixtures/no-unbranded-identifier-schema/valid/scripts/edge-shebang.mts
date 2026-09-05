#!/usr/bin/env node
import * as Schema from 'effect/Schema';

// Shebang + top-level await + branded identifiers: parses, and reports nothing.
export const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));

const RowSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  label: Schema.String,
});

export const decoded = await Promise.resolve(RowSchema);
