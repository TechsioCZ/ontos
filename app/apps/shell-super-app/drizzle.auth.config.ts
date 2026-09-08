import { defineWorkspaceDrizzleConfig } from '../../packages/core-runtime/src/environment/drizzle-config.ts';

export default defineWorkspaceDrizzleConfig({
  out: './drizzle-auth',
  schema: './api/auth/db/schema.ts',
  table: '__drizzle_migrations_auth',
});
