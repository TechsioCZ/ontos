import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle-contacts',
  schema: './src/db/engagement-schema.ts',
  table: '__drizzle_migrations_contacts',
});
