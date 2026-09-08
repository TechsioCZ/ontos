import { Schema } from 'effect';

import { TenantIdSchema } from '../../../packages/lib/src/branded.ts';

// Tests are in scope by default; branded contracts stay clean there too.
export const FixtureSchema = Schema.Struct({
  tenantId: TenantIdSchema,
  label: Schema.String,
});
