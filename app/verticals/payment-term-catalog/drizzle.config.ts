import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle',
  schema: './src/database/schema.ts',
  table: '__drizzle_migrations_payment_term_catalog',
});
